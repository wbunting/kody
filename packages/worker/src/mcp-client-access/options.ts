import {
	alwaysAllowedMcpClientDomains,
	type McpClientAccessPolicy,
} from '@kody-internal/shared/mcp-client-access.ts'
import { type McpClientAccessOptions } from '#universal/loader-data.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { listSecretProviderBindings } from '#mcp/secrets/secret-providers/repo.ts'
import { listJoinedIntegrations } from '#worker/integrations/service.ts'
import { mcpServerDomainId } from '#worker/mcp-client/mcp-domain-id.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import {
	listMcpClientAccessPolicies,
	type McpClientAccessPolicyInput,
} from './repo.ts'

/**
 * Plain-language summaries for the access editor. Admin is omitted: it is
 * already gated by role, and listing it would only confuse a personal account.
 */
const builtinDomainDescriptions: Record<string, string> = {
	[capabilityDomainNames.account]: 'Usage, waiting items, account export',
	[capabilityDomainNames.apps]: 'Package app realtime sessions',
	[capabilityDomainNames.community]: 'Community listings, forks, ratings',
	[capabilityDomainNames.coding]: 'Kody guides (always on)',
	[capabilityDomainNames.email]: 'Read, send, and reply to Kody email',
	[capabilityDomainNames.integrations]: 'OAuth integrations and token refresh',
	[capabilityDomainNames.invocationTokens]: 'Package invocation tokens',
	[capabilityDomainNames.jobs]: 'Scheduled jobs and workflow runs',
	[capabilityDomainNames.mcpServers]: 'Connect/manage remote MCP servers',
	[capabilityDomainNames.meta]: 'Search, execute, memories (always on)',
	[capabilityDomainNames.packages]: 'Save, update, share, delete packages',
	[capabilityDomainNames.repo]: 'Package source repos and publishing',
	[capabilityDomainNames.runs]: 'Execution run history',
	[capabilityDomainNames.secrets]: 'Create, update, delete secrets',
	[capabilityDomainNames.storage]: 'Durable storage export and query',
	[capabilityDomainNames.values]: 'Legacy values',
	[capabilityDomainNames.webhooks]: 'Package webhooks',
}

export async function loadMcpClientAccessOptions(input: {
	env: Env
	userId: string
}): Promise<McpClientAccessOptions> {
	const [packages, secrets, integrations, providers, mcpServers] =
		await Promise.all([
			listSavedPackagesByUserId(input.env.APP_DB, { userId: input.userId }),
			listUserSecretsForSearch({ env: input.env, userId: input.userId }),
			listJoinedIntegrations({ env: input.env, userId: input.userId }),
			listSecretProviderBindings(input.env.APP_DB, {
				userId: input.userId,
			}).catch(() => []),
			listMcpServerSettings({ env: input.env, userId: input.userId }).catch(
				() => [],
			),
		])
	const domains = Object.entries(builtinDomainDescriptions)
		.map(([name, description]) => ({
			name,
			description,
			locked: alwaysAllowedMcpClientDomains.includes(name),
		}))
		.concat(
			mcpServers.map((server) => ({
				name: mcpServerDomainId(server),
				description: `Remote MCP server "${server.name}"`,
				locked: false,
			})),
		)
		.sort((left, right) => left.name.localeCompare(right.name))
	return {
		packages: packages
			.map((pkg) => ({
				id: pkg.id,
				name: pkg.name,
				description: pkg.description,
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
		domains,
		secrets: secrets
			.filter((secret) => secret.scope === 'user')
			.map((secret) => ({
				name: secret.name,
				description: secret.description ?? '',
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
		integrations: [
			...new Set(integrations.map((entry) => entry.connection.name)),
		]
			.sort()
			.map((name) => ({ name })),
		secretProviders: [...new Set(providers.map((entry) => entry.providerId))]
			.sort()
			.map((name) => ({ name })),
	}
}

export async function loadMcpClientAccessPoliciesByClientId(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Map<string, McpClientAccessPolicy>> {
	const stored = await listMcpClientAccessPolicies(input.env.APP_DB, {
		userId: input.userId,
	})
	return new Map(
		stored.map(({ updatedAt: _updatedAt, ...policy }) => [
			policy.clientId,
			policy,
		]),
	)
}

/**
 * Keep only ids/names the account actually owns so a stale form cannot
 * persist dangling entries. Allowlists still fail closed: an unknown entry is
 * simply dropped, never widened to "all".
 */
export function sanitizeMcpClientAccessPolicyInput(
	policy: McpClientAccessPolicyInput,
	options: McpClientAccessOptions,
): McpClientAccessPolicyInput {
	const packageIds = new Set(options.packages.map((pkg) => pkg.id))
	const domainNames = new Set(options.domains.map((domain) => domain.name))
	const secretNames = new Set(options.secrets.map((secret) => secret.name))
	const integrationNames = new Set(options.integrations.map((i) => i.name))
	const providerNames = new Set(options.secretProviders.map((p) => p.name))
	return {
		packageMode: policy.packageMode,
		allowedPackageIds: policy.allowedPackageIds.filter((id) =>
			packageIds.has(id),
		),
		domainMode: policy.domainMode,
		allowedDomains: policy.allowedDomains.filter(
			(name) =>
				domainNames.has(name) && !alwaysAllowedMcpClientDomains.includes(name),
		),
		credentialMode: policy.credentialMode,
		allowedSecretNames: policy.allowedSecretNames.filter((name) =>
			secretNames.has(name),
		),
		allowedIntegrations: policy.allowedIntegrations.filter((name) =>
			integrationNames.has(name),
		),
		allowedSecretProviders: policy.allowedSecretProviders.filter((name) =>
			providerNames.has(name),
		),
	}
}
