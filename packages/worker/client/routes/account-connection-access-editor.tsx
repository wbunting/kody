import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type McpClientAccessPolicy,
	mcpClientPolicyIsRestrictive,
} from '@kody-internal/shared/mcp-client-access.ts'
import { type McpClientAccessOptions } from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Per-connection access editor (self-host fork). One OAuth client = one agent
 * install. Each gate is "Full access" or "Only these"; nothing is restricted
 * until the owner saves.
 */

export type McpClientAccessDraft = Omit<McpClientAccessPolicy, 'clientId'>

export function createAccessDraft(
	policy: McpClientAccessPolicy | null | undefined,
): McpClientAccessDraft {
	return {
		packageMode: policy?.packageMode ?? 'all',
		allowedPackageIds: [...(policy?.allowedPackageIds ?? [])],
		domainMode: policy?.domainMode ?? 'all',
		allowedDomains: [...(policy?.allowedDomains ?? [])],
		credentialMode: policy?.credentialMode ?? 'all',
		allowedSecretNames: [...(policy?.allowedSecretNames ?? [])],
		allowedIntegrations: [...(policy?.allowedIntegrations ?? [])],
		allowedSecretProviders: [...(policy?.allowedSecretProviders ?? [])],
	}
}

/** One-line summary for the collapsed connection row. */
export function summarizeAccess(
	policy: McpClientAccessPolicy | null | undefined,
): string {
	if (!policy || !mcpClientPolicyIsRestrictive(policy)) return 'Full access'
	const parts: Array<string> = []
	if (policy.packageMode === 'allowlist') {
		parts.push(`${policy.allowedPackageIds.length} package(s)`)
	}
	if (policy.domainMode === 'allowlist') {
		parts.push(`${policy.allowedDomains.length} extra domain(s)`)
	}
	if (policy.credentialMode === 'allowlist') {
		const count =
			policy.allowedSecretNames.length +
			policy.allowedIntegrations.length +
			policy.allowedSecretProviders.length
		parts.push(`${count} credential(s)`)
	}
	return `Restricted: ${parts.join(', ')}`
}

function toggle(list: Array<string>, value: string) {
	return list.includes(value)
		? list.filter((entry) => entry !== value)
		: [...list, value]
}

type ModeKey = 'packageMode' | 'domainMode' | 'credentialMode'

export type AccessEditorProps = {
	clientId: string
	label: string
	options: McpClientAccessOptions
	draft: McpClientAccessDraft
	saving: boolean
	onDraftChange: (draft: McpClientAccessDraft) => void
	onSave: () => void
	onReset: () => void
}

