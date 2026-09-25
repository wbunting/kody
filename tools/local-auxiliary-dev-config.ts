import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { localizeMigrations } from './local-dev-migrations.ts'

type JsonRecord = Record<string, unknown>

export async function writeLocalAuxiliaryDevConfig({
	configPath,
	envName,
	workerName,
	mainWorkerDevName,
}: {
	configPath: string
	envName: string
	workerName: string
	mainWorkerDevName: string
}) {
	const sourceText = await readFile(configPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${configPath} is missing "env".`)
	}
	const selectedEnv = (envs as JsonRecord)[envName]
	if (!selectedEnv || typeof selectedEnv !== 'object') {
		throw new Error(`${configPath} is missing "env.${envName}".`)
	}
	const envRecord = selectedEnv as JsonRecord
	// Vite's Cloudflare plugin registers auxiliary workers by this resolved
	// worker name. Keep it equal to the origin's service binding target instead
	// of Wrangler's default `<name>-<env>` suffix.
	envRecord.name = workerName

	const services = envRecord.services
	if (Array.isArray(services)) {
		for (const service of services) {
			if (!service || typeof service !== 'object') continue
			const record = service as JsonRecord
			if (record.service === 'kody-production' || record.service === 'kody') {
				record.service = mainWorkerDevName
			}
		}
	}

	if (config.migrations !== undefined || envRecord.migrations !== undefined) {
		const localized = localizeMigrations(
			envRecord.migrations ?? config.migrations,
		)
		config.migrations = localized
		envRecord.migrations = localized
	}

	const outputPath = path.join(
		path.dirname(configPath),
		'wrangler-local-dev.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
