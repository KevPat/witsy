
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

  // The Audio Booth lives in the main window. When it is opened from another app (global shortcut,
  // tray), that app is recorded before our window takes the focus, as Prompt Anywhere and the
  // dictation window do: this is where "Insert" must send the text.
  // It is known where the foremost app can be read: macOS, and Windows with the native automation
  // module. Elsewhere nothing is recorded and inserting works as it did.
  private static boothSourceApp: Application|null = null
  private static boothWindow: unknown = null

  static openAudioBooth = async (): Promise<void> => {

    // capture the foremost app before opening the window: never a reason not to open it
    let foremost: Application|null = null
    try {
      foremost = await new Automator().getForemostApp()
    } catch (error) {
      console.error('Error getting foremost app', error)
    }

    // open the booth
    window.openAudioBooth()

    // when it is us, the user never left since the last time: what we know still holds.
    // an app we can give the focus back to is where the user comes from.
    // anything else (no answer, the taskbar after a click on the tray icon): we know nothing
    if (foremost && Dictation.isOurselves(foremost)) {
      // keep
    } else if (foremost && Dictation.canReturnTo(foremost)) {
      Dictation.boothSourceApp = foremost
    } else {
      Dictation.boothSourceApp = null
    }

    // this is only true as long as the user stays in our window
    Dictation.forgetBoothSourceAppWhenLeft()

  }

  static getAudioBoothSourceApp(): Application|null {
    return Dictation.boothSourceApp
  }

  private static forgetBoothSourceApp = (): void => {
    Dictation.boothSourceApp = null
  }

  // once the main window lost the focus, was hidden, minimized or closed, the user may come back
  // from anywhere: the text must never go to an app left long ago
  private static forgetBoothSourceAppWhenLeft(): void {
    try {
      const mainWindow = window.mainWindow
      if (!mainWindow || mainWindow.isDestroyed?.()) {
        Dictation.boothSourceApp = null
        return
      }
      if (Dictation.boothWindow === mainWindow) return
      Dictation.boothWindow = mainWindow
      for (const event of ['blur', 'hide', 'minimize', 'closed']) {
        mainWindow.on(event as any, Dictation.forgetBoothSourceApp)
      }
    } catch (error) {
      // without these events what we recorded cannot be trusted
      console.error('Error watching the main window', error)
      Dictation.boothSourceApp = null
    }
  }

  static insertTranscription = async (text: string, sourceApp?: Application|null): Promise<void> => {

    // the app the Audio Booth was opened from: read before our window is minimized, which forgets it
    if (!sourceApp) {
      sourceApp = Dictation.boothSourceApp
    }
    Dictation.boothSourceApp = null

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

  // what releaseFocus needs to target an app: its bundle id on macOS, the title of its window on Windows
  private static canReturnTo(application: Application): boolean {
    if (process.platform === 'darwin') return !!application.id
    if (process.platform === 'win32') return !!application.window
    return false
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
