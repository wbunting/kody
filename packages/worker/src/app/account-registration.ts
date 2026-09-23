type AccountRegistrationEnv = {
	ACCOUNT_REGISTRATION?: string | undefined
}

export function isAccountRegistrationClosed(
	env: AccountRegistrationEnv,
): boolean {
	return env.ACCOUNT_REGISTRATION?.trim().toLowerCase() === 'closed'
}
