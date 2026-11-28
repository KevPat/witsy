
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// config is only used by the shortcut handlers, not by insertTranscription; keep it inert.
vi.mock('@main/config', () => ({ loadSettings: vi.fn(() => ({ stt: {} })) }))

// Automator is globally mocked in vitest.setup.ts; we only read Automator.prototype.pasteText.

type WindowDouble = {
  releaseFocus: ReturnType<typeof vi.fn>
  openDictationWindow: ReturnType<typeof vi.fn>
}

const loadWith = async (mainWindow: unknown): Promise<{
  Dictation: typeof import('@main/automations/dictation').default
  Automator: typeof import('@main/automations/automator').default
  win: WindowDouble
}> => {
  vi.resetModules()
  const win: WindowDouble = { releaseFocus: vi.fn(async () => undefined), openDictationWindow: vi.fn() }
  vi.doMock('@main/window', () => ({
    mainWindow,
    dictationWindow: null,
    releaseFocus: win.releaseFocus,
    openDictationWindow: win.openDictationWindow,
    openAudioBooth: vi.fn(),
    isMainWindowFocused: vi.fn(() => false),
    emitIpcEvent: vi.fn(),
  }))
  const Dictation = (await import('@main/automations/dictation')).default
  const Automator = (await import('@main/automations/automator')).default
  return { Dictation, Automator, win }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.doUnmock('@main/window')
  vi.resetModules()
})

describe('Dictation.insertTranscription', () => {

  test('with a main window: minimizes it, releases focus, then pastes the text', async () => {
    const minimize = vi.fn()
    const { Dictation, Automator, win } = await loadWith({ minimize })
    await Dictation.insertTranscription('Hello there')
    expect(minimize).toHaveBeenCalled()
    expect(win.releaseFocus).toHaveBeenCalled()
    expect(Automator.prototype.pasteText).toHaveBeenCalledWith('Hello there')
  })

  test('still pastes the transcription when there is no main window', async () => {
    // fails today: window.mainWindow.minimize() is called with no null/isDestroyed guard, so it
    // throws on a null main window (e.g. hideOnStartup) and the paste never runs.
    const { Dictation, Automator } = await loadWith(null)
    await Dictation.insertTranscription('Hello there').catch(() => undefined)
    expect(Automator.prototype.pasteText).toHaveBeenCalledWith('Hello there')
  })

  test('returns focus to the originating app so the paste lands there', async () => {
    // fails today: insertTranscription calls releaseFocus() with no sourceApp, so focus goes
    // nowhere in particular and the text can be pasted into the wrong window.
    const { Dictation, win } = await loadWith({ minimize: vi.fn() })
    await Dictation.insertTranscription('Hello there').catch(() => undefined)
    expect(win.releaseFocus).toHaveBeenCalledWith(expect.objectContaining({ sourceApp: expect.anything() }))
  })

  test('an Audio Booth opened without a main window to watch records no app, and the text is still pasted', async () => {
    // the recorded app is only trusted while the main window tells when the user leaves it
    const { Dictation, Automator } = await loadWith(null)
    await Dictation.openAudioBooth()
    expect(Dictation.getAudioBoothSourceApp()).toBeNull()
    await Dictation.insertTranscription('Hello there')
    expect(Automator.prototype.pasteText).toHaveBeenCalledWith('Hello there')
  })

})
