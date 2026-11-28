
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { desktopCapturer } from 'electron'
import nut from '@main/automations/computer_nut'
import Computer from '@main/computer'
import { bug } from './bug'

const keyboard = { config: { autoDelayMs: 0 }, pressKey: vi.fn(async () => undefined), releaseKey: vi.fn(async () => undefined), type: vi.fn(async () => undefined) }
const mouse = { getPosition: vi.fn(), setPosition: vi.fn(), leftClick: vi.fn() }

vi.mock('@nut-tree-fork/nut-js', async () => ({
  keyboard, mouse,
  Key: (await vi.importActual<typeof import('@nut-tree-fork/shared')>('@nut-tree-fork/shared')).Key,
}))

const display = { size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => display),
    getAllDisplays: vi.fn(() => [display]),
  },
  desktopCapturer: { getSources: vi.fn() },
}))

const thumbnail = {
  resize: vi.fn(() => ({ toJPEG: vi.fn(() => ({ toString: vi.fn(() => 'BASE64DATA') })) })),
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('computer_nut key mapping', () => {

  test('a mapped key (Return) is pressed', async () => {
    await nut.isAvailable()
    await nut.key('Return')
    expect(keyboard.pressKey).toHaveBeenCalled()
  })

  test('a common key (Tab) can be pressed', async () => {
    // failed before L-03: keyMap only contained { Return: Enter }, so any other key name threw
    // "Tried to press unknown key" and the computer-use key action silently failed.
    await nut.isAvailable()
    const outcome = await nut.key('Tab').then(() => 'ok').catch((e: Error) => e.message)
    expect(outcome).toBe('ok')
  })

})

describe('computer takeScreenshot source selection', () => {

  test('captures when the source has an English name', async () => {
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ name: 'Entire Screen', thumbnail }] as any)
    const result = await Computer.takeScreenshot()
    expect(typeof result).toBe('string')
    expect(result).toBe('BASE64DATA')
  })

  bug('captures the screen even when the source name is localized', async () => {
    // fails today: the source is matched by the literal English names only, so on a localized OS
    // (or a second monitor named differently) mainSource is undefined and the capture returns null.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ name: 'Pantalla 1', thumbnail }] as any)
    const result = await Computer.takeScreenshot()
    expect(typeof result).toBe('string')
  })

})
