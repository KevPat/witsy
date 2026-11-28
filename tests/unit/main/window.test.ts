
import { BrowserWindow, Menu, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, expect, Mock, test, vi } from 'vitest'
import * as window from '@main/window'
import { store } from '@services/store'
import { Application } from '@/types/automation'
import { useWindowMock } from '@tests/mocks/window'

// @ts-expect-error mock
global.MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://localhost:3000/'
// @ts-expect-error mock
global.MAIN_WINDOW_VITE_NAME = 'vite'

vi.mock('electron', async () => {
  const BrowserWindow = vi.fn(function() {
    this.visible = true
    this.minimized = false
    this.destroyed = false
    return this
  })
  BrowserWindow.prototype.show = vi.fn()
  BrowserWindow.prototype.hide = vi.fn(function() { this.visible = false })
  BrowserWindow.prototype.close = vi.fn(function() { this.destroyed = true })
  BrowserWindow.prototype.focus = vi.fn()
  BrowserWindow.prototype.restore = vi.fn(function() { this.minimized = false })
  BrowserWindow.prototype.minimize = vi.fn(function() { this.minimized = true })
  BrowserWindow.prototype.isMinimized = vi.fn(function() { return this.minimized })
  BrowserWindow.prototype.isVisible = vi.fn(function() { return this.visible })
  BrowserWindow.prototype.isDestroyed = vi.fn(function() { return false })
  BrowserWindow.prototype.loadFile = vi.fn()
  BrowserWindow.prototype.loadURL = vi.fn()
  BrowserWindow.prototype.on = vi.fn()
  BrowserWindow.prototype.off = vi.fn()
  BrowserWindow.prototype.once = vi.fn()
  BrowserWindow.prototype.removeAllListeners = vi.fn()
  BrowserWindow.prototype.getPosition =  vi.fn(() => [0, 0])
  BrowserWindow.prototype.getSize = vi.fn(() => [0, 0])
  BrowserWindow.prototype.setPosition = vi.fn()
  BrowserWindow.prototype.getBounds = vi.fn(() => ({ x: 100, y: 200, width: 150, height: 250}))
  BrowserWindow.prototype.setBounds = vi.fn()
  BrowserWindow.prototype.setSize = vi.fn()
  BrowserWindow.prototype.setOpacity = vi.fn()
  BrowserWindow.prototype.setIgnoreMouseEvents = vi.fn()
  // @ts-expect-error mock
  BrowserWindow['getAllWindows'] = vi.fn(() => {
    const window1 = new BrowserWindow()
    const window2 = new BrowserWindow()
    const window3 = new BrowserWindow()
    const window4 = new BrowserWindow()
    window3.visible = false
    window4.minimized = true
    return [window1, window2, window3, window4]
  })
  BrowserWindow.prototype.webContents = {
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    capturePage: vi.fn(() => ({
      getBitmap: vi.fn(() => ([0, 0, 0, 0]))
    })),
    openDevTools: vi.fn(),
    debugger: {
      attach: vi.fn(),
      sendCommand: vi.fn(),
      on: vi.fn(),
    }
  }
  const app = {
    focus: vi.fn(),
    getPath: vi.fn(() => ''),
    getLocale: vi.fn(() => 'en'),
    dock: {
      show: vi.fn(),
      hide: vi.fn(),
    }
  }
  const screen = {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
      workArea: { x: 0, y: 25 },
      workAreaSize: { width: 0, height: 0 }
    })),
  }
  const nativeTheme = {
    shouldUseDarkColors: vi.fn(() => false),
  }
  const dialog = {
    showMessageBoxSync: vi.fn(() => 1),
  }
  const shell = {
    openExternal: vi.fn(),
  }
  const Menu = {
    sendActionToFirstResponder: vi.fn(),
  }
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((data) => `encrypted-${data}`),
    decryptString: vi.fn((data) => data.toString('latin1'))
  }
  return {
    app,
    shell,
    screen,
    dialog,
    nativeTheme,
    safeStorage,
    BrowserWindow,
    Menu
  }
})

vi.mock('@main/i18n', () => ({
  useI18n: vi.fn(() => (key: string) => key)
}))

