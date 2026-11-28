
import { BrowserWindow, RenderProcessGoneDetails, WebContents } from 'electron'

// two crashes of the same window in less than this are a crash loop
const CRASH_LOOP_MS = 10000

export type UncaughtExceptionAction = 'ignore' | 'log' | 'fatal'

// EPIPE/EBADF come from pipes closed by a child process or a console that went away: harmless.
// An exception thrown while the app starts leaves a process with no window that never quits:
// that one is fatal. Later ones are logged, and the app carries on.
export const classifyUncaughtException = (error: any, appReady: boolean): UncaughtExceptionAction => {
  const message = typeof error?.message === 'string' ? error.message : ''
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'EPIPE' || code === 'EBADF' || message.includes('EPIPE') || message.includes('EBADF')) {
    return 'ignore'
  }
  return appReady ? 'log' : 'fatal'
}

export type RenderProcessGoneAction = 'ignore' | 'quit' | 'reload' | 'close'

const lastCrash = new WeakMap<object, number>()

export type RenderProcessGoneContext = {
  debug: boolean
  isMainWindow: boolean
  now?: number
}

// A renderer that dies takes its own window down, not the app:
// - the main window is reloaded (once: a second crash right after closes it)
// - any other window is closed
// When debugging, the IDE kills the renderer to restart the app, so we still quit.
export const classifyRenderProcessGone = (webContents: object, details: Pick<RenderProcessGoneDetails, 'reason'>, context: RenderProcessGoneContext): RenderProcessGoneAction => {
  if (details?.reason === 'clean-exit') return 'ignore'
  if (context.debug) return 'quit'
  if (!context.isMainWindow) return 'close'
  const now = context.now ?? Date.now()
  const previous = lastCrash.get(webContents)
  lastCrash.set(webContents, now)
  if (previous !== undefined && now - previous < CRASH_LOOP_MS) return 'close'
  return 'reload'
}

export const handleRenderProcessGone = (webContents: WebContents, details: RenderProcessGoneDetails, opts: { debug: boolean, mainWindow: BrowserWindow|null, quit: () => void }): RenderProcessGoneAction => {

  let window: BrowserWindow|null = null
  try {
    window = BrowserWindow.fromWebContents(webContents)
  } catch { /* empty */ }

  const isMainWindow = !!window && window === opts.mainWindow
  const action = classifyRenderProcessGone(webContents, details, { debug: opts.debug, isMainWindow })
  console.error(`[crash] Render process gone (${details?.reason}, exit code ${details?.exitCode}): ${action}`)

  try {
    if (action === 'quit') {
      opts.quit()
    } else if (action === 'reload') {
      webContents.reload()
    } else if (action === 'close') {
      // destroy and not close: a dead renderer cannot answer the close handlers
      if (window && !window.isDestroyed()) window.destroy()
    }
  } catch (error) {
    console.error('[crash] Error while handling a render process that is gone', error)
  }

  return action

}
