
import { beforeEach, expect, test, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { classifyRenderProcessGone, classifyUncaughtException, handleRenderProcessGone } from '@main/crash'

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

test('pipe errors are ignored', () => {
  expect(classifyUncaughtException(new Error('write EPIPE'), true)).toBe('ignore')
  expect(classifyUncaughtException(new Error('EBADF: bad file descriptor'), false)).toBe('ignore')
  expect(classifyUncaughtException(Object.assign(new Error('broken'), { code: 'EPIPE' }), true)).toBe('ignore')
})

test('an exception during startup is fatal, a later one is logged', () => {
  expect(classifyUncaughtException(new Error('boom'), false)).toBe('fatal')
  expect(classifyUncaughtException(new Error('boom'), true)).toBe('log')
})

test('errors without a message are classified without throwing', () => {
  expect(classifyUncaughtException(undefined, true)).toBe('log')
  expect(classifyUncaughtException(null, false)).toBe('fatal')
  expect(classifyUncaughtException('a string', true)).toBe('log')
  expect(classifyUncaughtException({ message: 42 }, true)).toBe('log')
})

test('a renderer that exits cleanly is ignored', () => {
  expect(classifyRenderProcessGone({}, { reason: 'clean-exit' }, { debug: false, isMainWindow: true })).toBe('ignore')
  expect(classifyRenderProcessGone({}, { reason: 'clean-exit' }, { debug: true, isMainWindow: true })).toBe('ignore')
})

test('when debugging a dead renderer still quits the app', () => {
  expect(classifyRenderProcessGone({}, { reason: 'killed' }, { debug: true, isMainWindow: false })).toBe('quit')
})

test('a secondary window that crashes is closed, the app is not quit', () => {
  expect(classifyRenderProcessGone({}, { reason: 'crashed' }, { debug: false, isMainWindow: false })).toBe('close')
})

test('the main window is reloaded once, then closed if it crashes again right away', () => {
  const webContents = {}
  expect(classifyRenderProcessGone(webContents, { reason: 'crashed' }, { debug: false, isMainWindow: true, now: 1000 })).toBe('reload')
  expect(classifyRenderProcessGone(webContents, { reason: 'crashed' }, { debug: false, isMainWindow: true, now: 3000 })).toBe('close')
  expect(classifyRenderProcessGone(webContents, { reason: 'oom' }, { debug: false, isMainWindow: true, now: 60000 })).toBe('reload')
})

test('handler reloads the main window and never quits', () => {
  const webContents = { reload: vi.fn() }
  const mainWindow = { isDestroyed: vi.fn(() => false), destroy: vi.fn() }
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mainWindow as any)
  const quit = vi.fn()
  const action = handleRenderProcessGone(webContents as any, { reason: 'crashed', exitCode: 1 }, { debug: false, mainWindow: mainWindow as any, quit })
  expect(action).toBe('reload')
  expect(webContents.reload).toHaveBeenCalled()
  expect(mainWindow.destroy).not.toHaveBeenCalled()
  expect(quit).not.toHaveBeenCalled()
})

test('handler destroys a secondary window and never quits', () => {
  const webContents = { reload: vi.fn() }
  const other = { isDestroyed: vi.fn(() => false), destroy: vi.fn() }
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(other as any)
  const quit = vi.fn()
  const action = handleRenderProcessGone(webContents as any, { reason: 'crashed', exitCode: 1 }, { debug: false, mainWindow: {} as any, quit })
  expect(action).toBe('close')
  expect(other.destroy).toHaveBeenCalled()
  expect(webContents.reload).not.toHaveBeenCalled()
  expect(quit).not.toHaveBeenCalled()
})

test('handler survives a web contents that has no window', () => {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null)
  const quit = vi.fn()
  expect(handleRenderProcessGone({ reload: vi.fn() } as any, { reason: 'crashed', exitCode: 1 }, { debug: false, mainWindow: null, quit })).toBe('close')
  expect(quit).not.toHaveBeenCalled()
})

test('handler quits when debugging', () => {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null)
  const quit = vi.fn()
  expect(handleRenderProcessGone({ reload: vi.fn() } as any, { reason: 'killed', exitCode: 1 }, { debug: true, mainWindow: null, quit })).toBe('quit')
  expect(quit).toHaveBeenCalled()
})