export function ConnectionAccessEditor(handle: Handle<AccessEditorProps>) {
	return () => {
		const { clientId, label, options, draft, saving } = handle.props

		function setMode(key: ModeKey, mode: 'all' | 'allowlist') {
			handle.props.onDraftChange({ ...draft, [key]: mode })
		}

		function renderModeRadios(input: { key: ModeKey; name: string }) {
			return (
				<div mix={css({ display: 'flex', gap: spacing.md, flexWrap: 'wrap' })}>
					{(['all', 'allowlist'] as const).map((mode) => (
						<label key={mode} mix={css(inlineLabelCss)}>
							<input
								type="radio"
								name={`${input.name}-${clientId}`}
								data-testid={`access-${input.name}-${mode}`}
								checked={draft[input.key] === mode}
								disabled={saving}
								mix={[on('change', () => setMode(input.key, mode))]}
							/>
							<span>{mode === 'all' ? 'Full access' : 'Only these'}</span>
						</label>
					))}
				</div>
			)
		}

		function renderCheckList(input: {
			testId: string
			items: Array<{
				value: string
				label: string
				hint?: string
				locked?: boolean
			}>
			selected: Array<string>
			onToggle: (value: string) => void
			empty: string
		}) {
			if (input.items.length === 0) {
				return <p mix={css(hintCss)}>{input.empty}</p>
			}
			return (
				<div mix={css(checkGridCss)} data-testid={input.testId}>
					{input.items.map((item) => (
						<label key={item.value} mix={css(inlineLabelCss)}>
							<input
								type="checkbox"
								value={item.value}
								checked={item.locked || input.selected.includes(item.value)}
								disabled={saving || item.locked}
								mix={[on('change', () => input.onToggle(item.value))]}
							/>
							<span>
								<code mix={css({ fontSize: typography.fontSize.sm })}>
									{item.label}
								</code>
								{item.hint ? (
									<span mix={css(hintCss)}> — {item.hint}</span>
								) : null}
							</span>
						</label>
					))}
				</div>
			)
		}

		const credentialItems = [
			...options.secrets.map((secret) => ({
				value: `secret:${secret.name}`,
				label: secret.name,
				hint: secret.description || 'user secret',
			})),
			...options.integrations.map((integration) => ({
				value: `integration:${integration.name}`,
				label: integration.name,
				hint: 'integration',
			})),
			...options.secretProviders.map((provider) => ({
				value: `provider:${provider.name}`,
				label: provider.name,
				hint: 'secret provider',
			})),
		]
		const selectedCredentials = [
			...draft.allowedSecretNames.map((name) => `secret:${name}`),
			...draft.allowedIntegrations.map((name) => `integration:${name}`),
			...draft.allowedSecretProviders.map((name) => `provider:${name}`),
		]

		function toggleCredential(value: string) {
			const [kind, ...rest] = value.split(':')
			const name = rest.join(':')
			if (kind === 'secret') {
				handle.props.onDraftChange({
					...draft,
					allowedSecretNames: toggle(draft.allowedSecretNames, name),
				})
			} else if (kind === 'integration') {
				handle.props.onDraftChange({
					...draft,
					allowedIntegrations: toggle(draft.allowedIntegrations, name),
				})
			} else if (kind === 'provider') {
				handle.props.onDraftChange({
					...draft,
					allowedSecretProviders: toggle(draft.allowedSecretProviders, name),
				})
			}
		}

		return (
			<section
				data-testid="connection-access-editor"
				data-client-id={clientId}
				aria-label={`Access for ${label}`}
				mix={css(editorCss)}
			>
				<fieldset mix={css(fieldsetCss)}>
					<legend mix={css(legendCss)}>Packages</legend>
					<p mix={css(hintCss)}>
						Saved packages this agent can import, invoke, or see in search.
						Allowed packages keep their own dependencies.
					</p>
					{renderModeRadios({ key: 'packageMode', name: 'packages' })}
					{draft.packageMode === 'allowlist'
						? renderCheckList({
								testId: 'access-package-list',
								items: options.packages.map((pkg) => ({
									value: pkg.id,
									label: pkg.name,
									hint: pkg.description,
								})),
								selected: draft.allowedPackageIds,
								onToggle: (value) =>
									handle.props.onDraftChange({
										...draft,
										allowedPackageIds: toggle(draft.allowedPackageIds, value),
									}),
								empty:
									'No saved packages yet. With none selected this agent can run ad hoc code only.',
							})
						: null}
				</fieldset>

				<fieldset mix={css(fieldsetCss)}>
					<legend mix={css(legendCss)}>Credentials</legend>
					<p mix={css(hintCss)}>
						User secrets, integrations, and secret providers any code in this
						agent's runs may use — including package code. This is the hard
						boundary for posting to outside services.
					</p>
					{renderModeRadios({ key: 'credentialMode', name: 'credentials' })}
					{draft.credentialMode === 'allowlist'
						? renderCheckList({
								testId: 'access-credential-list',
								items: credentialItems,
								selected: selectedCredentials,
								onToggle: toggleCredential,
								empty: 'No user secrets or integrations yet.',
							})
						: null}
				</fieldset>

				<fieldset mix={css(fieldsetCss)}>
					<legend mix={css(legendCss)}>Kody capabilities</legend>
					<p mix={css(hintCss)}>
						Built-in capability domains (and remote MCP servers). Search,
						execute, memories, and guides always stay on.
					</p>
					{renderModeRadios({ key: 'domainMode', name: 'domains' })}
					{draft.domainMode === 'allowlist'
						? renderCheckList({
								testId: 'access-domain-list',
								items: options.domains.map((domain) => ({
									value: domain.name,
									label: domain.name,
									hint: domain.description,
									locked: domain.locked,
								})),
								selected: draft.allowedDomains,
								onToggle: (value) =>
									handle.props.onDraftChange({
										...draft,
										allowedDomains: toggle(draft.allowedDomains, value),
									}),
								empty: 'No capability domains available.',
							})
						: null}
				</fieldset>

				<div mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}>
					<button
						type="button"
						data-testid="save-connection-access"
						disabled={saving}
						mix={[
							css(getPillButtonCss({ size: 'sm' })),
							on('click', () => handle.props.onSave()),
						]}
					>
						{saving ? 'Saving…' : 'Save access'}
					</button>
					<button
						type="button"
						data-testid="reset-connection-access"
						disabled={saving}
						mix={[
							css(getGhostButtonCss({ size: 'sm' })),
							on('click', () => handle.props.onReset()),
						]}
					>
						Restore full access
					</button>
				</div>
			</section>
		)
	}
}

const editorCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	marginTop: spacing.sm,
}

const fieldsetCss = {
	display: 'grid',
	gap: spacing.xs,
	border: 'none',
	padding: 0,
	margin: 0,
	minWidth: 0,
}

const legendCss = {
	fontWeight: typography.fontWeight.medium,
	color: colors.text,
	padding: 0,
	marginBottom: spacing.xs,
}

const hintCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	margin: 0,
}

const inlineLabelCss = {
	display: 'flex',
	gap: spacing.xs,
	alignItems: 'baseline',
	fontSize: typography.fontSize.sm,
}

const checkGridCss = {
	display: 'grid',
	gap: spacing.xs,
	maxHeight: '18rem',
	overflowY: 'auto' as const,
	paddingInlineStart: spacing.sm,
}