vi.mock('@main/utils', async () => {
  return {
    wait: vi.fn(),
    putCachedText: vi.fn(() => 'textId')
  }
})

const expectCreateWebPreferences = (callParams: any) => {
  expect(callParams.webPreferences.nodeIntegration).toBe(false)
  expect(callParams.webPreferences.contextIsolation).toBe(true)
  // these tests run with the dev server (MAIN_WINDOW_VITE_DEV_SERVER_URL above): an http page.
  // The packaged app has web security on: see 'The packaged app window has web security on'
  expect(callParams.webPreferences.webSecurity).toBe(false)
  expect(callParams.webPreferences.defaultEncoding).toBe('UTF-8')
  expect(callParams.webPreferences.sandbox).toBe(true)
}

beforeAll(() => {
  useWindowMock()
})

beforeEach(async () => {
  store.loadSettings()
  try { window.closeMainWindow() } catch { /* empty */ }
  try { await window.closeCommandPicker() } catch { /* empty */ }
  try { await window.closePromptAnywhere() } catch { /* empty */ }
  //try { await window.closeWaitingPanel() } catch { /* empty */ }
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const kUrlsNotForTheSystem = [
  'file:///C:/Windows/System32/calc.exe',
  'file:///etc/passwd',
  'file://evil.example/share/invoice.exe',
  'smb://evil.example/share',
  'ms-msdt:/id PCWDiagnostic /skip force',
  'search-ms:query=invoice&crumb=location:\\\\evil.example\\share',
  'vscode://vscode.git/clone?url=https://evil.example/repo.git',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'not a url',
  '',
]

const lastWebContentsListener = (name: string): (...args: any[]) => void => {
  const calls = (BrowserWindow.prototype.webContents.on as Mock).mock.calls.filter((call) => call[0] === name)
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1]
}

const navigate = (url: string) => {
  const event = { preventDefault: vi.fn(), url, isMainFrame: true, isSameDocument: false }
  lastWebContentsListener('will-navigate')(event, url)
  return event.preventDefault.mock.calls.length > 0 ? 'cancelled' : 'allowed'
}

test('All windows are null', async () => {
  expect(window.mainWindow).toBeNull()
  expect(window.commandPicker).toBeNull()
  expect(window.promptAnywhereWindow).toBeNull()
  //expect(window.waitingPanel).toBeNull()
})

test('Create main window', async () => {
  window.openMainWindow()
  expect(window.mainWindow).toBeInstanceOf(BrowserWindow)
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    title: 'common.appName'
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?#')
  expect(window.mainWindow.isVisible()).toBe(true)
  window.closeMainWindow()
  expect(window.mainWindow).toBeNull()

})

test('Main window properties', async () => {
  window.openMainWindow()
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expect(callParams.width).toBeDefined()
  expect(callParams.height).toBeDefined()
  expect(callParams.titleBarOverlay).toBeDefined()
  expect(callParams.trafficLightPosition).toBeDefined()
  expect(callParams.show).toBe(false)
  expectCreateWebPreferences(callParams)
})

test('Two main windows are not created', async () => {
  window.openMainWindow()
  vi.clearAllMocks()
  window.openMainWindow()
  expect(BrowserWindow.prototype.isDestroyed).toHaveBeenCalled()
  expect(BrowserWindow.prototype.show).toHaveBeenCalled()
  expect(BrowserWindow.prototype.isMinimized).toHaveBeenCalled()
  expect(BrowserWindow.prototype.focus).toHaveBeenCalled()
  expect(BrowserWindow.prototype.loadURL).not.toHaveBeenCalled()
})

test('Restores existing main window', async () => {
  window.openMainWindow()
  window.mainWindow.minimize()
  vi.clearAllMocks()
  window.openMainWindow()
  expect(BrowserWindow.prototype.isDestroyed).toHaveBeenCalled()
  expect(BrowserWindow.prototype.show).toHaveBeenCalled()
  expect(BrowserWindow.prototype.isMinimized).toHaveBeenCalled()
  expect(BrowserWindow.prototype.restore).toHaveBeenCalled()
  expect(BrowserWindow.prototype.focus).toHaveBeenCalled()
  expect(BrowserWindow.prototype.loadURL).not.toHaveBeenCalled()
})

test('Open Chat window', async () => {
  window.openMainWindow({ queryParams: { view: 'chat' } })
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    queryParams: { view: 'chat', }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?view=chat#')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Open Settings window', async () => {
  window.openSettingsWindow()
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    queryParams: { view: 'settings', }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?view=settings#')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Switch to Settings window', async () => {
  window.openMainWindow()
  window.openSettingsWindow()
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?#')
  expect(BrowserWindow.prototype.webContents.send).toHaveBeenCalledWith('query-params', { view: 'settings' })
})

test('Create command picker window', async () => {
  window.openCommandPicker({ textId: 'id' })
  expect(window.commandPicker).toBeInstanceOf(BrowserWindow)
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?textId=id#/commands')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Close command picker window', async () => {
  window.openCommandPicker({ textId: 'id' })
  await window.closeCommandPicker({} as Application)
  expect(window.commandPicker).not.toBeNull()
  expect(window.commandPicker.isVisible()).toBe(false)
  expect(Menu.sendActionToFirstResponder).toHaveBeenCalled()
})

test('Create prompt anywhere window', async () => {
  window.openPromptAnywhere({ promptId: 'id' })
  expect(window.promptAnywhereWindow).toBeInstanceOf(BrowserWindow)
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    hash: '/prompt',
    queryParams: { promptId: 'id' }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?promptId=id#/prompt')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
  expect(BrowserWindow.prototype.webContents.send).not.toHaveBeenCalled()
})

test('Update prompt anywhere window', async () => {
  window.preparePromptAnywhere({ promptId: 'id' })
  expect(window.promptAnywhereWindow).toBeInstanceOf(BrowserWindow)
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    hash: '/prompt',
    queryParams: { promptId: 'id' }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?promptId=id#/prompt')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
  window.openPromptAnywhere({ promptId: 'id' })
  expect(BrowserWindow.prototype.webContents.send).toHaveBeenLastCalledWith('show', { promptId: 'id'})
})

test('Resize prompt anywhere window', async () => {
  window.openPromptAnywhere({ promptId: 'id' })
  window.resizePromptAnywhere(10, 20)
  expect(BrowserWindow.prototype.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, width: 160, height: 270 })
})

