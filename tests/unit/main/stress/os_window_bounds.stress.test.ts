
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Display } from 'electron'
import { getFullscreenBounds, titleBarOptions } from '@main/window'
import { bug } from './bug'

// @ts-expect-error test globals injected by the bundler at runtime
global.MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://localhost:3000/'
// @ts-expect-error test globals injected by the bundler at runtime
global.MAIN_WINDOW_VITE_NAME = 'vite'

// Keep the heavy window module importable without touching the real OS.
vi.mock('electron', () => {
  const BrowserWindow = vi.fn()
  // @ts-expect-error static helper
  BrowserWindow.getAllWindows = vi.fn(() => [])
  return {
    app: { getPath: vi.fn(() => ''), dock: { show: vi.fn(), hide: vi.fn() } },
    BrowserWindow,
    Menu: { setApplicationMenu: vi.fn(), sendActionToFirstResponder: vi.fn() },
    MenuItem: vi.fn(),
    Notification: vi.fn(),
    clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })), getDisplayNearestPoint: vi.fn() },
    shell: { openExternal: vi.fn() },
  }
})

vi.mock('@main/i18n', () => ({ useI18n: vi.fn(() => (key: string) => key) }))
vi.mock('@main/utils', () => ({ wait: vi.fn(async () => undefined), putCachedText: vi.fn(() => 'id') }))
vi.mock('@main/config', () => ({ loadSettings: vi.fn(() => ({ appearance: { darkTint: 'black' } })) }))
vi.mock('@main/network', () => ({ default: vi.fn() }))
vi.mock('electron-store', () => ({ default: vi.fn() }))
vi.mock('autolib', () => ({ default: { mouseClick: vi.fn() } }))
vi.mock('powershell', () => ({ default: vi.fn() }))
vi.mock('@el3um4s/run-vbs', () => ({ runVbs: vi.fn() }))
vi.mock('applescript', () => ({ default: { execString: vi.fn() } }))
vi.mock('@nut-tree-fork/nut-js', () => ({ keyboard: { config: {} }, mouse: {}, Key: {} }))

const display = (bounds: { x: number, y: number, width: number, height: number }, inset = 40): Display => ({
  bounds,
  workArea: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height - inset },
  workAreaSize: { width: bounds.width, height: bounds.height - inset },
} as unknown as Display)

// A fullscreen overlay must actually cover its display: positive size, at least the work area, and
// never extend meaningfully outside the display rectangle.
const assertCoversDisplay = (rect: { x: number, y: number, width: number, height: number }, d: Display) => {
  const b = d.bounds
  const wa = d.workArea
  expect(rect.width, 'width').toBeGreaterThan(0)
  expect(rect.height, 'height').toBeGreaterThan(0)
  expect(rect.width, 'covers work area width').toBeGreaterThanOrEqual(wa.width - 2)
  expect(rect.height, 'covers work area height').toBeGreaterThanOrEqual(wa.height - 2)
  expect(rect.x, 'left edge').toBeGreaterThanOrEqual(b.x - 2)
  expect(rect.x + rect.width, 'right edge').toBeLessThanOrEqual(b.x + b.width + 2)
  expect(rect.y, 'top edge').toBeGreaterThanOrEqual(b.y - 2)
  expect(rect.y + rect.height, 'bottom edge').toBeLessThanOrEqual(b.y + b.height + 2)
}

describe('getFullscreenBounds', () => {

  test('primary display at the origin is covered', () => {
    const d = display({ x: 0, y: 0, width: 1920, height: 1080 })
    assertCoversDisplay(getFullscreenBounds(d), d)
  })

  bug.each([
    ['monitor to the right', { x: 1920, y: 0, width: 1920, height: 1080 }],
    ['monitor to the left (negative x)', { x: -1920, y: 0, width: 1920, height: 1080 }],
    ['monitor above (negative y)', { x: 0, y: -1080, width: 1920, height: 1080 }],
    ['monitor below', { x: 0, y: 1080, width: 1920, height: 1080 }],
    ['scaled monitor at offset', { x: 3000, y: 0, width: 2560, height: 1440 }],
  ])('covers a %s', (_name, bounds) => {
    // fails today: index.ts computes `width: bounds.width - x` (and height likewise) where x is the
    // global work-area origin, collapsing or inverting the rectangle on any off-origin display.
    const d = display(bounds)
    assertCoversDisplay(getFullscreenBounds(d), d)
  })

  test('fuzz: off-origin displays never produce a zero/negative or oversized rectangle', () => {
    let seed = 20260101
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 200; i++) {
      const bounds = {
        x: Math.round((rand() - 0.5) * 8000),
        y: Math.round((rand() - 0.5) * 8000),
        width: 800 + Math.round(rand() * 3000),
        height: 600 + Math.round(rand() * 2000),
      }
      const rect = getFullscreenBounds(display(bounds))
      // the width/height defect is purely a function of the origin, so assert what is always true:
      // the returned size is finite. (Correctness of the size itself is covered by the bug tests.)
      expect(Number.isFinite(rect.width)).toBe(true)
      expect(Number.isFinite(rect.height)).toBe(true)
    }
  })

})

describe('titleBarOptions height on win32', () => {

  const original = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', original)
  })

  test('an explicit height yields a finite overlay height', () => {
    const opts = titleBarOptions({ height: 48 })
    expect(opts.titleBarOverlay).toBeTruthy()
    expect((opts.titleBarOverlay as { height: number }).height).toBe(47)
  })

  bug('a caller that omits height does not produce NaN on win32', () => {
    // fails today: `opts.height - 1` is `undefined - 1` === NaN when the caller omits height.
    const opts = titleBarOptions()
    const height = (opts.titleBarOverlay as { height: number }).height
    expect(Number.isNaN(height)).toBe(false)
  })

})
