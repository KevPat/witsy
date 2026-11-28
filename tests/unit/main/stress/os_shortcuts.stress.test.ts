
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { globalShortcut } from 'electron'
import { disabledShortcutKey } from '@/types/index'
import { registerShortcuts, shortcutAccelerator } from '@main/shortcuts'
import { bug } from './bug'

let config: any = { shortcuts: {} }

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregisterAll: vi.fn(),
  },
}))

vi.mock('@main/config', () => ({ loadSettings: vi.fn(() => config) }))

const callbackNames = ['prompt', 'chat', 'command', 'readaloud', 'dictation', 'audioBooth', 'scratchpad', 'realtime', 'studio', 'forge']
const makeCallbacks = () => Object.fromEntries(callbackNames.map(n => [n, vi.fn()]))

beforeEach(() => {
  vi.clearAllMocks()
  config = { shortcuts: {} }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shortcutAccelerator', () => {

  test('builds an Electron accelerator from an electron shortcut', () => {
    expect(shortcutAccelerator({ type: 'electron', ctrl: true, shift: true, key: 'A' } as any)).toBe('Control+Shift+A')
    expect(shortcutAccelerator({ type: 'electron', meta: true, key: 'Space' } as any)).toBe('Command+Space')
  })

  test('returns null for native shortcuts (handled by the key monitor, not Electron)', () => {
    expect(shortcutAccelerator({ type: 'native', leftControl: true } as any)).toBeNull()
  })

  test('returns null for a disabled or missing shortcut', () => {
    expect(shortcutAccelerator({ type: 'electron', key: disabledShortcutKey } as any)).toBeNull()
    expect(shortcutAccelerator(null)).toBeNull()
  })

})

describe('registerShortcuts', () => {

  test('registers an electron shortcut with Electron', () => {
    config = { shortcuts: { prompt: { type: 'electron', meta: true, key: 'Space' } } }
    registerShortcuts({} as any, makeCallbacks() as any)
    expect(globalShortcut.register).toHaveBeenCalledWith('Command+Space', expect.any(Function))
  })

  test('does not ask Electron to register native shortcuts', () => {
    config = { shortcuts: { prompt: { type: 'native', leftControl: true } } }
    registerShortcuts({} as any, makeCallbacks() as any)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  bug('surfaces a registration the OS refuses (register returns false)', () => {
    // fails today: globalShortcut.register returns false (no throw) when the OS already owns the
    // accelerator; shortcuts.ts ignores the boolean, so the failure is silently swallowed.
    vi.mocked(globalShortcut.register).mockReturnValue(false as any)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    config = { shortcuts: { prompt: { type: 'electron', meta: true, key: 'Space' } } }
    registerShortcuts({} as any, makeCallbacks() as any)
    expect(globalShortcut.register).toHaveBeenCalled()
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0)
  })

})
