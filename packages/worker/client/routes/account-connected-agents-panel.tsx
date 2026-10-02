import { type Handle, type RemixNode, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import {
	ConnectionAccessEditor,
	createAccessDraft,
	type McpClientAccessDraft,
	summarizeAccess,
} from '#client/routes/account-connection-access-editor.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import {
	AccountManagementPanel,
	TimestampValue,
	accountActionsCss,
} from '#client/routes/account-management-components.tsx'
import { toast } from '#client/toast.ts'
import {
	connectedAgentConnectionLabel,
	groupConnectedAgents,
} from '#universal/connected-mcp-agents.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
	type McpClientAccessOptions,
} from '#universal/loader-data.ts'
import { renderIcon } from '#universal/icon.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getLogoWellCss,
	getSwapLabelCss,
	mergeCss,
} from '#universal/styles/style-primitives.ts'

export function createAccountConnectedAgents(handle: Handle) {
	let agents: Array<AccountConnectedAgentListItem> = []
	let accessOptions: McpClientAccessOptions | null = null
	const accessDrafts = new Map<string, McpClientAccessDraft>()
	const openAccessEditors = new Set<string>()
	const savingAccess = new Set<string>()
	const pendingRevokes = new Set<string>()
	const revokeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()

	function getRevokeCheck(clientId: string) {
		const existing = revokeChecks.get(clientId)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		revokeChecks.set(clientId, created)
		return created
	}

	function visibleAgents(next: Array<AccountConnectedAgentListItem>) {
		if (pendingRevokes.size === 0) return next
		return next.filter((agent) => !pendingRevokes.has(agent.clientId))
	}

	function applyPayload(payload: AccountConnectedAgentsLoaderData) {
		agents = visibleAgents(payload.agents)
		accessOptions = payload.accessOptions ?? null
		// Drop drafts for editors that are closed so a reopen starts from the
		// saved policy rather than a stale edit.
		for (const clientId of accessDrafts.keys()) {
			if (!openAccessEditors.has(clientId)) accessDrafts.delete(clientId)
		}
	}

	function readAccessDraft(agent: AccountConnectedAgentListItem) {
		const existing = accessDrafts.get(agent.clientId)
		if (existing) return existing
		const created = createAccessDraft(agent.access)
		accessDrafts.set(agent.clientId, created)
		return created
	}

	function toggleAccessEditor(agent: AccountConnectedAgentListItem) {
		if (openAccessEditors.has(agent.clientId)) {
			openAccessEditors.delete(agent.clientId)
			accessDrafts.delete(agent.clientId)
		} else {
			openAccessEditors.add(agent.clientId)
			accessDrafts.set(agent.clientId, createAccessDraft(agent.access))
		}
		handle.update()
	}

	async function submitAccess(
		clientId: string,
		body: Record<string, unknown>,
		successMessage: string,
	) {
		savingAccess.add(clientId)
		handle.update()
		try {
			const response = await fetch(connectedAgentsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ clientId, ...body }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountConnectedAgentsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save access.')
			}
			accessDrafts.delete(clientId)
			openAccessEditors.delete(clientId)
			applyPayload(payload)
			toast.success(successMessage)
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : 'Unable to save access.',
			)
		} finally {
			savingAccess.delete(clientId)
			handle.update()
		}
	}

	async function revokeAgent(clientId: string) {
		const removed = agents.find((agent) => agent.clientId === clientId)
		if (!removed) return

		agents = agents.filter((agent) => agent.clientId !== clientId)
		revokeChecks.get(clientId)?.reset()
		revokeChecks.delete(clientId)
		pendingRevokes.add(clientId)
		handle.update()
		try {
			const response = await fetch(connectedAgentsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ intent: 'revoke', clientId }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountConnectedAgentsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke this agent.')
			}
			pendingRevokes.delete(clientId)
			// Keep the optimistic list. Replacing from this response can put
			// back a sibling that already committed if that POST listed earlier.
			toast.success('Agent disconnected.')
		} catch (error) {
			pendingRevokes.delete(clientId)
			if (!agents.some((agent) => agent.clientId === clientId)) {
				agents = [...agents, removed]
			}
			toast.error(
				error instanceof Error ? error.message : 'Unable to revoke this agent.',
			)
		} finally {
			pendingRevokes.delete(clientId)
			handle.update()
		}
	}

	return {
		applyPayload,
		revokeAgent,
		/** `actions` renders under the list (the Connections list page puts Add connection there). */
		render(options?: { actions?: RemixNode }) {
			const groups = groupConnectedAgents(agents)
			return (
				<AccountManagementPanel
					title="Connected agents"
					description="AI hosts that have authorized against this Kody account. Same-named hosts are grouped. Labels are best-effort from the host name or redirect."
					ariaLabel="Connected agents"
				>
					{groups.length > 0 ? (
						<ul
							mix={css({
								listStyle: 'none',
								padding: 0,
								margin: 0,
								display: 'grid',
								gap: spacing.md,
							})}
						>
							{groups.map((group) => (
								<li
									key={group.label}
									data-testid="connected-agent-group"
									data-agent-label={group.label}
								>
									<details mix={css(groupDetailsCss)}>
										<summary mix={css(groupSummaryCss)}>
											<ConnectedAgentMark icon={group.icon} />
											<span
												mix={css({
													fontWeight: typography.fontWeight.medium,
													color: colors.text,
												})}
											>
												{group.label}
											</span>
											{group.members.length > 1 ? (
												<>
													<span
														aria-hidden="true"
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														({group.members.length})
													</span>
													<span class="visually-hidden">
														{`${group.members.length} connections`}
													</span>
												</>
											) : null}
											<span
												mix={css({
													color: colors.textMuted,
													fontSize: typography.fontSize.sm,
												})}
											>
												Last used{' '}
												<TimestampValue
													value={group.lastUsedAt}
													fallback="unknown"
												/>
												{' · '}
												Connected{' '}
												<TimestampValue
													value={group.connectedAt}
													fallback="at an unknown time"
												/>
											</span>
										</summary>
										<ul
											mix={css({
												listStyle: 'none',
												padding: 0,
												margin: 0,
												display: 'grid',
												gap: spacing.sm,
											})}
										>
											{group.members.map((agent) => {
												const revokeCheck = getRevokeCheck(agent.clientId)
												const connectionLabel = connectedAgentConnectionLabel(
													agent.clientId,
												)
												const revokeName =
													group.members.length > 1
														? `${agent.label} (${connectionLabel})`
														: agent.label
												return (
													<li
														key={agent.clientId}
														data-testid="connected-agent-connection"
														data-client-id={agent.clientId}
														mix={css(connectionRowCss)}
													>
														<span
															mix={css({ display: 'grid', gap: spacing.xs })}
														>
															<code
																title={agent.clientId}
																mix={css({
																	color: colors.text,
																	fontSize: typography.fontSize.sm,
																	overflowWrap: 'anywhere',
																})}
															>
																{connectionLabel}
															</code>
															<span
																mix={css({
																	color: colors.textMuted,
																	fontSize: typography.fontSize.sm,
																})}
															>
																Last used{' '}
																<TimestampValue
																	value={agent.lastUsedAt}
																	fallback="unknown"
																/>
															</span>
															<span
																mix={css({
																	color: colors.textMuted,
																	fontSize: typography.fontSize.sm,
																})}
															>
																Connected{' '}
																<TimestampValue
																	value={agent.connectedAt}
																	fallback="at an unknown time"
																/>
															</span>
															<span
																data-testid="connection-access-summary"
																mix={css({
																	color: colors.text,
																	fontSize: typography.fontSize.sm,
																})}
															>
																Access: {summarizeAccess(agent.access)}{' '}
																{accessOptions ? (
																	<button
																		type="button"
																		data-testid="toggle-connection-access"
																		aria-expanded={
																			openAccessEditors.has(agent.clientId)
																				? 'true'
																				: 'false'
																		}
																		mix={[
																			css(getGhostButtonCss({ size: 'sm' })),
																			on('click', () =>
																				toggleAccessEditor(agent),
																			),
																		]}
																	>
																		{openAccessEditors.has(agent.clientId)
																			? 'Close'
																			: 'Edit access'}
																	</button>
																) : null}
															</span>
															{accessOptions &&
															openAccessEditors.has(agent.clientId) ? (
																<ConnectionAccessEditor
																	clientId={agent.clientId}
																	label={revokeName}
																	options={accessOptions}
																	draft={readAccessDraft(agent)}
																	saving={savingAccess.has(agent.clientId)}
																	onDraftChange={(draft) => {
																		accessDrafts.set(agent.clientId, draft)
																		handle.update()
																	}}
																	onSave={() =>
																		void submitAccess(
																			agent.clientId,
																			{
																				intent: 'set-access',
																				policy: readAccessDraft(agent),
																			},
																			'Access saved.',
																		)
																	}
																	onReset={() =>
																		void submitAccess(
																			agent.clientId,
																			{ intent: 'clear-access' },
																			'Full access restored.',
																		)
																	}
																/>
															) : null}
														</span>
														<button
															type="button"
															aria-label={
																revokeCheck.doubleCheck
																	? `Confirm revoke ${revokeName}`
																	: `Revoke ${revokeName}`
															}
															mix={[
																css(dangerButtonCss),
																...revokeCheck.getButtonMix({
																	on: {
																		click: () => {
																			void revokeAgent(agent.clientId)
																		},
																	},
																}),
															]}
														>
															<span
																data-swap-label
																data-active={
																	revokeCheck.doubleCheck ? undefined : true
																}
																aria-hidden={
																	revokeCheck.doubleCheck ? 'true' : undefined
																}
															>
																Revoke
															</span>
															<span
																data-swap-label
																data-active={
																	revokeCheck.doubleCheck ? true : undefined
																}
																aria-hidden={
																	revokeCheck.doubleCheck ? undefined : 'true'
																}
															>
																Confirm revoke
															</span>
														</button>
													</li>
												)
											})}
										</ul>
									</details>
								</li>
							))}
						</ul>
					) : (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No agents have authorized yet. Connect one from onboarding or your
							MCP host.
						</p>
					)}
					{options?.actions ? (
						<div mix={css(accountActionsCss)}>{options.actions}</div>
					) : null}
				</AccountManagementPanel>
			)
		},
	}
}

