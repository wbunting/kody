/**
 * Self-hosted git backend for Kody Artifacts.
 *
 * Replaces Cloudflare Artifacts' git object store for self-hosted installs:
 * - Bare repos live under KODY_GIT_ROOT/<namespace>/<repo>.git
 * - Smart HTTP (clone/fetch/push) is served by `git http-backend`
 * - Repo access uses HMAC-signed, expiring, per-repo tokens
 *   (`kgt1.<payload>.<sig>?expires=<unix>`), the same shape Artifacts uses
 * - An internal API (Bearer KODY_GIT_INTERNAL_TOKEN) lets the Cloudflare API
 *   stand-in create/fork repos, mint tokens, and read/write whole-tree
 *   snapshots as real commits.
 *
 * Run: node --env-file=packages/worker/.env tools/selfhost-git-server.ts
 */
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
	shouldStoreArtifactBlobAsLatin1,
	snapshotStringToBytes,
	bytesToLatin1String,
} from '../packages/worker/universal/package-file-media.ts'

const port = Number.parseInt(process.env.KODY_GIT_PORT ?? '9029', 10)
const host = process.env.KODY_GIT_HOST ?? '127.0.0.1'
const gitRoot = path.resolve(
	process.env.KODY_GIT_ROOT ??
		path.join(os.homedir(), '.local/share/kody-selfhost/git'),
)
const internalToken = (
	process.env.KODY_GIT_INTERNAL_TOKEN ??
	process.env.KODY_CLOUDFLARE_MOCK_TOKEN ??
	''
).trim()
const signingKey = (process.env.KODY_GIT_SIGNING_KEY ?? internalToken).trim()
const commitAuthorName = process.env.KODY_GIT_AUTHOR_NAME ?? 'Kody'
const commitAuthorEmail = process.env.KODY_GIT_AUTHOR_EMAIL ?? 'kody@localhost'

if (!internalToken || !signingKey) {
	console.error(
		'selfhost-git: KODY_GIT_INTERNAL_TOKEN (or KODY_CLOUDFLARE_MOCK_TOKEN) is required.',
	)
	process.exit(1)
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

function assertName(value: unknown, label: string): string {
	if (
		typeof value !== 'string' ||
		!namePattern.test(value) ||
		value.includes('..')
	) {
		throw new HttpError(400, `invalid ${label}`)
	}
	return value
}

class HttpError extends Error {
	status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

function repoDir(namespace: string, name: string) {
	return path.join(gitRoot, namespace, `${name}.git`)
}

async function git(
	cwd: string,
	args: Array<string>,
	options: { input?: Buffer | string; env?: Record<string, string> } = {},
): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const hasInput = options.input !== undefined
		const child = spawn('git', args, {
			cwd,
			env: { ...process.env, ...options.env },
			stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		})
		const out: Array<Buffer> = []
		const err: Array<Buffer> = []
		child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
		child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolve(Buffer.concat(out))
			else
				reject(
					new Error(
						`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString().trim()}`,
					),
				)
		})
		if (hasInput && child.stdin) {
			// git may exit before draining stdin; surface that via `close`.
			child.stdin.on('error', () => {})
			child.stdin.end(options.input)
		}
	})
}

// ---- per-repo serialization -------------------------------------------------

const locks = new Map<string, Promise<unknown>>()
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = locks.get(key) ?? Promise.resolve()
	const next = prior.catch(() => {}).then(fn)
	locks.set(key, next)
	try {
		return await next
	} finally {
		if (locks.get(key) === next) locks.delete(key)
	}
}

// ---- tokens -----------------------------------------------------------------

type TokenPayload = {
	n: string
	r: string
	s: 'read' | 'write'
	e: number
	i: string
}

function b64url(input: Buffer | string) {
	return Buffer.from(input).toString('base64url')
}

function sign(data: string) {
	return createHmac('sha256', signingKey).update(data).digest('base64url')
}

function mintToken(input: {
	namespace: string
	repo: string
	scope: 'read' | 'write'
	ttlSeconds: number
}) {
	const expiresAt =
		Math.floor(Date.now() / 1000) + Math.max(1, input.ttlSeconds)
	const id = `tok_${randomUUID()}`
	const payload: TokenPayload = {
		n: input.namespace,
		r: input.repo,
		s: input.scope,
		e: expiresAt,
		i: id,
	}
	const body = `kgt1.${b64url(JSON.stringify(payload))}`
	const secret = `${body}.${sign(body)}`
	return {
		id,
		plaintext: `${secret}?expires=${expiresAt}`,
		scope: input.scope,
		expires_at: new Date(expiresAt * 1000).toISOString(),
	}
}

