import { expect, test } from 'vitest'
import { parseDevCimdTargetUrl } from '../../../tools/vite-dev-cimd-proxy.ts'
import { isCimdClientIdUrl } from './dev-cimd-prefetch.ts'

test('only HTTPS path URLs are treated as CIMD client ids', () => {
	expect(isCimdClientIdUrl('https://chatgpt.com/oauth/client.json')).toBe(true)
	expect(isCimdClientIdUrl('https://chatgpt.com/')).toBe(false)
	expect(isCimdClientIdUrl('http://chatgpt.com/oauth/client.json')).toBe(false)
	expect(isCimdClientIdUrl('abc123')).toBe(false)
	expect(isCimdClientIdUrl(null)).toBe(false)
})

test('dev CIMD proxy refuses non-document targets', () => {
	expect(
		parseDevCimdTargetUrl('https://chatgpt.com/oauth/client.json')?.href,
	).toBe('https://chatgpt.com/oauth/client.json')
	expect(parseDevCimdTargetUrl('http://127.0.0.1:8787/x')).toBeNull()
	expect(parseDevCimdTargetUrl('https://user:pw@example.com/x')).toBeNull()
	expect(parseDevCimdTargetUrl('https://example.com:8443/x')).toBeNull()
	expect(parseDevCimdTargetUrl('https://example.com/')).toBeNull()
	expect(parseDevCimdTargetUrl('not a url')).toBeNull()
	expect(parseDevCimdTargetUrl(null)).toBeNull()
})
