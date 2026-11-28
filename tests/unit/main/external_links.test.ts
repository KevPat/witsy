
import { beforeEach, expect, test, vi } from 'vitest'
import { shell } from 'electron'
import { isSafeExternalUrl, openExternalUrl } from '@main/external_links'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => {}) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

test('accepts http, https and mailto', () => {
  expect(isSafeExternalUrl('http://example.com')).toBe(true)
  expect(isSafeExternalUrl('https://example.com/a?b=c#d')).toBe(true)
  expect(isSafeExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true)
  expect(isSafeExternalUrl('mailto:someone@example.com')).toBe(true)
})

test.each([
  'file:///etc/passwd',
  'file://C:/Windows/System32/calc.exe',
  'smb://server/share',
  'ms-msdt:/id PCWDiagnostic',
  'search-ms:query=x',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vscode://file/etc/passwd',
  'x-apple.systempreferences:',
  '\\\\server\\share\\file.exe',
  '/etc/passwd',
  'C:\\Windows\\System32\\calc.exe',
  'not a url',
  '',
])('refuses %s', (url) => {
  expect(isSafeExternalUrl(url)).toBe(false)
})

test('refuses values that are not strings', () => {
  expect(isSafeExternalUrl(undefined)).toBe(false)
  expect(isSafeExternalUrl(null)).toBe(false)
  expect(isSafeExternalUrl({ toString: () => 'https://example.com' })).toBe(false)
})

test('opens allowed urls', async () => {
  expect(await openExternalUrl('https://example.com')).toBe(true)
  expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
})

test('does not open refused urls', async () => {
  expect(await openExternalUrl('file:///etc/passwd')).toBe(false)
  expect(await openExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
  expect(shell.openExternal).not.toHaveBeenCalled()
})

test('reports a failure of the operating system as false', async () => {
  vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('no handler'))
  expect(await openExternalUrl('https://example.com')).toBe(false)
})
