import { env as workerEnv } from 'cloudflare:workers'
import {
	resolvePlanLimits,
	resolvePlanLimit,
	type EntitlementResource,
	type EntitlementLadder,
	type PlanLimits,
	type PlanName,
} from '#universal/plans.ts'

export type SelfhostPolicyEnv = { PLAN_LIMITS?: string }

/** Operator-only deployment policy, never a caller-controlled option. */
export function arePlanLimitsDisabled(
	env: SelfhostPolicyEnv = workerEnv,
): boolean {
	return env.PLAN_LIMITS?.trim().toLowerCase() === 'off'
}

/** JSON/RPC-safe ceiling; Infinity would serialize to null. */
export const unlimitedPlanCeiling = Number.MAX_SAFE_INTEGER

export function resolveDeploymentPlanLimits(
	plan: PlanName,
	ladder: EntitlementLadder = 'public',
	env?: SelfhostPolicyEnv,
): PlanLimits {
	const limits = resolvePlanLimits(plan, ladder)
	if (!arePlanLimitsDisabled(env)) return limits
	return Object.fromEntries(
		Object.entries(limits).map(([key]) => [
			key,
			key === 'minJobIntervalMs'
				? 0
				: key.endsWith('PerWeek')
					? null
					: key === 'maxEmailMessageBytes'
						? 768 * 1024
						: unlimitedPlanCeiling,
		]),
	) as PlanLimits
}

export function resolveDeploymentPlanLimit(
	plan: PlanName,
	resource: EntitlementResource,
	ladder: EntitlementLadder = 'public',
): number {
	if (!arePlanLimitsDisabled()) return resolvePlanLimit(plan, resource, ladder)
	return resource === 'email_message_bytes' ? 768 * 1024 : unlimitedPlanCeiling
}
