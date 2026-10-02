/**
 * One-time migration: legacy mock Artifacts snapshots -> real git commits.
 *
 * Before the self-hosted git backend, the Cloudflare API stand-in stored each
 * package source as an in-memory snapshot with a fake `mock_commit_<uuid>`
 * id. This script, run with Kody STOPPED:
 *   1. reads every legacy snapshot from a JSON export (see --snapshots),
 *   2. writes it into the git backend as a real commit,
 *   3. rewrites every `mock_commit_<uuid>` reference to the new sha in the
 *      local D1 database and the BUNDLE_ARTIFACTS_KV miniflare store
 *      (keys and JSON blob bodies),
 *   4. updates the stand-in's persisted repo remotes.
 *
 * Usage:
 *   node --env-file=packages/worker/.env tools/selfhost-git-migrate.ts \
 *     --snapshots <export.json> [--state .wrangler/state/v3] [--apply]
 *
 * Without --apply it only prints the plan.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
function arg(name: string) {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}
const apply = args.includes('--apply')
const snapshotsPath = arg('--snapshots')
const stateRoot = path.resolve(arg('--state') ?? '.wrangler/state/v3')
const namespace = arg('--namespace') ?? 'production'
const backendUrl = (
	process.env.KODY_GIT_BACKEND_URL ?? 'http://127.0.0.1:9029'
).replace(/\/$/, '')
const internalToken = (
	process.env.KODY_GIT_INTERNAL_TOKEN ??
	process.env.KODY_CLOUDFLARE_MOCK_TOKEN ??
	''
).trim()
const publicUrl = (process.env.KODY_GIT_PUBLIC_URL ?? backendUrl).replace(
	/\/$/,
	'',
)

if (!snapshotsPath) throw new Error('--snapshots <export.json> is required')
if (!internalToken) throw new Error('KODY_GIT_INTERNAL_TOKEN is required')

type Export = Record<
	string,
	{
		repo: { name: string; default_branch?: string }
		snapshot: { published_commit: string; files: Record<string, string> } | null
	}
>
const exported = JSON.parse(readFileSync(snapshotsPath, 'utf8')) as Export

async function backend<T>(
	method: string,
	route: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`${backendUrl}/__internal${route}`, {
		method,
		headers: {
			authorization: `Bearer ${internalToken}`,
			'content-type': 'application/json',
		},
		body: body ? JSON.stringify(body) : undefined,
	})
	const text = await response.text()
	if (!response.ok) throw new Error(`${route} ${response.status}: ${text}`)
	return JSON.parse(text) as T
}

function findSqlite(dir: string, predicate: (db: DatabaseSync) => boolean) {
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
		.map((name) => path.join(dir, name))
		.filter((file) => {
			const db = new DatabaseSync(file, { readOnly: true })
			try {
				return predicate(db)
			} catch {
				return false
			} finally {
				db.close()
			}
		})
}

function hasTable(db: DatabaseSync, table: string) {
	return Boolean(
		db
			.prepare(`select 1 from sqlite_master where type='table' and name=?`)
			.get(table),
	)
}

// ---- 1+2: write commits -------------------------------------------------------

const mapping = new Map<string, string>() // mock_commit -> sha
const repoBranches = new Map<string, string>()
for (const [repoName, entry] of Object.entries(exported)) {
	repoBranches.set(repoName, entry.repo.default_branch || 'main')
	if (!entry.snapshot) {
		console.log(`skip ${repoName}: no snapshot`)
		continue
	}
	const legacy = entry.snapshot.published_commit
	if (!apply) {
		console.log(
			`plan ${repoName}: ${legacy} -> <new commit> (${Object.keys(entry.snapshot.files).length} files)`,
		)
		mapping.set(legacy, `<sha-for-${legacy}>`)
		continue
	}
	await backend('POST', '/repos', {
		namespace,
		name: repoName,
		defaultBranch: entry.repo.default_branch || 'main',
	})
	const result = await backend<{ published_commit: string }>(
		'POST',
		'/snapshot',
		{
			namespace,
			name: repoName,
			files: entry.snapshot.files,
			message: `Import Kody source (legacy ${legacy})`,
		},
	)
	mapping.set(legacy, result.published_commit)
	console.log(`git  ${repoName}: ${legacy} -> ${result.published_commit}`)
}

function rewrite(value: string) {
	let next = value
	for (const [legacy, sha] of mapping) {
		if (next.includes(legacy)) next = next.split(legacy).join(sha)
	}
	return next
}

// ---- 3a: D1 -------------------------------------------------------------------

const d1Files = findSqlite(
	path.join(stateRoot, 'd1/miniflare-D1DatabaseObject'),
	(db) => hasTable(db, 'entity_sources'),
)
for (const file of d1Files) {
	const db = new DatabaseSync(file, { readOnly: !apply })
	for (const [table, columns] of [
		['entity_sources', ['published_commit', 'indexed_commit']],
		['published_bundle_artifacts', ['published_commit', 'kv_key']],
		['community_forks', ['origin_commit']],
		['community_listings', ['pinned_commit']],
		['package_share_grants', ['accepted_published_commit']],
		['package_codemod_run_items', ['before_commit', 'after_commit']],
	] as const) {
		if (!hasTable(db, table)) continue
		for (const column of columns) {
			const rows = db
				.prepare(
					`select rowid as rid, ${column} as v from ${table} where ${column} like '%mock_commit_%'`,
				)
				.all() as Array<{ rid: number; v: string }>
			let changed = 0
			for (const row of rows) {
				const next = rewrite(row.v)
				if (next === row.v) {
					console.warn(`  unmapped ${table}.${column}: ${row.v}`)
					continue
				}
				if (apply) {
					db.prepare(`update ${table} set ${column}=? where rowid=?`).run(
						next,
						row.rid,
					)
				}
				changed++
			}
			if (rows.length)
				console.log(`d1   ${table}.${column}: ${changed}/${rows.length}`)
		}
	}
	db.close()
}

// ---- 3b: KV (miniflare: sqlite index + content-addressed blob files) ------------

const kvDir = path.join(stateRoot, 'kv/miniflare-KVNamespaceObject')
const blobsDir = path.join(stateRoot, 'kv/BUNDLE_ARTIFACTS_KV/blobs')
const kvFiles = findSqlite(kvDir, (db) => {
	if (!hasTable(db, '_mf_entries')) return false
	return Boolean(
		db
			.prepare(
				`select 1 from _mf_entries where key like 'source-snapshot:%' limit 1`,
			)
			.get(),
	)
})
for (const file of kvFiles) {
	const db = new DatabaseSync(file, { readOnly: !apply })
	const rows = db
		.prepare(
			`select key, blob_id, expiration, metadata from _mf_entries where key like '%mock_commit_%'`,
		)
		.all() as Array<{
		key: string
		blob_id: string
		expiration: number | null
		metadata: string | null
	}>
	let keys = 0
	let bodies = 0
	for (const row of rows) {
		const nextKey = rewrite(row.key)
		const blobPath = path.join(blobsDir, row.blob_id)
		let nextBlobId = row.blob_id
		if (existsSync(blobPath)) {
			const body = readFileSync(blobPath)
			const text = body.toString('utf8')
			const nextText = rewrite(text)
			if (nextText !== text) {
				// miniflare blob ids: 64 hex random + 16 hex timestamp; any
				// unique name works because the sqlite row points at it.
				nextBlobId =
					createHash('sha256').update(nextText).digest('hex') +
					Date.now().toString(16).padStart(16, '0')
				if (apply) writeFileSync(path.join(blobsDir, nextBlobId), nextText)
				bodies++
			}
		}
		if (nextKey === row.key && nextBlobId === row.blob_id) continue
		if (apply) {
			db.prepare(`delete from _mf_entries where key=?`).run(row.key)
			db.prepare(
				`insert or replace into _mf_entries (key, blob_id, expiration, metadata) values (?,?,?,?)`,
			).run(nextKey, nextBlobId, row.expiration, row.metadata)
		}
		if (nextKey !== row.key) keys++
	}
	console.log(
		`kv   ${path.basename(file)}: ${keys} keys, ${bodies} bodies rewritten (of ${rows.length})`,
	)
	db.close()
}

// ---- 3c: drop cached artifact heads so they are re-resolved from git ------------

for (const file of kvFiles) {
	const db = new DatabaseSync(file, { readOnly: !apply })
	const stale = db
		.prepare(
			`select count(*) as n from _mf_entries where key like '%artifact-source-head%' or key like '%artifact-head%'`,
		)
		.get() as { n: number }
	if (stale.n && apply) {
		db.prepare(
			`delete from _mf_entries where key like '%artifact-source-head%' or key like '%artifact-head%'`,
		).run()
	}
	if (stale.n) console.log(`kv   dropped ${stale.n} cached artifact heads`)
	db.close()
}

// ---- 4: stand-in repo remotes (durable object storage) ---------------------------
// The stand-in rewrites `remote` on read when KODY_GIT_BACKEND_URL is set, so
// persisted remotes only matter for display; nothing to do here.

console.log(
	`\n${apply ? 'applied' : 'dry run'}: ${mapping.size} commits, remotes -> ${publicUrl}/git/${namespace}/<repo>.git`,
)
if (apply) {
	writeFileSync(
		path.join(path.dirname(snapshotsPath), 'commit-mapping.json'),
		JSON.stringify(Object.fromEntries(mapping), null, 2),
	)
}