function verifyToken(raw: string | null): TokenPayload | null {
	if (!raw) return null
	const secret = raw.split('?expires=')[0] ?? raw
	const parts = secret.split('.')
	if (parts.length !== 3 || parts[0] !== 'kgt1') return null
	const body = `${parts[0]}.${parts[1]}`
	const expected = Buffer.from(sign(body))
	const actual = Buffer.from(parts[2] ?? '')
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null
	}
	try {
		const payload = JSON.parse(
			Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
		) as TokenPayload
		if (typeof payload.e !== 'number' || payload.e * 1000 < Date.now())
			return null
		return payload
	} catch {
		return null
	}
}

function readGitCredential(req: http.IncomingMessage): string | null {
	const header = req.headers.authorization ?? ''
	const bearer = /^Bearer\s+(.+)$/i.exec(header)
	if (bearer?.[1]) return bearer[1].trim()
	const basic = /^Basic\s+(.+)$/i.exec(header)
	if (basic?.[1]) {
		const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8')
		const index = decoded.indexOf(':')
		return index >= 0 ? decoded.slice(index + 1) : decoded
	}
	return null
}

function isInternalAuthorized(req: http.IncomingMessage) {
	const header = req.headers.authorization ?? ''
	const match = /^Bearer\s+(.+)$/i.exec(header)
	const provided = Buffer.from(match?.[1]?.trim() ?? '')
	const expected = Buffer.from(internalToken)
	return (
		provided.length === expected.length && timingSafeEqual(provided, expected)
	)
}

// ---- repo operations ---------------------------------------------------------

async function ensureRepo(
	namespace: string,
	name: string,
	defaultBranch = 'main',
) {
	const dir = repoDir(namespace, name)
	if (existsSync(path.join(dir, 'HEAD'))) return { dir, created: false }
	await mkdir(dir, { recursive: true })
	await git(dir, [
		'init',
		'--bare',
		'--quiet',
		`--initial-branch=${defaultBranch}`,
	])
	await git(dir, ['config', 'http.receivepack', 'true'])
	await git(dir, ['config', 'receive.denyNonFastForwards', 'false'])
	await git(dir, ['config', 'core.logAllRefUpdates', 'true'])
	return { dir, created: true }
}

async function readHead(dir: string) {
	const symbolic = (
		await git(dir, ['symbolic-ref', 'HEAD']).catch(() =>
			Buffer.from('refs/heads/main'),
		)
	)
		.toString()
		.trim()
	const branch = symbolic.replace(/^refs\/heads\//, '')
	const commit = await git(dir, [
		'rev-parse',
		'--verify',
		'--quiet',
		`${symbolic}^{commit}`,
	])
		.then((out) => out.toString().trim() || null)
		.catch(() => null)
	return { branch, ref: symbolic, commit }
}

async function forkRepo(namespace: string, source: string, target: string) {
	const sourceDir = repoDir(namespace, source)
	if (!existsSync(path.join(sourceDir, 'HEAD'))) {
		throw new HttpError(404, 'source repo not found')
	}
	const sourceHead = await readHead(sourceDir)
	const { dir } = await ensureRepo(namespace, target, sourceHead.branch)
	if (sourceHead.commit) {
		await git(dir, [
			'fetch',
			'--quiet',
			sourceDir,
			'+refs/heads/*:refs/heads/*',
		])
	}
	await git(dir, ['symbolic-ref', 'HEAD', sourceHead.ref])
	return readHead(dir)
}

function bytesToSnapshotString(bytes: Buffer, filePath: string) {
	if (shouldStoreArtifactBlobAsLatin1(filePath) || bytes.includes(0)) {
		return bytesToLatin1String(new Uint8Array(bytes))
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return bytesToLatin1String(new Uint8Array(bytes))
	}
}

async function readSnapshot(dir: string, commit: string | null) {
	const head = await readHead(dir)
	const target = commit ?? head.commit
	if (!target) return null
	const resolved = await git(dir, [
		'rev-parse',
		'--verify',
		'--quiet',
		`${target}^{commit}`,
	])
		.then((out) => out.toString().trim())
		.catch(() => null)
	if (!resolved) return null
	const listing = await git(dir, [
		'ls-tree',
		'-r',
		'-z',
		'--full-tree',
		resolved,
	])
	const entries = listing
		.toString('utf8')
		.split('\0')
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf('\t')
			const [mode, type, oid] = line.slice(0, tab).split(' ')
			return { mode, type, oid: oid!, path: line.slice(tab + 1) }
		})
		.filter((entry) => entry.type === 'blob')
	const files: Record<string, string> = {}
	if (entries.length > 0) {
		const batch = await git(dir, ['cat-file', '--batch'], {
			input: entries.map((entry) => entry.oid).join('\n') + '\n',
		})
		let offset = 0
		for (const entry of entries) {
			const headerEnd = batch.indexOf(0x0a, offset)
			const header = batch.subarray(offset, headerEnd).toString()
			const size = Number.parseInt(header.split(' ')[2] ?? '0', 10)
			const start = headerEnd + 1
			files[entry.path] = bytesToSnapshotString(
				batch.subarray(start, start + size),
				entry.path,
			)
			offset = start + size + 1
		}
	}
	return { published_commit: resolved, files }
}

