import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpClientAccessPolicy } from '@kody-internal/shared/mcp-client-access.ts'
import { getMcpClientAccessPolicy } from './repo.ts'
import { runWithMcpClientAccess } from './scope.ts'

/** Policy for a client with no stored row: the full assistant grant. */
export function createUnrestrictedMcpClientAccess(
	clientId: string,
): McpClientAccessPolicy {
	return {
		clientId,
		packageMode: 'all',
		allowedPackageIds: [],
		domainMode: 'all',
		allowedDomains: [],
		credentialMode: 'all',
		allowedSecretNames: [],
		allowedIntegrations: [],
		allowedSecretProviders: [],
	}
}

/**
 * Load the effective policy for one inbound OAuth client. Always returns a
 * policy object (unrestricted when no row exists) so the caller context keeps
 * the client id even before the owner restricts it. D1 errors propagate:
 * callers fail closed rather than serving the full grant.
 */
export async function loadMcpClientAccess(
	db: D1Database,
	input: { userId: string; clientId: string },
): Promise<McpClientAccessPolicy> {
	const stored = await getMcpClientAccessPolicy(db, input)
	if (!stored) return createUnrestrictedMcpClientAccess(input.clientId)
	const { updatedAt: _updatedAt, ...policy } = stored
	return policy
}

/**
 * Re-read the stamped client's policy for long-lived MCP sessions. The legacy
 * Durable Object lane keeps the props from session start, so search/execute
 * refresh here to apply edits made after the session began.
 */
export async function refreshCallerContextClientAccess(
	env: Pick<Env, 'APP_DB'>,
	callerContext: McpCallerContext,
): Promise<McpCallerContext> {
	const clientId = callerContext.clientAccess?.clientId?.trim()
	const userId = callerContext.user?.userId
	if (!clientId || !userId) return callerContext
	const clientAccess = await loadMcpClientAccess(env.APP_DB, {
		userId,
		clientId,
	})
	return { ...callerContext, clientAccess }
}

/**
 * Run one MCP tool call under the connection's current policy: refresh the
 * stamped policy from D1, hand the tool an agent whose caller context carries
 * it, and pin it as ambient host state for nested work.
 */
export async function runMcpToolWithClientAccess<
	Agent extends {
		getEnv(): Env
		getCallerContext(): McpCallerContext
	},
	Result,
>(agent: Agent, run: (scopedAgent: Agent) => Promise<Result>): Promise<Result> {
	const callerContext = await refreshCallerContextClientAccess(
		agent.getEnv(),
		agent.getCallerContext(),
	)
	const scopedAgent = Object.create(agent, {
		getCallerContext: { value: () => callerContext },
	}) as Agent
	return await runWithMcpClientAccess(callerContext.clientAccess, () =>
		run(scopedAgent),
	)
}