function ConnectedAgentMark(handle: Handle<{ icon: string | null }>) {
	return () => {
		if (!handle.props.icon) {
			return (
				<span
					aria-hidden="true"
					data-testid="connected-agent-mark-fallback"
					mix={css({
						display: 'grid',
						placeItems: 'center',
						flex: 'none',
						width: '1.75rem',
						height: '1.75rem',
						color: colors.textMuted,
					})}
				>
					{renderIcon('dots-horizontal', { size: '18' })}
				</span>
			)
		}
		return (
			<span
				aria-hidden="true"
				mix={css(getLogoWellCss({ size: '1.75rem', radius: radius.md }))}
			>
				<img
					src={`/images/icons/${handle.props.icon}.svg`}
					alt=""
					width={20}
					height={20}
					mix={css({
						display: 'block',
						width: '1.15rem',
						height: '1.15rem',
						objectFit: 'contain',
					})}
				/>
			</span>
		)
	}
}

const groupDetailsCss = {
	'&[open] > summary': { marginBottom: spacing.sm },
}

const groupSummaryCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	cursor: 'pointer',
	flexWrap: 'wrap' as const,
}

const connectionRowCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'start',
	gap: spacing.md,
	paddingInlineStart: spacing.lg,
}

const dangerButtonCss = mergeCss(
	getDangerPillCss({ size: 'sm' }),
	getSwapLabelCss(),
)
