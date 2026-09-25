import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { parseJsonc } from './ci/resource-utils.ts'
import { writeLocalAuxiliaryDevConfig } from './local-auxiliary-dev-config.ts'

test('local jobs config registers the service name and points back to the dev origin', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-local-jobs-'))
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	try {
		const source = await readFile('packages/jobs-worker/wrangler.jsonc', 'utf8')
		await writeFile(sourcePath, source)
		const outputPath = await writeLocalAuxiliaryDevConfig({
			configPath: sourcePath,
			envName: 'production',
			workerName: 'kody-jobs',
			mainWorkerDevName: 'kody-production',
		})
		const generated = parseJsonc<{
			migrations?: unknown
			env?: {
				production?: {
					name?: string
					migrations?: unknown
					services?: Array<{ service?: string }>
				}
			}
		}>(await readFile(outputPath, 'utf8'))
		expect(generated.env?.production?.name).toBe('kody-jobs')
		expect(generated.env?.production?.services).toEqual([
			expect.objectContaining({ service: 'kody-production' }),
		])
		expect(JSON.stringify(generated.migrations)).not.toContain(
			'transferred_classes',
		)
		expect(generated.migrations).toEqual(generated.env?.production?.migrations)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('local highlight config registers the service name', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-local-highlight-'))
	const sourcePath = path.join(tempDir, 'wrangler.jsonc')
	try {
		const source = await readFile(
			'packages/highlight-worker/wrangler.jsonc',
			'utf8',
		)
		await writeFile(sourcePath, source)
		const outputPath = await writeLocalAuxiliaryDevConfig({
			configPath: sourcePath,
			envName: 'production',
			workerName: 'kody-highlight',
			mainWorkerDevName: 'kody-production',
		})
		const generated = parseJsonc<{
			env?: { production?: { name?: string } }
		}>(await readFile(outputPath, 'utf8'))
		expect(generated.env?.production?.name).toBe('kody-highlight')
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})