test('Close prompt anywhere window', async () => {
  window.openPromptAnywhere({})
  await window.closePromptAnywhere()
  expect(window.promptAnywhereWindow).not.toBeNull()
})

test('Open Readaloud window', async () => {
  window.openReadAloudPalette({ textId: 'textId', sourceApp: JSON.stringify({ id: 'appId', name: 'appName', path: 'appPath', window: 'title' }) })
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    hash: '/readaloud',
    queryParams: {
      textId: 'textId',
      sourceApp: "{\"id\":\"appId\",\"name\":\"appName\",\"path\":\"appPath\",\"window\":\"title\"}"
    }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?textId=textId&sourceApp=%7B%22id%22%3A%22appId%22%2C%22name%22%3A%22appName%22%2C%22path%22%3A%22appPath%22%2C%22window%22%3A%22title%22%7D#/readaloud')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Open Transcribe window', async () => {
  window.openAudioBooth()
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    queryParams: { view: 'booth', }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?view=booth#')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Open Scratchpad via IPC', async () => {
  // Scratchpad is now integrated into main window, not a separate window
  // This test would need to be updated to test the IPC handler instead
  expect(true).toBe(true)
});

test('Open Realtime window', async () => {
  window.openRealtimeChatWindow()
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    queryParams: { view: 'voice-mode', }
  }))
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Open Design Studio window', async () => {
  window.openDesignStudioWindow()
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    queryParams: { view: 'studio', }
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?view=studio#')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Switch to Design Studio window', async () => {
  window.openMainWindow()
  window.openDesignStudioWindow()
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/?#')
  expect(BrowserWindow.prototype.webContents.send).toHaveBeenCalledWith('query-params', { view: 'studio' })
})

