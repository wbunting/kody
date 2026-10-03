import { oauthPaths } from '#universal/oauth-paths.ts'

/**
 * Local-dev / self-host only: seed `@cloudflare/workers-oauth-provider`'s CIMD
 * cache through the Vite dev server's Node-side fetch.
 *
 * Some CIMD hosts (notably `https://chatgpt.com/oauth/client.json`) answer
 * workerd's outbound fetch from a home machine with a bot-protection 403,
 * while Node's fetch from the same machine gets the document. The provider
 * checks `caches.open(cimdCacheName)` before fetching the origin, so a
 * document seeded here is validated and used exactly as if the provider had
 * fetched it. Production never sets the proxy vars, so this is a no-op there.
 */

// Must match CIMD_CACHE_NAME in @cloudflare/workers-oauth-provider.
export const cimdCacheName = 'workers-oauth-provider:cimd:v1'
const seededCacheTtlSeconds = 60 * 60
const devCimdProxyTokenHeader = 'x-kody-dev-cimd-token'

type DevCimdEnv = {
	WRANGLER_IS_LOCAL_DEV?: string | undefined
	KODY_DEV_CIMD_PROXY_URL?: string | undefined
	KODY_DEV_CIMD_PROXY_TOKEN?: string | undefined
}

const cimdClientPaths = new Set<string>([
	oauthPaths.authorize,
	oauthPaths.authorizeInfo,
	oauthPaths.token,
])

export function isCimdClientIdUrl(clientId: string | null | undefined) {
	if (!clientId) return false
	try {
		const url = new URL(clientId)
		return url.protocol === 'https:' && url.pathname !== '/'
	} catch {
		return false
	}
}

async function readCimdClientId(request: Request, url: URL) {
	const fromQuery = url.searchParams.get('client_id')?.trim()
	if (fromQuery) return fromQuery
	if (request.method !== 'POST') return null
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/x-www-form-urlencoded')) return null
	const form = await request
		.clone()
		.formData()
		.catch(() => null)
	const fromBody = form?.get('client_id')
	return typeof fromBody === 'string' ? fromBody.trim() : null
}

export async function seedDevCimdCacheForRequest(
	request: Request,
	env: DevCimdEnv,
) {
	if (env.WRANGLER_IS_LOCAL_DEV !== 'true') return
	const proxyUrl = env.KODY_DEV_CIMD_PROXY_URL
	const proxyToken = env.KODY_DEV_CIMD_PROXY_TOKEN
	if (!proxyUrl || !proxyToken) return
	const url = new URL(request.url)
	if (!cimdClientPaths.has(url.pathname)) return
	const clientId = await readCimdClientId(request, url)
	if (!isCimdClientIdUrl(clientId)) return
	try {
		await seedDevCimdCache(clientId!, { proxyUrl, proxyToken })
	} catch (error) {
		// Best effort: the provider still tries its own fetch and reports
		// the unknown client if this also failed.
		console.warn(
			`Dev CIMD prefetch failed for ${clientId}:`,
			error instanceof Error ? error.message : error,
		)
	}
}

async function seedDevCimdCache(
	clientId: string,
	{ proxyUrl, proxyToken }: { proxyUrl: string; proxyToken: string },
) {
	if (typeof caches === 'undefined') return
	const cache = await caches.open(cimdCacheName)
	if (await cache.match(clientId)) return
	const target = new URL(proxyUrl)
	target.searchParams.set('url', clientId)
	const response = await fetch(target, {
		headers: { [devCimdProxyTokenHeader]: proxyToken },
	})
	if (!response.ok) {
		throw new Error(`dev CIMD proxy returned HTTP ${response.status}`)
	}
	const bytes = await response.arrayBuffer()
	await cache.put(
		clientId,
		new Response(bytes, {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': `public, max-age=${seededCacheTtlSeconds}`,
			},
		}),
	)
}
