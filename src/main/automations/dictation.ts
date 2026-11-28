
import { App } from 'electron'
import * as window from '../window'
import { loadSettings } from '../config'
import Automator from './automator'
import { Application } from 'types/automation'

const DOUBLE_TAP_TIMEOUT = 400 // ms

export default class Dictation {

  private app: App
  private lastKeyDownTime = 0
  private isHolding = false

  constructor(app: App) {
    this.app = app
  }

  onShortcutDown(): void {
    const config = loadSettings(this.app)
    const activation = config.stt?.quickDictation?.activation ?? 'tap'

    if (activation === 'tap') {
      Dictation.initDictation()
    } else if (activation === 'doubleTap') {
      // if window is already open, single tap stops it
      if (Dictation.isDictationWindowOpen()) {
        Dictation.stopDictation()
        this.lastKeyDownTime = 0
        return
      }
      const now = Date.now()
      if (now - this.lastKeyDownTime < DOUBLE_TAP_TIMEOUT) {
        Dictation.initDictation()
        this.lastKeyDownTime = 0 // reset to prevent triple tap
      } else {
        this.lastKeyDownTime = now
      }
    } else if (activation === 'hold') {
      this.isHolding = true
      Dictation.initDictation()
    }
  }

  onShortcutUp(): void {
    const config = loadSettings(this.app)
    const activation = config.stt?.quickDictation?.activation ?? 'tap'

    if (activation === 'hold' && this.isHolding) {
      this.isHolding = false
      Dictation.stopDictation()
    }
  }

  static isDictationWindowOpen(): boolean {
    return window.dictationWindow && !window.dictationWindow.isDestroyed() && window.dictationWindow.isVisible()
  }

  static stopDictation(): void {
    if (Dictation.isDictationWindowOpen()) {
      window.emitIpcEvent(window.dictationWindow, 'stop-and-transcribe')
    }
  }

  static initDictation = async (): Promise<void> => {

    // if dictation window is already open and visible, tell it to stop and transcribe
    if (Dictation.isDictationWindowOpen()) {
      Dictation.stopDictation()
      return;
    }

    // capture the foremost app before opening the window
    const automator = new Automator();
    let sourceApp = null;
    try {
      sourceApp = await automator.getForemostApp();
    } catch (error) {
      console.error('Error getting foremost app', error);
    }

    // open the mini dictation window
    window.openDictationWindow({ sourceApp });

  }

  static insertTranscription = async (text: string, sourceApp?: Application|null): Promise<void> => {

    // the main window may not exist (hide on startup) or may be gone
    try {
      if (window.mainWindow && !window.mainWindow.isDestroyed?.()) {
        window.mainWindow.minimize();
      }
    } catch (error) {
      console.error('Error minimizing main window', error);
    }

    // the text must land in the app the user came from: when the caller does not know it,
    // ask which app came to the front once our window is out of the way
    if (!sourceApp) {
      try {
        const foremost = await new Automator().getForemostApp();
        if (foremost && !Dictation.isOurselves(foremost)) {
          sourceApp = foremost;
        }
      } catch (error) {
        console.error('Error getting foremost app', error);
      }
    }

    // release focus (never fatal: we still want to paste)
    try {
      await window.releaseFocus(sourceApp ? { sourceApp } : undefined);
    } catch (error) {
      console.error('Error releasing focus', error);
    }

    // now paste
    console.debug(`Processing transcription output: ${text.slice(0, 50)}…`);

    // we need an automator
    const automator = new Automator();
    await automator.pasteText(text)

  }

  private static isOurselves(application: Application): boolean {
    const normalize = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase()
    const appPath = normalize(application.path)
    if (!appPath) return false
    const execPath = normalize(process.execPath)
    // on macOS the application path is the bundle that holds the executable
    return appPath === execPath || execPath.startsWith(appPath + '/')
  }

}