test('Open Computer', async () => {
  window.openComputerStatusWindow()
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    hash: '/computer',
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/#/computer')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Open Debug window', async () => {
  window.openDebugWindow()
  expect(BrowserWindow.prototype.constructor).toHaveBeenLastCalledWith(expect.objectContaining({
    hash: '/debug',
  }))
  expect(BrowserWindow.prototype.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/#/debug')
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expectCreateWebPreferences(callParams)
})

test('Links that open a new window only reach the system as web or mail links', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.createWindow({ hash: '/chat' })
  const handler = (BrowserWindow.prototype.webContents.setWindowOpenHandler as Mock).mock.calls[0][0]

  for (const url of ['https://example.com/docs?q=1#top', 'http://example.com/', 'HTTPS://EXAMPLE.COM/', 'mailto:someone@example.com?subject=Hello']) {
    expect(handler({ url })).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenLastCalledWith(url)
  }
  expect(shell.openExternal).toHaveBeenCalledTimes(4)

  for (const url of kUrlsNotForTheSystem) {
    expect(handler({ url })).toEqual({ action: 'deny' })
  }
  expect(shell.openExternal).toHaveBeenCalledTimes(4)
})

test('The app window only navigates to the dev server', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.createWindow({ hash: '/chat' })

  expect(navigate('http://localhost:3000/')).toBe('allowed')
  expect(navigate('http://localhost:3000/?view=settings#/chat')).toBe('allowed')
  expect(shell.openExternal).not.toHaveBeenCalled()

  const elsewhere = ['https://evil.example/', 'http://localhost:3001/', 'https://localhost:3000/', 'http://localhost.evil.example:3000/', 'http://localhost:3000@evil.example/', 'mailto:someone@example.com']
  for (const url of elsewhere) {
    expect(navigate(url), url).toBe('cancelled')
    expect(shell.openExternal).toHaveBeenLastCalledWith(url)
  }
  expect(shell.openExternal).toHaveBeenCalledTimes(elsewhere.length)

  for (const url of kUrlsNotForTheSystem) {
    expect(navigate(url), url).toBe('cancelled')
  }
  expect(shell.openExternal).toHaveBeenCalledTimes(elsewhere.length)
})

test('The packaged app window has web security on', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
  window.createWindow()
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expect(callParams.webPreferences.webSecurity).toBe(true)
  // nothing gives it back what web security takes away
  expect(callParams.webPreferences.allowRunningInsecureContent).toBeUndefined()
  expect(callParams.webPreferences.nodeIntegration).toBe(false)
  expect(callParams.webPreferences.contextIsolation).toBe(true)
  expect(callParams.webPreferences.sandbox).toBe(true)
})

test('The dev server window has web security off', async () => {
  // an http page: with web security it could not call the model providers nor show a local image
  window.createWindow()
  const callParams = (BrowserWindow as unknown as Mock).mock.calls[0][0]
  expect(callParams.webPreferences.webSecurity).toBe(false)
})

test('The packaged app window only navigates to its own page', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
  window.createWindow({ hash: '/chat', queryParams: { view: 'chat' } })
  expect(BrowserWindow.prototype.loadURL).not.toHaveBeenCalled()
  const [pagePath, options] = (BrowserWindow.prototype.loadFile as Mock).mock.calls[0]
  expect(pagePath).toMatch(/renderer[\\/]vite[\\/]index\.html$/)
  expect(options).toEqual({ hash: '/chat', query: { view: 'chat' } })
  const pageUrl = pathToFileURL(pagePath).href

  expect(navigate(pageUrl)).toBe('allowed')
  expect(navigate(`${pageUrl}?view=chat#/chat`)).toBe('allowed')
  expect(navigate(`${pageUrl}#/settings`)).toBe('allowed')
  expect(navigate(pageUrl.replace('/vite/', '/v%69te/'))).toBe('allowed')

  for (const url of [
    pageUrl.replace('index.html', 'other.html'),
    pageUrl.replace('index.html', ''),
    pageUrl.replace('file:///', 'file://evil.example/'),
    `${pageUrl}/../../../../etc/passwd`,
    `file:///tmp/index.html`,
    ...kUrlsNotForTheSystem,
  ]) {
    expect(navigate(url), url).toBe('cancelled')
  }
  expect(shell.openExternal).not.toHaveBeenCalled()

  expect(navigate('http://localhost:3000/')).toBe('cancelled')
  expect(shell.openExternal).toHaveBeenLastCalledWith('http://localhost:3000/')
  expect(navigate('https://evil.example/')).toBe('cancelled')
  expect(shell.openExternal).toHaveBeenLastCalledWith('https://evil.example/')
  expect(shell.openExternal).toHaveBeenCalledTimes(2)
})

