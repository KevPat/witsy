import { session, shell, webContents } from 'electron'
import { getCleanUserAgent } from './utils'

const initializedPartitions = new Set<string>()

/**
 * Initialize the webview session with custom user agent
 * Removes "Witsy" and "Electron" from the user agent to avoid detection
 */
export function initWebviewSession(partition = 'persist:webview'): void {
  if (partition !== 'persist:webview' && !partition.startsWith('persist:webapp_')) {
    throw new Error(`Invalid webview partition: ${partition}`)
  }
  if (initializedPartitions.has(partition)) return

  const wvSession = session.fromPartition(partition)
  const originUA = wvSession.getUserAgent()
  const newUA = getCleanUserAgent(originUA)

  wvSession.setUserAgent(newUA)
  wvSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = {
      ...details.requestHeaders,
      'User-Agent': newUA
    }
    cb({ requestHeaders: headers })
  })
  initializedPartitions.add(partition)
}

/**
 * Configure whether links opened from webview should open externally or within the app
 * @param webviewId The webContents ID of the webview
 * @param isExternal Whether to open links in external browser
 */
export function setWebviewLinkBehavior(webviewId: number, isExternal: boolean): void {
  const webview = webContents.fromId(webviewId)
  if (!webview) return

  webview.setWindowOpenHandler(({ url }) => {
    if (isExternal) {
      shell.openExternal(url)
      return { action: 'deny' }
    } else {
      return { action: 'allow' }
    }
  })
}

/**
 * Enable or disable spell check for a specific webview
 * @param webviewId The webContents ID of the webview
 * @param enabled Whether spell check should be enabled
 */
export function setWebviewSpellCheck(webviewId: number, enabled: boolean): void {
  const webview = webContents.fromId(webviewId)
  if (!webview) return

  webview.session.setSpellCheckerEnabled(enabled)
}
