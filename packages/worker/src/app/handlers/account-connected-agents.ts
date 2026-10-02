import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	array,
	enum_,
	type InferOutput,
	object,
	optional,
	parseSafe,
	string,
} from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
} from '#universal/onboarding-agent-ecosystems.ts'
import {
	loadInboundMcpConnectionState,
	revokeConnectedMcpAgent,
} from '#worker/connected-mcp-agents.ts'
import { maybeEvaluateSecondAgentStandardGift } from '#worker/entitlements/second-agent-standard-gift.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import {
	type OAuthGrantHelpers,
	type OAuthGrantListHelpers,
} from '#worker/oauth-grants.ts'
import { buildMcpServerUrl } from '#worker/onboarding-prompts.ts'
import { type McpClientAccessPolicy } from '@kody-internal/shared/mcp-client-access.ts'
import {
	loadMcpClientAccessOptions,
	loadMcpClientAccessPoliciesByClientId,
	sanitizeMcpClientAccessPolicyInput,
} from '#worker/mcp-client-access/options.ts'
import {
	deleteMcpClientAccessPolicy,
	upsertMcpClientAccessPolicy,
} from '#worker/mcp-client-access/repo.ts'
import { parseAccountConnectionsPathname } from '#universal/account-connections.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'

type ConnectedAgentsUser = {
	mcpUser: { userId: string }
	emailVerified: boolean
}

export async function loadAccountConnectedAgentsData(input: {
	env: Env
	requestUrl: string | URL
	user: ConnectedAgentsUser
}): Promise<AccountConnectedAgentsLoaderData> {
	const stableUserId = input.user.mcpUser.userId
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	const [state, policiesByClientId, accessOptions] = await Promise.all([
		loadInboundMcpConnectionState(helpers, stableUserId, {
			env: input.env,
		}),
		// Listing stays available if the access-policy tables are unreadable;
		// enforcement itself (mcp-auth) fails closed independently.
		loadMcpClientAccessPoliciesByClientId({
			env: input.env,
			userId: stableUserId,
		}).catch(() => new Map<string, McpClientAccessPolicy>()),
		loadMcpClientAccessOptions({
			env: input.env,
			userId: stableUserId,
		}).catch(() => undefined),
	])
	const ecosystemCount = countConnectedAgentEcosystems(state.agents)
	if (!state.listingFailed && hasSecondConnectedMcpClient(state.agents)) {
		await maybeEvaluateSecondAgentStandardGift({
			db: input.env.APP_DB,
			stableUserId,
			ecosystemCount,
			listingFailed: state.listingFailed,
		})
	}
	return {
		ok: true,
		agents: state.agents.map((agent) => ({
			...agent,
			access: policiesByClientId.get(agent.clientId) ?? null,
		})),
		...(accessOptions ? { accessOptions } : {}),
		mcpServerUrl: input.user.emailVerified
			? buildMcpServerUrl({ env: input.env, requestUrl: input.requestUrl })
			: '',
	}
}

/**
 * `/account/connections`, `/account/connections/new`, and
 * `/account/connections/new/:agent` share one payload; the client renders
 * each pathname as its own page (the list does not wrap the add views).
 * An unknown agent segment is a 404 page.
 */
export function createAccountConnectionsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const view = parseAccountConnectionsPathname(
				new URL(request.url).pathname,
			)
			if (!view) {
				return renderAppPage({
					request,
					env,
					title: 'Connection not found',
					notFound: true,
					status: 404,
				})
			}

			const accountConnectedAgents = await loadAccountConnectedAgentsData({
				env,
				requestUrl: request.url,
				user,
			})
			// Titles come from the document-head registry so SPA navigation
			// between the list, grid, and per-agent views agrees with SSR.
			return renderAppPage({
				request,
				env,
				loaderData: { accountConnectedAgents },
			})
		},
	} satisfies Action<
		| typeof routes.accountConnections
		| typeof routes.accountConnectionNew
		| typeof routes.accountConnectionNewAgent
	>
}

