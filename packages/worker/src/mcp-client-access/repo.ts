import { type McpClientAccessPolicy } from '@kody-internal/shared/mcp-client-access.ts'

type PolicyRow = {
	client_id: string
	package_mode: string
	allowed_package_ids_json: string
	domain_mode: string
	allowed_domains_json: string
	credential_mode: string
	allowed_secret_names_json: string
	allowed_integrations_json: string
	allowed_secret_providers_json: string
	updated_at: string
}

export type StoredMcpClientAccessPolicy = McpClientAccessPolicy & {
	updatedAt: string
}

export type McpClientAccessPolicyInput = Omit<McpClientAccessPolicy, 'clientId'>

const selectColumns = `client_id, package_mode, allowed_package_ids_json,
	domain_mode, allowed_domains_json, credential_mode,
	allowed_secret_names_json, allowed_integrations_json,
	allowed_secret_providers_json, updated_at`

function parseStringArray(value: string | null | undefined): Array<string> {
	if (!value) return []
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return [
			...new Set(
				parsed
					.filter((entry): entry is string => typeof entry === 'string')
					.map((entry) => entry.trim())
					.filter(Boolean),
			),
		].sort()
	} catch {
		return []
	}
}

function parseMode(value: string): 'all' | 'allowlist' {
	// Fail closed: an unknown stored mode narrows rather than widens.
	return value === 'all' ? 'all' : 'allowlist'
}

function rowToPolicy(row: PolicyRow): StoredMcpClientAccessPolicy {
	return {
		clientId: row.client_id,
		packageMode: parseMode(row.package_mode),
		allowedPackageIds: parseStringArray(row.allowed_package_ids_json),
		domainMode: parseMode(row.domain_mode),
		allowedDomains: parseStringArray(row.allowed_domains_json),
		credentialMode: parseMode(row.credential_mode),
		allowedSecretNames: parseStringArray(row.allowed_secret_names_json),
		allowedIntegrations: parseStringArray(row.allowed_integrations_json),
		allowedSecretProviders: parseStringArray(row.allowed_secret_providers_json),
		updatedAt: row.updated_at,
	}
}

function normalizeList(values: ReadonlyArray<string>) {
	return JSON.stringify(
		[...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(),
	)
}

export async function getMcpClientAccessPolicy(
	db: D1Database,
	input: { userId: string; clientId: string },
): Promise<StoredMcpClientAccessPolicy | null> {
	const row = await db
		.prepare(
			`SELECT ${selectColumns} FROM mcp_client_access_policies
			 WHERE user_id = ? AND client_id = ?`,
		)
		.bind(input.userId, input.clientId)
		.first<PolicyRow>()
	return row ? rowToPolicy(row) : null
}

export async function listMcpClientAccessPolicies(
	db: D1Database,
	input: { userId: string },
): Promise<Array<StoredMcpClientAccessPolicy>> {
	const result = await db
		.prepare(
			`SELECT ${selectColumns} FROM mcp_client_access_policies
			 WHERE user_id = ? ORDER BY client_id`,
		)
		.bind(input.userId)
		.all<PolicyRow>()
	return (result.results ?? []).map(rowToPolicy)
}

export async function upsertMcpClientAccessPolicy(
	db: D1Database,
	input: {
		userId: string
		clientId: string
		policy: McpClientAccessPolicyInput
	},
): Promise<StoredMcpClientAccessPolicy> {
	const { policy } = input
	await db
		.prepare(
			`INSERT INTO mcp_client_access_policies (
				user_id, client_id, package_mode, allowed_package_ids_json,
				domain_mode, allowed_domains_json, credential_mode,
				allowed_secret_names_json, allowed_integrations_json,
				allowed_secret_providers_json, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT (user_id, client_id) DO UPDATE SET
				package_mode = excluded.package_mode,
				allowed_package_ids_json = excluded.allowed_package_ids_json,
				domain_mode = excluded.domain_mode,
				allowed_domains_json = excluded.allowed_domains_json,
				credential_mode = excluded.credential_mode,
				allowed_secret_names_json = excluded.allowed_secret_names_json,
				allowed_integrations_json = excluded.allowed_integrations_json,
				allowed_secret_providers_json = excluded.allowed_secret_providers_json,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.userId,
			input.clientId,
			policy.packageMode,
			normalizeList(policy.allowedPackageIds),
			policy.domainMode,
			normalizeList(policy.allowedDomains),
			policy.credentialMode,
			normalizeList(policy.allowedSecretNames),
			normalizeList(policy.allowedIntegrations),
			normalizeList(policy.allowedSecretProviders),
		)
		.run()
	const stored = await getMcpClientAccessPolicy(db, input)
	if (!stored) {
		throw new Error('Failed to persist MCP client access policy.')
	}
	return stored
}

export async function deleteMcpClientAccessPolicy(
	db: D1Database,
	input: { userId: string; clientId: string },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM mcp_client_access_policies
			 WHERE user_id = ? AND client_id = ?`,
		)
		.bind(input.userId, input.clientId)
		.run()
	return (result.meta?.changes ?? 0) > 0
}