async function writeSnapshot(input: {
	dir: string
	files: Record<string, string>
	message: string
}) {
	const head = await readHead(input.dir)
	const tmp = await mkdtemp(path.join(os.tmpdir(), 'kody-git-index-'))
	const env = {
		GIT_INDEX_FILE: path.join(tmp, 'index'),
		GIT_AUTHOR_NAME: commitAuthorName,
		GIT_AUTHOR_EMAIL: commitAuthorEmail,
		GIT_COMMITTER_NAME: commitAuthorName,
		GIT_COMMITTER_EMAIL: commitAuthorEmail,
	}
	try {
		const paths = Object.keys(input.files).sort()
		const indexLines: Array<string> = []
		for (const filePath of paths) {
			if (filePath.startsWith('/') || filePath.split('/').includes('..')) {
				throw new HttpError(400, `invalid file path: ${filePath}`)
			}
			const bytes = snapshotStringToBytes(input.files[filePath]!, filePath)
			const oid = (
				await git(input.dir, ['hash-object', '-w', '--stdin'], {
					input: Buffer.from(bytes),
				})
			)
				.toString()
				.trim()
			indexLines.push(`100644 ${oid}\t${filePath}`)
		}
		await git(input.dir, ['update-index', '-z', '--index-info'], {
			env,
			input: indexLines.map((line) => `${line}\0`).join(''),
		})
		const tree = (await git(input.dir, ['write-tree'], { env }))
			.toString()
			.trim()
		if (head.commit) {
			const parentTree = (
				await git(input.dir, ['rev-parse', `${head.commit}^{tree}`])
			)
				.toString()
				.trim()
			if (parentTree === tree) {
				return { published_commit: head.commit, unchanged: true }
			}
		}
		const commit = (
			await git(
				input.dir,
				[
					'commit-tree',
					tree,
					...(head.commit ? ['-p', head.commit] : []),
					'-m',
					input.message,
				],
				{ env },
			)
		)
			.toString()
			.trim()
		await git(input.dir, [
			'update-ref',
			head.ref,
			commit,
			head.commit ?? '0000000000000000000000000000000000000000',
		])
		return { published_commit: commit, unchanged: false }
	} finally {
		await rm(tmp, { recursive: true, force: true })
	}
}

// ---- HTTP plumbing ----------------------------------------------------------

async function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024) {
	const chunks: Array<Buffer> = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > limit) throw new HttpError(413, 'body too large')
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks)
}

async function readJson(req: http.IncomingMessage) {
	const body = await readBody(req)
	try {
		return JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
	} catch {
		throw new HttpError(400, 'invalid JSON')
	}
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(text),
	})
	res.end(text)
}