export function createAccountConnectedAgentsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountConnectedAgentsData({
						env,
						requestUrl: request.url,
						user,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const accessParsed = parseSafe(accessSchema, body)
			if (accessParsed.success) {
				return await handleAccessIntent({
					env,
					request,
					url,
					user,
					input: accessParsed.value,
				})
			}
			const parsed = parseSafe(revokeSchema, body)
			if (!parsed.success || parsed.value.intent !== 'revoke') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const helpers = await resolveOAuthHelpers<OAuthGrantHelpers>(env)
			if (!helpers) {
				return jsonResponse(
					{ ok: false, error: 'Connected agent listing is unavailable.' },
					503,
				)
			}

			const revoked = await revokeConnectedMcpAgent({
				helpers,
				userId: user.mcpUser.userId,
				clientId: parsed.value.clientId.trim(),
				env,
			})
			if ('error' in revoked) {
				return jsonResponse(
					{ ok: false, error: 'Connected agent not found.' },
					404,
				)
			}

			// Best-effort: a stale policy row for a revoked client is inert (no
			// grant can present that client id for this user any more).
			await Promise.resolve()
				.then(() =>
					deleteMcpClientAccessPolicy(env.APP_DB, {
						userId: user.mcpUser.userId,
						clientId: parsed.value.clientId.trim(),
					}),
				)
				.catch(() => undefined)
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'mcp_inbound_grant_revoke',
				result: 'success',
				email: user.email,
				ip: getRequestIp(request) ?? undefined,
				path: url.pathname,
				clientId: parsed.value.clientId.trim(),
			})
			return jsonResponse(
				await loadAccountConnectedAgentsData({
					env,
					requestUrl: request.url,
					user,
				}),
			)
		},
	} satisfies Action<typeof routes.accountConnectedAgentsApi>
}

const revokeSchema = object({
	intent: enum_(['revoke'] as const),
	clientId: string(),
})

const accessModeSchema = enum_(['all', 'allowlist'] as const)

/**
 * Per-OAuth-client access edits (self-host fork). `set-access` replaces the
 * client's policy; `clear-access` restores the full grant.
 */
const accessSchema = object({
	intent: enum_(['set-access', 'clear-access'] as const),
	clientId: string(),
	policy: optional(
		object({
			packageMode: accessModeSchema,
			allowedPackageIds: array(string()),
			domainMode: accessModeSchema,
			allowedDomains: array(string()),
			credentialMode: accessModeSchema,
			allowedSecretNames: array(string()),
			allowedIntegrations: array(string()),
			allowedSecretProviders: array(string()),
		}),
	),
})

async function handleAccessIntent(input: {
	env: Env
	request: Request
	url: URL
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	input: InferOutput<typeof accessSchema>
}) {
	const { env, user } = input
	const clientId = input.input.clientId.trim()
	if (!clientId) {
		return jsonResponse({ ok: false, error: 'clientId is required.' }, 400)
	}
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(env)
	const state = await loadInboundMcpConnectionState(
		helpers,
		user.mcpUser.userId,
		{ env },
	)
	if (!state.agents.some((agent) => agent.clientId === clientId)) {
		return jsonResponse({ ok: false, error: 'Connected agent not found.' }, 404)
	}
	if (input.input.intent === 'clear-access') {
		await deleteMcpClientAccessPolicy(env.APP_DB, {
			userId: user.mcpUser.userId,
			clientId,
		})
	} else {
		if (!input.input.policy) {
			return jsonResponse({ ok: false, error: 'policy is required.' }, 400)
		}
		const options = await loadMcpClientAccessOptions({
			env,
			userId: user.mcpUser.userId,
		})
		await upsertMcpClientAccessPolicy(env.APP_DB, {
			userId: user.mcpUser.userId,
			clientId,
			policy: sanitizeMcpClientAccessPolicyInput(input.input.policy, options),
		})
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action:
			input.input.intent === 'clear-access'
				? 'mcp_client_access_clear'
				: 'mcp_client_access_set',
		result: 'success',
		email: user.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: input.url.pathname,
		clientId,
	})
	return jsonResponse(
		await loadAccountConnectedAgentsData({
			env,
			requestUrl: input.request.url,
			user,
		}),
	)
}
