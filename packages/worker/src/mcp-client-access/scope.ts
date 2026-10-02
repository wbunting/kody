import { AsyncLocalStorage } from 'node:async_hooks'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpClientAccessPolicy } from '@kody-internal/shared/mcp-client-access.ts'

/**
 * Ambient per-OAuth-client policy for host-side work started by one MCP tool
 * call (self-host fork).
 *
 * The caller context carries the policy for the MCP tool itself, but nested
 * package runs, retrievers, and capability handlers rebuild their own caller
 * context from the actor user id and would otherwise drop it. Tool handlers
 * enter this scope once; sandbox → host capability callbacks re-enter it
 * explicitly (see `createToolDispatchers`), because async-local state does not
 * survive the RPC hop on its own. The fetch gateway is a separate entrypoint
 * and receives the policy through its props instead.
 */
const clientAccessStorage =
	new AsyncLocalStorage<McpClientAccessPolicy | null>()

export function runWithMcpClientAccess<T>(
	policy: McpClientAccessPolicy | null | undefined,
	fn: () => T,
): T {
	return clientAccessStorage.run(policy ?? null, fn)
}

export function getAmbientMcpClientAccess(): McpClientAccessPolicy | null {
	return clientAccessStorage.getStore() ?? null
}

/**
 * The policy that governs work for this caller: the caller context's own
 * policy when stamped (MCP tool calls), otherwise the ambient one inherited
 * from the enclosing MCP tool call (nested package runs, retrievers).
 */
export function resolveEffectiveMcpClientAccess(
	callerContext: Pick<McpCallerContext, 'clientAccess'> | null | undefined,
): McpClientAccessPolicy | null {
	return callerContext?.clientAccess ?? getAmbientMcpClientAccess()
}
