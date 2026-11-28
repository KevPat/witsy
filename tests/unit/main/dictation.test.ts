
import { vi, afterEach, beforeEach, describe, expect, test } from 'vitest'
import Dictation from '@main/automations/dictation'
import Automator from '@main/automations/automator'
import * as window from '@main/window'

// the events the code under test listens to on the main window
const { mainWindowHandlers } = vi.hoisted(() => ({ mainWindowHandlers: {} as Record<string, (() => void)[]> }))

// mock windows
vi.mock('@main/window.ts', async () => {
  return {
    mainWindow: {
      minimize: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: vi.fn((event: string, handler: () => void) => {
        mainWindowHandlers[event] = [...(mainWindowHandlers[event] ?? []), handler]
      }),
    },
    dictationWindow: null,
    releaseFocus: vi.fn(),
    openDictationWindow: vi.fn(),
    openAudioBooth: vi.fn(),
    isMainWindowFocused: vi.fn(() => false),
  }
})

const emitOnMainWindow = (event: string) => {
  for (const handler of mainWindowHandlers[event] ?? []) handler()
}

const platform = process.platform
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value, configurable: true })

const editor = { id: 'com.example.editor', name: 'Editor', path: '/Applications/Editor.app', window: 'notes.txt' }
const browser = { id: 'com.example.browser', name: 'Browser', path: '/Applications/Browser.app', window: 'Home' }
const ourselves = { id: 'com.example.witsy', name: 'Witsy', path: process.execPath, window: 'Witsy' }

beforeEach(() => {
  vi.clearAllMocks()
  setPlatform('darwin')
  // nothing is remembered from one test to the next
  emitOnMainWindow('blur')
})

afterEach(() => {
  setPlatform(platform)
})

test('Open dictation window', async () => {
  await Dictation.initDictation()
  expect(window.openDictationWindow).toHaveBeenCalledWith({ sourceApp: expect.anything() })
})

test('Insert transcription', async () => {
  await Dictation.insertTranscription('Hello, World!')
  expect(window.mainWindow.minimize).toHaveBeenCalled()
  expect(window.releaseFocus).toHaveBeenCalled()
  expect(Automator.prototype.pasteText).toHaveBeenLastCalledWith('Hello, World!')
})

describe('Audio Booth', () => {

  test('Opening it from another app records that app before the main window takes the focus', async () => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    expect(window.openAudioBooth).toHaveBeenCalledTimes(1)
    expect(Dictation.getAudioBoothSourceApp()).toEqual(editor)
    const asked = vi.mocked(Automator.prototype.getForemostApp).mock.invocationCallOrder[0]
    const opened = vi.mocked(window.openAudioBooth).mock.invocationCallOrder[0]
    expect(asked).toBeLessThan(opened)
  })

  test('Insert returns to the app the booth was opened from', async () => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    await Dictation.insertTranscription('Hello, World!')
    expect(window.mainWindow.minimize).toHaveBeenCalled()
    expect(window.releaseFocus).toHaveBeenCalledWith({ sourceApp: editor })
    expect(Automator.prototype.pasteText).toHaveBeenLastCalledWith('Hello, World!')
    // the app was known: no need to look for the one that comes to the front
    expect(Automator.prototype.getForemostApp).toHaveBeenCalledTimes(1)
    // and it is used once
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()
  })

  test('Our own app is never recorded', async () => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(ourselves)
    await Dictation.openAudioBooth()
    expect(window.openAudioBooth).toHaveBeenCalledTimes(1)
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()
  })

  test('Opening it again from our own window keeps the app the user came from', async () => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(ourselves)
    await Dictation.openAudioBooth()
    expect(window.openAudioBooth).toHaveBeenCalledTimes(2)
    expect(Dictation.getAudioBoothSourceApp()).toEqual(editor)
  })

  test('Opening it from another app replaces the one recorded before', async () => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(browser)
    await Dictation.openAudioBooth()
    expect(Dictation.getAudioBoothSourceApp()).toEqual(browser)
  })

  test.each([
    ['fails', () => vi.mocked(Automator.prototype.getForemostApp).mockRejectedValueOnce(new Error('no permission'))],
    ['gives nothing', () => vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(null)],
  ])('The booth still opens when reading the foremost app %s, and nothing is recorded', async (_, mockForemost) => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    mockForemost()
    await Dictation.openAudioBooth()
    expect(window.openAudioBooth).toHaveBeenCalledTimes(2)
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()
  })

  test.each(['blur', 'hide', 'minimize', 'closed'])('The recorded app is forgotten when the main window gets a %s event', async (event) => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    expect(Dictation.getAudioBoothSourceApp()).toEqual(editor)
    emitOnMainWindow(event)
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()

    // inserting then goes to the app that comes to the front once the main window is minimized
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(browser)
    await Dictation.insertTranscription('Hello, World!')
    expect(window.releaseFocus).toHaveBeenCalledWith({ sourceApp: browser })
    expect(Automator.prototype.pasteText).toHaveBeenLastCalledWith('Hello, World!')
  })

  test('The main window is watched once, however many times the booth is opened', async () => {
    const listeners = () => Object.values(mainWindowHandlers).reduce((count, handlers) => count + handlers.length, 0)
    await Dictation.openAudioBooth()
    const count = listeners()
    expect(count).toBe(4)
    await Dictation.openAudioBooth()
    await Dictation.openAudioBooth()
    expect(listeners()).toBe(count)
  })

  test('On Windows an app is recorded when its window has a title: the taskbar after a click on the tray icon has none', async () => {
    setPlatform('win32')
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce({ id: 'C:\\Windows\\explorer.exe', name: 'Windows Explorer', path: 'C:\\Windows\\explorer.exe', window: '' })
    await Dictation.openAudioBooth()
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()

    const notepad = { id: 'C:\\Windows\\notepad.exe', name: 'Notepad', path: 'C:\\Windows\\notepad.exe', window: 'notes.txt - Notepad' }
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(notepad)
    await Dictation.openAudioBooth()
    expect(Dictation.getAudioBoothSourceApp()).toEqual(notepad)
    await Dictation.insertTranscription('Hello, World!')
    expect(window.releaseFocus).toHaveBeenCalledWith({ sourceApp: notepad })
  })

  test('On Linux, where the focus cannot be given back to an app, nothing is recorded', async () => {
    setPlatform('linux')
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    expect(window.openAudioBooth).toHaveBeenCalledTimes(1)
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()
  })

  test('An app given by the caller wins over the recorded one', async () => {
    vi.mocked(Automator.prototype.getForemostApp).mockResolvedValueOnce(editor)
    await Dictation.openAudioBooth()
    await Dictation.insertTranscription('Hello, World!', browser)
    expect(window.releaseFocus).toHaveBeenCalledWith({ sourceApp: browser })
  })

})