async function handleInternal(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	url: URL,
) {
	if (!isInternalAuthorized(req)) throw new HttpError(401, 'unauthorized')
	const route = url.pathname.replace(/^\/__internal/, '')
	if (req.method === 'GET' && route === '/health') {
		return sendJson(res, 200, { ok: true, root: gitRoot })
	}
	if (req.method === 'POST' && route === '/repos') {
		const body = await readJson(req)
		const namespace = assertName(body.namespace, 'namespace')
		const name = assertName(body.name, 'name')
		const branch =
			typeof body.defaultBranch === 'string' && body.defaultBranch.trim()
				? body.defaultBranch.trim()
				: 'main'
		const result = await withRepoLock(`${namespace}/${name}`, () =>
			ensureRepo(namespace, name, branch),
		)
		return sendJson(res, 200, { created: result.created })
	}
	if (req.method === 'POST' && route === '/repos/fork') {
		const body = await readJson(req)
		const namespace = assertName(body.namespace, 'namespace')
		const source = assertName(body.source, 'source')
		const target = assertName(body.target, 'target')
		const head = await withRepoLock(`${namespace}/${target}`, () =>
			forkRepo(namespace, source, target),
		)
		return sendJson(res, 200, head)
	}
	if (req.method === 'POST' && route === '/repos/delete') {
		const body = await readJson(req)
		const namespace = assertName(body.namespace, 'namespace')
		const name = assertName(body.name, 'name')
		const dir = repoDir(namespace, name)
		const existed = existsSync(dir)
		await withRepoLock(`${namespace}/${name}`, () =>
			rm(dir, { recursive: true, force: true }),
		)
		return sendJson(res, 200, { deleted: existed })
	}
	if (req.method === 'POST' && route === '/tokens') {
		const body = await readJson(req)
		const namespace = assertName(body.namespace, 'namespace')
		const name = assertName(body.name, 'name')
		const scope = body.scope === 'read' ? 'read' : 'write'
		const ttl =
			typeof body.ttl === 'number' && Number.isFinite(body.ttl)
				? Math.floor(body.ttl)
				: 3600
		return sendJson(
			res,
			200,
			mintToken({ namespace, repo: name, scope, ttlSeconds: ttl }),
		)
	}
	if (route === '/head' && req.method === 'GET') {
		const namespace = assertName(url.searchParams.get('namespace'), 'namespace')
		const name = assertName(url.searchParams.get('name'), 'name')
		const dir = repoDir(namespace, name)
		if (!existsSync(path.join(dir, 'HEAD')))
			throw new HttpError(404, 'repo not found')
		return sendJson(res, 200, await readHead(dir))
	}
	if (route === '/snapshot' && req.method === 'GET') {
		const namespace = assertName(url.searchParams.get('namespace'), 'namespace')
		const name = assertName(url.searchParams.get('name'), 'name')
		const commit = url.searchParams.get('commit')?.trim() || null
		if (commit && !/^[0-9a-f]{40,64}$/.test(commit)) {
			throw new HttpError(404, 'snapshot not found')
		}
		const dir = repoDir(namespace, name)
		if (!existsSync(path.join(dir, 'HEAD')))
			throw new HttpError(404, 'repo not found')
		const snapshot = await readSnapshot(dir, commit)
		if (!snapshot) throw new HttpError(404, 'snapshot not found')
		return sendJson(res, 200, snapshot)
	}
	if (route === '/snapshot' && req.method === 'POST') {
		const body = await readJson(req)
		const namespace = assertName(body.namespace, 'namespace')
		const name = assertName(body.name, 'name')
		const files = body.files
		if (!files || typeof files !== 'object' || Array.isArray(files)) {
			throw new HttpError(400, 'files must be an object')
		}
		const clean = Object.fromEntries(
			Object.entries(files as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string',
			),
		)
		const message =
			typeof body.message === 'string' && body.message.trim()
				? body.message.trim()
				: 'Kody source snapshot'
		const result = await withRepoLock(`${namespace}/${name}`, async () => {
			const { dir } = await ensureRepo(namespace, name)
			return writeSnapshot({ dir, files: clean, message })
		})
		return sendJson(res, 200, result)
	}
	throw new HttpError(404, 'not found')
}

