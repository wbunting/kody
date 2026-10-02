import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	mcpClientAccessDeniedMessage,
	mcpClientPolicyAllowsIntegration,
	mcpClientPolicyAllowsPackage,
	mcpClientPolicyAllowsSecretProvider,
	mcpClientPolicyAllowsUserSecret,
	type McpClientAccessPolicy,
} from '@kody-internal/shared/mcp-client-access.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveEffectiveMcpClientAccess } from './scope.ts'

/**
 * Per-connection policy denial (self-host fork). A caller error: the agent can
 * read the message and stop; it is not a platform defect.
 */
export class McpClientAccessDeniedError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'McpClientAccessDeniedError'
	}
}

type PolicySource =
	| Pick<McpCallerContext, 'clientAccess'>
	| McpClientAccessPolicy
	| null
	| undefined

function readPolicy(source: PolicySource): McpClientAccessPolicy | null {
	if (source && 'packageMode' in source) return source
	return resolveEffectiveMcpClientAccess(
		source as Pick<McpCallerContext, 'clientAccess'> | null | undefined,
	)
}

/**
 * Root-level package gate for ad hoc execute: every saved package the entry
 * module imports directly (static `kody:@…`) or invokes dynamically must be on
 * the allowlist. Allowed packages keep their own dependencies — the allowlist
 * names entry points, not a transitive closure.
 */
export function assertMcpClientCanUsePackage(input: {
	policy: PolicySource
	packageId: string | null | undefined
	packageName: string
}) {
	const policy = readPolicy(input.policy)
	if (mcpClientPolicyAllowsPackage(policy, input.packageId)) return
	throw new McpClientAccessDeniedError(
		mcpClientAccessDeniedMessage({ what: `package "${input.packageName}"` }),
	)
}

export function assertMcpClientCanUseUserSecret(input: {
	policy: PolicySource
	name: string
}) {
	const policy = readPolicy(input.policy)
	if (mcpClientPolicyAllowsUserSecret(policy, input.name)) return
	throw new McpClientAccessDeniedError(
		mcpClientAccessDeniedMessage({ what: `secret "${input.name}"` }),
	)
}

export function assertMcpClientCanUseIntegration(input: {
	policy: PolicySource
	name: string
}) {
	const policy = readPolicy(input.policy)
	if (mcpClientPolicyAllowsIntegration(policy, input.name)) return
	throw new McpClientAccessDeniedError(
		mcpClientAccessDeniedMessage({ what: `integration "${input.name}"` }),
	)
}

export function assertMcpClientCanUseSecretProvider(input: {
	policy: PolicySource
	provider: string
}) {
	const policy = readPolicy(input.policy)
	if (mcpClientPolicyAllowsSecretProvider(policy, input.provider)) return
	throw new McpClientAccessDeniedError(
		mcpClientAccessDeniedMessage({
			what: `secret provider "${input.provider}"`,
		}),
	)
}
