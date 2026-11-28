
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

type Rect = { x: number, y: number, width: number, height: number }
type Insets = { top?: number, left?: number, bottom?: number, right?: number }

// `inset` is the bottom inset (dock/taskbar); `insets` adds a menu bar (top) or a side dock/taskbar
const display = (bounds: Rect, inset = 40, insets: Insets = {}, scaleFactor = 1): Display => {
  const { top = 0, left = 0, bottom = inset, right = 0 } = insets
  const workArea = { x: bounds.x + left, y: bounds.y + top, width: bounds.width - left - right, height: bounds.height - top - bottom }
  return {
    bounds,
    workArea,
    workAreaSize: { width: workArea.width, height: workArea.height },
    scaleFactor,
  } as unknown as Display
}

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

  test.each([
    ['monitor to the right', { x: 1920, y: 0, width: 1920, height: 1080 }],
    ['monitor to the left (negative x)', { x: -1920, y: 0, width: 1920, height: 1080 }],
    ['monitor above (negative y)', { x: 0, y: -1080, width: 1920, height: 1080 }],
    ['monitor below', { x: 0, y: 1080, width: 1920, height: 1080 }],
    ['scaled monitor at offset', { x: 3000, y: 0, width: 2560, height: 1440 }],
  ])('covers a %s', (_name, bounds) => {
    // used to fail: index.ts computed `width: bounds.width - x` (and height likewise) where x is the
    // global work-area origin, collapsing or inverting the rectangle on any off-origin display.
    const d = display(bounds)
    assertCoversDisplay(getFullscreenBounds(d), d)
  })

  test('primary display: from the work area origin (minus 1px) to the bottom right corner', () => {
    // macOS-like: 25px menu bar, dock at the bottom
    const d = display({ x: 0, y: 0, width: 1024, height: 768 }, 0, { top: 25, bottom: 70 })
    expect(getFullscreenBounds(d)).toStrictEqual({ x: 0, y: 24, width: 1024, height: 744 })
  })

  test('primary display with a dock/taskbar on the left', () => {
    const d = display({ x: 0, y: 0, width: 1920, height: 1080 }, 0, { top: 25, left: 80 })
    expect(getFullscreenBounds(d)).toStrictEqual({ x: 80, y: 24, width: 1840, height: 1056 })
  })

  test.each([
    ['right of the primary', { x: 1920, y: 0, width: 2560, height: 1440 }, { top: 25 }, 2,
      { x: 1920, y: 24, width: 2560, height: 1416 }],
    ['left of and above the primary (negative origin)', { x: -2560, y: -360, width: 2560, height: 1440 }, { top: 25, left: 80 }, 1.5,
      { x: -2480, y: -336, width: 2480, height: 1416 }],
    ['below the primary, taskbar on the right', { x: 200, y: 1080, width: 1280, height: 720 }, { right: 60 }, 1.25,
      { x: 200, y: 1079, width: 1280, height: 721 }],
    ['above the primary, no menu bar or dock', { x: -100, y: -2160, width: 3840, height: 2160 }, {}, 1,
      { x: -100, y: -2161, width: 3840, height: 2161 }],
  ])('secondary display %s: absolute screen coordinates of that display', (_name, bounds, insets, scaleFactor, expected) => {
    const d = display(bounds, 0, insets, scaleFactor)
    const rect = getFullscreenBounds(d)
    expect(rect).toStrictEqual(expected)
    // the rectangle always ends at the bottom right corner of the display
    expect(rect.x + rect.width).toBe(bounds.x + bounds.width)
    expect(rect.y + rect.height).toBe(bounds.y + bounds.height)
    assertCoversDisplay(rect, d)
  })

  test('fuzz: displays anywhere on the virtual screen are covered, whatever their size, insets and scale', () => {
    let seed = 20260101
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 200; i++) {
      const bounds = {
        x: Math.round((rand() - 0.5) * 8000),
        y: Math.round((rand() - 0.5) * 8000),
        width: 800 + Math.round(rand() * 3000),
        height: 600 + Math.round(rand() * 2000),
      }
      const insets = {
        top: Math.round(rand() * 60),
        left: Math.round(rand() * 100),
        bottom: Math.round(rand() * 100),
        right: Math.round(rand() * 100),
      }
      const d = display(bounds, 0, insets, [1, 1.25, 1.5, 2, 3][i % 5])
      const rect = getFullscreenBounds(d)
      expect(Number.isFinite(rect.width)).toBe(true)
      expect(Number.isFinite(rect.height)).toBe(true)
      expect(rect.x).toBe(d.workArea.x)
      expect(rect.x + rect.width).toBe(bounds.x + bounds.width)
      expect(rect.y + rect.height).toBe(bounds.y + bounds.height)
      assertCoversDisplay(rect, d)
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