async function handleGit(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	url: URL,
) {
	// /git/<namespace>/<repo>.git/<rest>
	const match = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname)
	if (!match) throw new HttpError(404, 'not found')
	const namespace = assertName(decodeURIComponent(match[1]!), 'namespace')
	const name = assertName(decodeURIComponent(match[2]!), 'name')
	const rest = match[3] ?? '/'
	const isPush =
		rest === '/git-receive-pack' ||
		url.searchParams.get('service') === 'git-receive-pack'
	const allowed =
		rest === '/info/refs' ||
		rest === '/git-upload-pack' ||
		rest === '/git-receive-pack' ||
		rest === '/HEAD'
	if (!allowed) throw new HttpError(404, 'not found')

	const token = verifyToken(readGitCredential(req))
	if (
		!token ||
		token.n !== namespace ||
		token.r !== name ||
		(isPush && token.s !== 'write')
	) {
		res.writeHead(401, {
			'www-authenticate': 'Basic realm="kody-git"',
			'content-type': 'text/plain',
		})
		res.end('Unauthorized')
		return
	}
	const dir = repoDir(namespace, name)
	if (!existsSync(path.join(dir, 'HEAD')))
		throw new HttpError(404, 'repo not found')

	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		GIT_PROJECT_ROOT: gitRoot,
		GIT_HTTP_EXPORT_ALL: '1',
		PATH_INFO: `/${namespace}/${name}.git${rest}`,
		REQUEST_METHOD: req.method ?? 'GET',
		QUERY_STRING: url.search.replace(/^\?/, ''),
		CONTENT_TYPE: req.headers['content-type'] ?? '',
		REMOTE_USER: `kody-${token.s}`,
		REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
		GIT_COMMITTER_NAME: commitAuthorName,
		GIT_COMMITTER_EMAIL: commitAuthorEmail,
	}
	if (req.headers['content-encoding']) {
		env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding'])
	}
	if (req.headers['git-protocol']) {
		env.GIT_PROTOCOL = String(req.headers['git-protocol'])
	}
	if (req.headers['content-length']) {
		env.CONTENT_LENGTH = String(req.headers['content-length'])
	}

	const child = spawn('git', ['http-backend'], {
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	child.stdin.on('error', () => {})
	req.pipe(child.stdin)
	child.stderr.on('data', (chunk: Buffer) =>
		console.error(`[git http-backend] ${chunk.toString().trim()}`),
	)

	let headerBuffer = Buffer.alloc(0)
	let headersSent = false
	child.stdout.on('data', (chunk: Buffer) => {
		if (headersSent) {
			res.write(chunk)
			return
		}
		headerBuffer = Buffer.concat([headerBuffer, chunk])
		let sepIndex = headerBuffer.indexOf('\r\n\r\n')
		let sepLength = 4
		if (sepIndex < 0) {
			sepIndex = headerBuffer.indexOf('\n\n')
			sepLength = 2
		}
		if (sepIndex < 0) return
		const headerText = headerBuffer.subarray(0, sepIndex).toString('utf8')
		const bodyStart = headerBuffer.subarray(sepIndex + sepLength)
		let status = 200
		const headers: Record<string, string> = {}
		for (const line of headerText.split(/\r?\n/)) {
			const idx = line.indexOf(':')
			if (idx < 0) continue
			const key = line.slice(0, idx).trim()
			const value = line.slice(idx + 1).trim()
			if (key.toLowerCase() === 'status') {
				status = Number.parseInt(value, 10) || 200
			} else {
				headers[key] = value
			}
		}
		res.writeHead(status, headers)
		headersSent = true
		if (bodyStart.length) res.write(bodyStart)
	})
	child.on('close', (code) => {
		if (!headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain' })
			res.end(`git http-backend exited ${code}`)
			return
		}
		res.end()
		if (rest === '/git-receive-pack' && code === 0) {
			console.log(`selfhost-git: push ${namespace}/${name}`)
		}
	})
}

process.on('uncaughtException', (error) => {
	console.error('selfhost-git uncaught', error)
})

const server = http.createServer((req, res) => {
	const url = new URL(
		req.url ?? '/',
		`http://${req.headers.host ?? 'localhost'}`,
	)
	const handler = url.pathname.startsWith('/__internal/')
		? handleInternal
		: url.pathname.startsWith('/git/')
			? handleGit
			: null
	if (!handler) {
		if (url.pathname === '/health') return sendJson(res, 200, { ok: true })
		return sendJson(res, 404, { error: 'not found' })
	}
	handler(req, res, url).catch((error: unknown) => {
		const status = error instanceof HttpError ? error.status : 500
		if (status === 500) console.error('selfhost-git error', error)
		if (!res.headersSent) {
			sendJson(res, status, {
				error: error instanceof Error ? error.message : String(error),
			})
		} else {
			res.destroy()
		}
	})
})

await mkdir(gitRoot, { recursive: true })
server.listen(port, host, () => {
	console.log(
		`selfhost-git listening on http://${host}:${port} (root ${gitRoot})`,
	)
})
