import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type Plugin } from 'vite'

export const devCimdProxyPath = '/__kody-dev/cimd'
export const devCimdProxyTokenHeader = 'x-kody-dev-cimd-token'

const maxDocumentBytes = 5 * 1024
const fetchTimeoutMs = 10_000

/**
 * Local-dev only. Some CIMD hosts (notably `https://chatgpt.com/oauth/client.json`)
 * sit behind bot protection that answers workerd's outbound fetch with a 403
 * while Node's fetch from the same machine gets the document. The origin
 * Worker asks this Node-side endpoint for the document and seeds the OAuth
 * provider's CIMD cache with it (see `#worker/dev-cimd-prefetch.ts`). The
 * per-process token keeps the endpoint from being an open fetch proxy when the
 * dev server is exposed through a reverse proxy (tailscale serve, tunnels).
 */
export function devCimdProxy({ token }: { token: string }): Plugin {
	return {
		name: 'kody-dev-cimd-proxy',
		apply: 'serve',
		enforce: 'pre',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = new URL(req.url ?? '/', 'http://localhost')
				if (url.pathname !== devCimdProxyPath) return next()
				void handleDevCimdProxyRequest({ req, res, url, token })
			})
		},
	}
}

export function parseDevCimdTargetUrl(raw: string | null) {
	if (!raw) return null
	let target: URL
	try {
		target = new URL(raw)
	} catch {
		return null
	}
	if (target.protocol !== 'https:') return null
	if (target.username || target.password) return null
	if (target.port && target.port !== '443') return null
	if (target.pathname === '/' || target.hash) return null
	return target
}

async function handleDevCimdProxyRequest({
	req,
	res,
	url,
	token,
}: {
	req: IncomingMessage
	res: ServerResponse
	url: URL
	token: string
}) {
	const send = (status: number, body: string, contentType = 'text/plain') => {
		res.statusCode = status
		res.setHeader('Content-Type', contentType)
		res.setHeader('Cache-Control', 'no-store')
		res.end(body)
	}
	if (req.method !== 'GET') return send(405, 'Method Not Allowed')
	if (req.headers[devCimdProxyTokenHeader] !== token) {
		return send(404, 'Not Found')
	}
	const target = parseDevCimdTargetUrl(url.searchParams.get('url'))
	if (!target) return send(400, 'Invalid CIMD url')
	try {
		const response = await fetch(target, {
			headers: { Accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(fetchTimeoutMs),
		})
		const bytes = new Uint8Array(await response.arrayBuffer())
		if (!response.ok) return send(502, `Upstream HTTP ${response.status}`)
		if (bytes.byteLength > maxDocumentBytes) {
			return send(502, 'Upstream document too large')
		}
		res.statusCode = 200
		res.setHeader('Content-Type', 'application/json')
		res.setHeader('Cache-Control', 'no-store')
		res.end(bytes)
	} catch (error) {
		send(502, error instanceof Error ? error.message : 'Upstream fetch failed')
	}
}
