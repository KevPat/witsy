
import { expect, test, vi } from 'vitest'
import { normalizeDebugEnv } from '@main/debug_env'

vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

test('a development run keeps DEBUG as it is', () => {
  const env: NodeJS.ProcessEnv = { DEBUG: '1' }
  normalizeDebugEnv(false, env)
  expect(env.DEBUG).toBe('1')
  const none: NodeJS.ProcessEnv = {}
  normalizeDebugEnv(false, none)
  expect(none.DEBUG).toBeUndefined()
})

test('a packaged app ignores a generic DEBUG variable', () => {
  for (const value of ['1', '*', 'express:*', 'true']) {
    const env: NodeJS.ProcessEnv = { DEBUG: value }
    normalizeDebugEnv(true, env)
    expect('DEBUG' in env).toBe(false)
  }
})

test('a packaged app enters debug mode with WITSY_DEBUG only', () => {
  const env: NodeJS.ProcessEnv = { WITSY_DEBUG: '1' }
  normalizeDebugEnv(true, env)
  expect(env.DEBUG).toBe('1')
})

test('WITSY_DEBUG set to 0 or false is off', () => {
  for (const value of ['0', 'false', '']) {
    const env: NodeJS.ProcessEnv = { WITSY_DEBUG: value, DEBUG: '*' }
    normalizeDebugEnv(true, env)
    expect('DEBUG' in env).toBe(false)
  }
})
