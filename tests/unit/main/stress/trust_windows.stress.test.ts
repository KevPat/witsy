
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { printPdfFromHtml } from '@main/pdf'
import { setWebviewLinkBehavior } from '@main/webview'
import { createWindow } from '@main/windows/index'
import { bug } from './bug'

// Every window of the app is created by createWindow and gets the preload api. What is shown in
// those windows is written by models, tools and web pages, so two things have to hold in the main
// process whatever the renderer does: a link can only leave the app towards a web browser, and it
// can never replace the app's own page. Electron is replaced by a recorder: nothing is opened.

const electron = vi.hoisted(() => ({
  windows: [] as any[],
  webviews: new Map<number, any>(),
  openExternal: vi.fn(async (): Promise<void> => {}),
  printToPDF: vi.fn(async () => Buffer.from('%PDF')),
}))

const fsPromises = vi.hoisted(() => ({
  writeFile: vi.fn(async (): Promise<void> => {}),
  unlink: vi.fn(async (): Promise<void> => {}),
}))

vi.mock('electron', () => {
  const BrowserWindow = vi.fn(function(this: any, options: any) {
    this.id = electron.windows.length + 1
    this.options = options
    this.on = vi.fn()
    this.once = vi.fn()
    this.show = vi.fn()
    this.loadURL = vi.fn(async () => {})
    this.loadFile = vi.fn(async () => {})
    this.isDestroyed = vi.fn(() => false)
    this.destroy = vi.fn()
    this.webContents = {
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => true),
      printToPDF: electron.printToPDF,
    }
    electron.windows.push(this)
  })
  return {
    BrowserWindow,
    app: { getPath: vi.fn(() => ''), dock: { show: vi.fn(), hide: vi.fn() } },
    shell: { openExternal: electron.openExternal },
    webContents: { fromId: vi.fn((id: number) => electron.webviews.get(id)) },
    session: { fromPartition: vi.fn() },
    screen: {},
    nativeTheme: {},
    Menu: {},
  }
})

vi.mock('node:fs/promises', () => ({ default: fsPromises, ...fsPromises }))
vi.mock('electron-store', () => ({ default: vi.fn() }))
vi.mock('@main/network', () => ({ default: vi.fn() }))
vi.mock('@main/config', () => ({ loadSettings: vi.fn(() => ({ appearance: {} })) }))
vi.mock('@main/utils', () => ({ wait: vi.fn(), getCleanUserAgent: vi.fn((ua: string) => ua) }))
vi.mock('@main/automations/macos', () => ({ default: vi.fn() }))
vi.mock('@main/automations/windows', () => ({ default: vi.fn() }))
vi.mock('@main/windows/anywhere', () => ({ promptAnywhereWindow: null }))
vi.mock('@main/windows/commands', () => ({ commandPicker: null }))
vi.mock('@main/windows/dictation', () => ({ dictationWindow: null }))
vi.mock('@main/windows/main', () => ({ mainWindow: null }))

type OpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' }

const kWebUrls: [string, string][] = [
  ['an https page', 'https://example.com/docs?q=1#top'],
  ['an http page', 'http://example.com/'],
  ['an https page with credentials and a port', 'https://user:pass@example.com:8443/a%20b'],
  ['an https page with upper case scheme', 'HTTPS://EXAMPLE.COM/'],
]

const kOtherUrls: [string, string][] = [
  ['a local executable', 'file:///C:/Windows/System32/calc.exe'],
  ['a local application', 'file:///System/Applications/Calculator.app'],
  ['a local file', 'file:///etc/passwd'],
  ['a file on a remote share', 'file://evil.example/share/invoice.exe'],
  ['an smb share', 'smb://evil.example/share'],
  ['ms-msdt', 'ms-msdt:/id PCWDiagnostic /skip force /param "IT_RebrowseForFile=?"'],
  ['search-ms', 'search-ms:query=invoice&crumb=location:\\\\evil.example\\share'],
  ['ms-officecmd', 'ms-officecmd:{"id":3,"LocalProviders.LaunchOfficeAppForResult":{}}'],
  ['a vscode url', 'vscode://vscode.git/clone?url=https://evil.example/repo.git'],
  ['an ssh url', 'ssh://-oProxyCommand=calc@evil.example'],
  ['a javascript url', 'javascript:alert(1)'],
  ['a data url', 'data:text/html,<script>alert(1)</script>'],
  ['a blob url', 'blob:file:///0b6a1a2e-7a55-4c0b-9d1f-0d6b4f6f6b9a'],
  ['a telnet url', 'telnet://evil.example'],
  ['an unknown scheme', 'x-evil-handler://run?cmd=calc'],
  ['something that is not a url', 'not a url'],
  ['an empty string', ''],
]