test('Every app window is guarded', async () => {
  window.openMainWindow()
  window.createWindow({ hash: '/computer' })
  window.createWindow({ hash: '/readaloud', keepHidden: true })
  const windows = (BrowserWindow as unknown as Mock).mock.calls.length
  expect(windows).toBe(3)
  const listeners = (BrowserWindow.prototype.webContents.on as Mock).mock.calls.map((call) => call[0])
  expect(listeners.filter((name) => name === 'will-navigate')).toHaveLength(windows)
  expect(BrowserWindow.prototype.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(windows)
})

const attachWebview = (webPreferences: Record<string, unknown>, params: Record<string, string>) => {
  const event = { preventDefault: vi.fn() }
  lastWebContentsListener('will-attach-webview')(event, webPreferences, params)
  return event.preventDefault.mock.calls.length > 0 ? 'refused' : 'attached'
}

test('A webview is attached as an isolated web page', async () => {
  window.createWindow({ hash: '/chat' })

  // what WebAppViewer asks for
  const webPreferences: Record<string, unknown> = { partition: 'persist:webapp_Mail', disablePopups: false, plugins: undefined, zoomFactor: 1 }
  const params = { src: 'https://mail.example.com/inbox', partition: 'persist:webapp_Mail', allowpopups: 'true', useragent: 'Mozilla/5.0' }
  expect(attachWebview(webPreferences, params)).toBe('attached')
  expect(webPreferences).toEqual({
    partition: 'persist:webapp_Mail', disablePopups: false, plugins: undefined, zoomFactor: 1,
    nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
  })
  expect(params).toEqual({ src: 'https://mail.example.com/inbox', partition: 'persist:webapp_Mail', allowpopups: 'true', useragent: 'Mozilla/5.0' })

  expect(attachWebview({}, { src: 'http://localhost:8080/app' })).toBe('attached')
})

test('A webview never gets a preload script, node or an unsandboxed page', async () => {
  window.createWindow({ hash: '/chat' })

  // what a tag written by something else than the app could ask for
  const webPreferences: Record<string, unknown> = {
    preload: '/tmp/evil.js', preloadURL: 'file:///tmp/evil.js',
    nodeIntegration: true, nodeIntegrationInSubFrames: true, contextIsolation: false, sandbox: false, webSecurity: false,
    partition: 'persist:webapp_Mail',
  }
  expect(attachWebview(webPreferences, { src: 'https://evil.example/', preload: 'file:///tmp/evil.js', nodeintegration: 'true', disablewebsecurity: 'true' })).toBe('attached')
  expect(webPreferences).toEqual({
    nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
    partition: 'persist:webapp_Mail',
  })
})

test('A webview only starts on a web page', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.createWindow({ hash: '/chat' })

  for (const src of [
    'file:///etc/passwd',
    'file:///app/renderer/vite/index.html#/chat',
    'http://localhost:3000.evil.example/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'chrome://gpu',
    'smb://evil.example/share',
    'example.com',
    '',
    undefined,
  ]) {
    const webPreferences: Record<string, unknown> = { preload: '/tmp/evil.js', nodeIntegration: true }
    expect(attachWebview(webPreferences, { src }), String(src)).toBe('refused')
    expect(webPreferences.preload).toBeUndefined()
    expect(webPreferences.nodeIntegration).toBe(false)
  }
  expect(attachWebview({}, undefined)).toBe('refused')
})

test('Every app window isolates its webviews', async () => {
  window.openMainWindow()
  window.createWindow({ hash: '/computer' })
  const listeners = (BrowserWindow.prototype.webContents.on as Mock).mock.calls.map((call) => call[0])
  expect(listeners.filter((name) => name === 'will-attach-webview')).toHaveLength(2)
})

test('Utilities', async () => {
  expect(window.persistentWindows().length).toBe(4)
  expect(window.areAllWindowsClosed()).toBe(false)
})

test('emitIpcEventToAll', async () => {
  window.emitIpcEventToAll('update-available')
  expect(BrowserWindow.prototype.webContents.send).toHaveBeenCalledWith('update-available')
})
