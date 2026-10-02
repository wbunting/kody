import { expect, test } from 'vitest'
import {
	type McpClientAccessPolicy,
	mcpClientPolicyAllowsDomain,
	mcpClientPolicyAllowsIntegration,
	mcpClientPolicyAllowsPackage,
	mcpClientPolicyAllowsUserSecret,
	mcpClientPolicyIsRestrictive,
} from '@kody-internal/shared/mcp-client-access.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	callerCanAccessCapability,
	assertCallerCanAccessCapability,
} from '#mcp/capabilities/access-control.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import { createStableDynamicWorkerId } from '#mcp/dynamic-worker-id.ts'
import {
	assertMcpClientCanUsePackage,
	assertMcpClientCanUseUserSecret,
	McpClientAccessDeniedError,
} from './enforce.ts'
import { runWithMcpClientAccess } from './scope.ts'
import { createUnrestrictedMcpClientAccess } from './service.ts'

function trainerPolicy(
	overrides: Partial<McpClientAccessPolicy> = {},
): McpClientAccessPolicy {
	return {
		...createUnrestrictedMcpClientAccess('trainer-client'),
		packageMode: 'allowlist',
		allowedPackageIds: ['pkg-obsidian'],
		domainMode: 'allowlist',
		allowedDomains: ['runs'],
		credentialMode: 'allowlist',
		allowedSecretNames: ['obsidianToken'],
		allowedIntegrations: [],
		allowedSecretProviders: [],
		...overrides,
	}
}

function capabilityInDomain(domain: string): Capability {
	return {
		name: `${domain}Probe`,
		domain,
		description: 'probe',
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: 'type ProbeInput = Record<string, never>',
		async handler() {
			return { ok: true }
		},
	}
}

const user = {
	userId: 'user-1',
	email: 'will@example.com',
	displayName: 'Will',
	roles: ['user'],
	permissions: [],
}

test('no policy and unrestricted policy keep the full grant', () => {
	for (const policy of [null, createUnrestrictedMcpClientAccess('c')]) {
		expect(mcpClientPolicyIsRestrictive(policy)).toBe(false)
		expect(mcpClientPolicyAllowsPackage(policy, 'anything')).toBe(true)
		expect(mcpClientPolicyAllowsDomain(policy, 'email')).toBe(true)
		expect(mcpClientPolicyAllowsUserSecret(policy, 'slackToken')).toBe(true)
		expect(mcpClientPolicyAllowsIntegration(policy, 'slack')).toBe(true)
	}
})

test('allowlists fail closed and keep meta/coding available', () => {
	const policy = trainerPolicy()
	expect(mcpClientPolicyIsRestrictive(policy)).toBe(true)
	expect(mcpClientPolicyAllowsPackage(policy, 'pkg-obsidian')).toBe(true)
	expect(mcpClientPolicyAllowsPackage(policy, 'pkg-slack')).toBe(false)
	expect(mcpClientPolicyAllowsPackage(policy, null)).toBe(false)
	expect(mcpClientPolicyAllowsDomain(policy, 'meta')).toBe(true)
	expect(mcpClientPolicyAllowsDomain(policy, 'coding')).toBe(true)
	expect(mcpClientPolicyAllowsDomain(policy, 'runs')).toBe(true)
	expect(mcpClientPolicyAllowsDomain(policy, 'email')).toBe(false)
	expect(mcpClientPolicyAllowsDomain(policy, 'mcp:slack')).toBe(false)
	expect(mcpClientPolicyAllowsUserSecret(policy, 'obsidianToken')).toBe(true)
	expect(mcpClientPolicyAllowsUserSecret(policy, 'slackBrowserXoxc')).toBe(
		false,
	)
	expect(mcpClientPolicyAllowsIntegration(policy, 'slack')).toBe(false)
})

test('capability access honors the per-client domain allowlist', async () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user,
		clientAccess: trainerPolicy(),
	})
	expect(
		callerCanAccessCapability(callerContext, capabilityInDomain('meta')),
	).toBe(true)
	expect(
		callerCanAccessCapability(callerContext, capabilityInDomain('runs')),
	).toBe(true)
	expect(
		callerCanAccessCapability(callerContext, capabilityInDomain('email')),
	).toBe(false)
	await expect(
		assertCallerCanAccessCapability(callerContext, capabilityInDomain('email')),
	).rejects.toThrow(/not allowed to use capability "emailProbe"/)
})

test('nested runs without a stamped policy inherit the ambient one', () => {
	// Package runs rebuild their caller context from the actor user id.
	const rebuilt = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user,
	})
	expect(callerCanAccessCapability(rebuilt, capabilityInDomain('email'))).toBe(
		true,
	)
	runWithMcpClientAccess(trainerPolicy(), () => {
		expect(
			callerCanAccessCapability(rebuilt, capabilityInDomain('email')),
		).toBe(false)
		expect(() =>
			assertMcpClientCanUseUserSecret({
				policy: rebuilt,
				name: 'slackBrowserXoxc',
			}),
		).toThrow(McpClientAccessDeniedError)
		expect(() =>
			assertMcpClientCanUseUserSecret({
				policy: rebuilt,
				name: 'obsidianToken',
			}),
		).not.toThrow()
	})
})

test('package gate names the denied package', () => {
	expect(() =>
		assertMcpClientCanUsePackage({
			policy: trainerPolicy(),
			packageId: 'pkg-slack',
			packageName: '@will/slack-send-once',
		}),
	).toThrow(/package "@will\/slack-send-once"/)
	expect(() =>
		assertMcpClientCanUsePackage({
			policy: trainerPolicy(),
			packageId: 'pkg-obsidian',
			packageName: '@will/obsidian',
		}),
	).not.toThrow()
})

test('dynamic worker ids differ per client policy and are unchanged without one', async () => {
	const workerOptions = {
		compatibilityDate: '2026-01-01',
		compatibilityFlags: [],
		mainModule: 'main.js',
		modules: { 'main.js': 'export default {}' },
	}
	const base = {
		userId: 'user-1',
		storageContext: null,
		workerOptions,
	}
	const withoutPolicy = await createStableDynamicWorkerId(base)
	const withNullPolicy = await createStableDynamicWorkerId({
		...base,
		clientAccess: null,
	})
	const trainer = await createStableDynamicWorkerId({
		...base,
		clientAccess: trainerPolicy(),
	})
	const other = await createStableDynamicWorkerId({
		...base,
		clientAccess: trainerPolicy({ allowedSecretNames: ['slackBrowserXoxc'] }),
	})
	expect(withNullPolicy).toBe(withoutPolicy)
	expect(trainer).not.toBe(withoutPolicy)
	expect(trainer).not.toBe(other)
})
