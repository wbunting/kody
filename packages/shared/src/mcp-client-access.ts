import {
	array,
	literal,
	object,
	string,
	type InferOutput,
	union,
} from 'remix/data-schema'

const modeSchema = union([literal('all'), literal('allowlist')])

/**
 * Per-OAuth-client access policy carried on the MCP caller context (self-host
 * fork). Absent means the connection keeps the full assistant grant.
 *
 * Three independent gates, each `all` (unrestricted) or `allowlist`:
 *
 * - packages: which saved packages ad hoc execute code may import or invoke,
 *   and whose retrievers / search rows the connection sees. Allowed packages
 *   keep their own package dependencies.
 * - domains: which builtin capability domains (and `mcp:*` remote MCP server
 *   domains) the connection can search and call. `meta` and `coding` always
 *   stay on so `search` / `execute` / memories keep working.
 * - credentials: which user-scoped secrets, integrations, and secret
 *   providers any code in the run may resolve — including nested package
 *   runs. This is the hard boundary: code inside one sandbox can claim a
 *   co-bundled package's secret authority, so the credential itself is gated
 *   rather than the code that asks for it.
 *
 * Resolved from D1 on every `/mcp` request (and again at each search/execute
 * tool call for long-lived sessions), so edits apply on the next call.
 */
export const mcpClientAccessPolicySchema = object({
	clientId: string(),
	packageMode: modeSchema,
	allowedPackageIds: array(string()),
	domainMode: modeSchema,
	allowedDomains: array(string()),
	credentialMode: modeSchema,
	/** User-scoped secret names. Package- and session-scoped secrets are not gated. */
	allowedSecretNames: array(string()),
	/** Integration connection names (`{{integration:name}}`). */
	allowedIntegrations: array(string()),
	/** Secret provider names (`{{provider:name:ref}}`). */
	allowedSecretProviders: array(string()),
})

export type McpClientAccessPolicy = InferOutput<
	typeof mcpClientAccessPolicySchema
>

/** Domains every connection keeps: search/execute plumbing, memories, guides. */
export const alwaysAllowedMcpClientDomains: ReadonlyArray<string> = [
	'meta',
	'coding',
]

type MaybePolicy = McpClientAccessPolicy | null | undefined

export function mcpClientPolicyAllowsDomain(
	policy: MaybePolicy,
	domain: string,
): boolean {
	if (!policy || policy.domainMode === 'all') return true
	if (alwaysAllowedMcpClientDomains.includes(domain)) return true
	return policy.allowedDomains.includes(domain)
}

export function mcpClientPolicyAllowsPackage(
	policy: MaybePolicy,
	packageId: string | null | undefined,
): boolean {
	if (!policy || policy.packageMode === 'all') return true
	if (!packageId) return false
	return policy.allowedPackageIds.includes(packageId)
}

export function mcpClientPolicyAllowsUserSecret(
	policy: MaybePolicy,
	name: string,
): boolean {
	if (!policy || policy.credentialMode === 'all') return true
	return policy.allowedSecretNames.includes(name)
}

export function mcpClientPolicyAllowsIntegration(
	policy: MaybePolicy,
	name: string,
): boolean {
	if (!policy || policy.credentialMode === 'all') return true
	return policy.allowedIntegrations.includes(name)
}

export function mcpClientPolicyAllowsSecretProvider(
	policy: MaybePolicy,
	provider: string,
): boolean {
	if (!policy || policy.credentialMode === 'all') return true
	return policy.allowedSecretProviders.includes(provider)
}

/** True when any gate narrows the connection below the full grant. */
export function mcpClientPolicyIsRestrictive(policy: MaybePolicy): boolean {
	if (!policy) return false
	return (
		policy.packageMode === 'allowlist' ||
		policy.domainMode === 'allowlist' ||
		policy.credentialMode === 'allowlist'
	)
}

export function mcpClientAccessDeniedMessage(input: {
	what: string
	clientLabel?: string | null
}) {
	const who = input.clientLabel?.trim()
		? `This connection (${input.clientLabel.trim()})`
		: 'This connection'
	return `${who} is not allowed to use ${input.what}. The account owner can change per-connection access at /account/connections.`
}
