
import { vi } from 'vitest'
import { kSandboxApi, kSandboxRunner } from '@main/pyodide_sandbox'

// Stand-ins for the Electron side of the Python sandbox (src/main/pyodide.ts): the hidden window,
// its session, and the page the window loads. The page stand-in evaluates the real runner script,
// the one the sandbox window gets, against whatever `loadPyodide` a test provides.

export type SandboxPage = {
  executeJavaScript: (code: string) => Promise<unknown>
}

type Listener = (...args: any[]) => void

export class FakeSandboxWindow {

  options: any
  url: string | null = null
  page: SandboxPage | null = null
  destroyed = false
  listeners: Record<string, Listener[]> = {}
  contentsListeners: Record<string, Listener[]> = {}

  webContents = {
    executeJavaScript: vi.fn(async (code: string) => {
      if (this.destroyed || !this.page) throw new Error('Object has been destroyed')
      return this.page.executeJavaScript(code)
    }),
    on: vi.fn((event: string, listener: Listener) => {
      (this.contentsListeners[event] ??= []).push(listener)
    }),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
  }

  loadURL = vi.fn(async (url: string) => {
    this.url = url
    this.page = sandbox.createPage()
  })

  on = vi.fn((event: string, listener: Listener) => {
    (this.listeners[event] ??= []).push(listener)
  })

  isDestroyed = vi.fn(() => this.destroyed)

  destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  })

  constructor(options: any) {
    this.options = options
    sandbox.windows.push(this)
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners[event] ?? []) listener(...args)
  }

  emitContents(event: string, ...args: any[]) {
    for (const listener of this.contentsListeners[event] ?? []) listener(...args)
  }

}

export const createFakeSession = () => ({
  protocol: { handle: vi.fn() },
  webRequest: { onBeforeRequest: vi.fn() },
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  on: vi.fn(),
})

// shared between the electron mock and the tests
export const sandbox = {
  windows: [] as FakeSandboxWindow[],
  session: createFakeSession(),
  // what a window gets when it loads the sandbox url
  createPage: (): SandboxPage => { throw new Error('no sandbox page defined for this test') },
  reset() {
    this.windows = []
    this.session = createFakeSession()
  },
}

/**
 * What `vi.mock('electron', ...)` returns in the tests of the Python sandbox.
 */
export const createElectronMock = () => ({
  app: { getPath: vi.fn(() => 'userdata') },
  BrowserWindow: FakeSandboxWindow,
  session: { fromPartition: vi.fn(() => sandbox.session) },
})

/**
 * A page that runs the real runner script. Calls made through webContents.executeJavaScript are
 * expressions on the object the runner installs, and are evaluated the same way here.
 */
export const createSandboxPage = (loadPyodide: (options: any) => Promise<any>): SandboxPage => {
  const page: Record<string, any> = {}
  new Function('loadPyodide', 'globalThis', kSandboxRunner)(loadPyodide, page)
  return {
    executeJavaScript: async (code: string) => new Function(kSandboxApi, `return ${code}`)(page[kSandboxApi]),
  }
}

/**
 * A page that evaluates nothing and remembers what it was asked.
 */
export const createRecordingPage = (answer: (code: string) => unknown = () => ({ result: 'recorded' })): SandboxPage & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    executeJavaScript: async (code: string) => {
      calls.push(code)
      return answer(code)
    },
  }
}