const openHandlerOf = (target: any): OpenHandler => {
  expect(target.setWindowOpenHandler).toHaveBeenCalledTimes(1)
  return target.setWindowOpenHandler.mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.windows.length = 0
  electron.webviews.clear()
  electron.printToPDF.mockImplementation(async () => Buffer.from('%PDF'))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/')
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('app windows: links that open a new window', () => {

  const handler = (): OpenHandler => {
    createWindow({ hash: '/chat' })
    expect(electron.windows).toHaveLength(1)
    return openHandlerOf(electron.windows[0].webContents)
  }

  test('the fixture is the window every screen is created with', () => {
    createWindow({ hash: '/chat' })
    const preferences = electron.windows[0].options.webPreferences
    expect(preferences.preload).toMatch(/preload\.js$/)
    expect(preferences.contextIsolation).toBe(true)
    expect(preferences.nodeIntegration).toBe(false)
    expect(preferences.sandbox).toBe(true)
    expect(electron.windows[0].loadURL).toHaveBeenCalledWith('http://localhost:5173/#/chat')
  })

  test.each([...kWebUrls, ...kOtherUrls])('%s never opens inside the app', (_, url) => {
    expect(handler()({ url })).toEqual({ action: 'deny' })
  })

  test.each(kWebUrls)('%s is handed to the system browser', (_, url) => {
    handler()({ url })
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
    expect(electron.openExternal).toHaveBeenCalledWith(url)
  })

  test('a mail link is handed to the mail client', () => {
    handler()({ url: 'mailto:someone@example.com?subject=Hello' })
    expect(electron.openExternal).toHaveBeenCalledWith('mailto:someone@example.com?subject=Hello')
  })

  test.each(kOtherUrls)('%s is not handed to the operating system', (_, url) => {
    handler()({ url })
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

})

describe('app windows: links that replace the page', () => {

  test('navigation of the app window is guarded', () => {
    // a link without target=_blank, a form or a script must not replace the app by another page,
    // which would then have the preload api
    createWindow({ hash: '/chat' })
    const events = electron.windows[0].webContents.on.mock.calls.map((call: any[]) => call[0])
    expect(events.some((event: string) => event === 'will-navigate' || event === 'will-frame-navigate'), `listeners: ${events.join(', ')}`).toBe(true)
  })

  test('a navigation to another page is cancelled', () => {
    createWindow({ hash: '/chat' })
    const navigate = electron.windows[0].webContents.on.mock.calls.filter((call: any[]) => call[0] === 'will-navigate' || call[0] === 'will-frame-navigate')
    const event = { preventDefault: vi.fn(), url: 'https://evil.example/', isMainFrame: true, isSameDocument: false }
    for (const [, listener] of navigate) listener(event, event.url)
    expect(event.preventDefault).toHaveBeenCalled()
  })

})

describe('webviews: links that open a new window', () => {

  const handler = (isExternal: boolean): OpenHandler => {
    const webview = { setWindowOpenHandler: vi.fn() }
    electron.webviews.set(7, webview)
    setWebviewLinkBehavior(7, isExternal)
    return openHandlerOf(webview)
  }

  test('an unknown webview is ignored', () => {
    expect(() => setWebviewLinkBehavior(99, true)).not.toThrow()
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  test.each(kWebUrls)('%s is handed to the system browser when links are external', (_, url) => {
    expect(handler(true)({ url })).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
    expect(electron.openExternal).toHaveBeenCalledWith(url)
  })

  test.each([...kWebUrls, ...kOtherUrls])('%s is never handed to the operating system when links are internal', (_, url) => {
    handler(false)({ url })
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  test.each(kOtherUrls)('%s never opens inside the app when links are external', (_, url) => {
    expect(handler(true)({ url })).toEqual({ action: 'deny' })
  })

  test.each(kOtherUrls)('%s is not handed to the operating system when links are external', (_, url) => {
    // same as the app windows, and here the page is any web site
    handler(true)({ url })
    expect(electron.openExternal).not.toHaveBeenCalled()
  })

})

describe('pdf export: the window that prints the page', () => {

  const kHtml = '<html><body><h1>Report</h1><script>fetch("file:///etc/passwd")</script></body></html>'

  test('the page is printed in a hidden window without preload and the temporary file is removed', async () => {
    const pdf = await printPdfFromHtml({ html: kHtml })
    expect(pdf.toString()).toBe('%PDF')
    expect(electron.windows).toHaveLength(1)
    const printWindow = electron.windows[0]
    expect(printWindow.options.show).toBe(false)
    expect(printWindow.options.webPreferences.preload).toBeUndefined()
    expect(printWindow.options.webPreferences.sandbox).toBe(true)
    expect(printWindow.options.webPreferences.contextIsolation).toBe(true)
    expect(printWindow.options.webPreferences.nodeIntegration).toBe(false)
    expect(printWindow.options.webPreferences.webviewTag).not.toBe(true)
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1)
    const [file, contents] = fsPromises.writeFile.mock.calls[0] as unknown as [string, string]
    expect(contents).toBe(kHtml)
    expect(printWindow.loadFile).toHaveBeenCalledWith(file)
    expect(fsPromises.unlink).toHaveBeenCalledWith(file)
    expect(printWindow.destroy).toHaveBeenCalledTimes(1)
  })

  test('the temporary file is removed and the window destroyed when printing fails', async () => {
    electron.printToPDF.mockRejectedValueOnce(new Error('print failed'))
    await expect(printPdfFromHtml({ html: kHtml })).rejects.toThrow('print failed')
    expect(fsPromises.unlink).toHaveBeenCalledTimes(1)
    expect(electron.windows[0].destroy).toHaveBeenCalledTimes(1)
  })

  bug('the scripts of the page do not run with web security disabled', async () => {
    // webSecurity: false and scripts enabled on a file: page: the page can read any local file and post it anywhere
    await printPdfFromHtml({ html: kHtml })
    const preferences = electron.windows[0].options.webPreferences
    expect(preferences.webSecurity === false && preferences.javascript !== false, JSON.stringify(preferences)).toBe(false)
  })

})
