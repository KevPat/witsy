
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import * as IPC from '@/ipc_consts'
import { bug } from './bug'

// Every dependency of ipc.ts is replaced by a "magic" double: any property is a callable double, any call returns
// another one (or throws / rejects when state.failing is set). This lets the test drive all IPC handlers without
// touching the file system, the network or the OS.
const { state, magic, mod } = vi.hoisted(() => {

  const state = {
    failing: false,
    calls: [] as string[],
    on: new Map<string, (...args: any[]) => any>(),
    handle: new Map<string, (...args: any[]) => any>(),
  }

  const magic = (name: string, canFail: boolean): any => {
    const children = new Map<string | symbol, any>()
    const target = function() { /* callable proxy target */ }
    return new Proxy(target, {
      get(_, prop) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
        if (prop === Symbol.toPrimitive) return () => '{}'
        if (prop === Symbol.iterator) return function* () { /* empty */ }
        if (prop === 'toJSON') return () => ({})
        if (prop === '__esModule') return true
        if (prop === 'length') return 0
        if (typeof prop === 'symbol') return undefined
        if (!children.has(prop)) children.set(prop, magic(`${name}.${prop}`, canFail))
        return children.get(prop)
      },
      has() { return true },
      apply() {
        state.calls.push(name)
        if (canFail && state.failing) throw new Error(`${name} failed`)
        return magic(`${name}()`, canFail)
      },
      construct() {
        return magic(`new ${name}`, canFail)
      },
    })
  }

  // vi.mock factories must return an object, not a function
  const mod = (name: string, canFail: boolean, overrides: Record<string, any> = {}): any => {
    const inner = magic(name, canFail)
    return new Proxy({}, {
      get: (_, prop) => prop in overrides ? overrides[prop as string] : inner[prop],
      has: () => true,
    })
  }

  return { state, magic, mod }
})

vi.mock('electron', () => mod('electron', false, {
  ipcMain: {
    on: (channel: string, handler: (...args: any[]) => any) => state.on.set(channel, handler),
    handle: (channel: string, handler: (...args: any[]) => any) => state.handle.set(channel, handler),
  }
}))

vi.mock('electron-store', () => mod('electron-store', false))
vi.mock('font-list', () => mod('font-list', true))
vi.mock('multi-llm-ts', () => mod('multi-llm-ts', false))
vi.mock('@main/utils', () => mod('utils', true))
vi.mock('@main/automations/anywhere', () => mod('anywhere', true))
vi.mock('@main/automations/automation', () => mod('automation', true))
vi.mock('@main/automations/commander', () => mod('commander', true))
vi.mock('@main/automations/dictation', () => mod('dictation', true))
vi.mock('@main/keymonitor', () => mod('keymonitor', true))
vi.mock('@main/rag/docrepo', () => mod('docrepo', true))
vi.mock('@main/rag/embedder', () => mod('embedder', true))
vi.mock('@main/autoupdate', () => mod('autoupdate', true))
vi.mock('@main/computer', () => mod('computer', true))
vi.mock('@main/mcp', () => mod('mcp', true))
vi.mock('@main/memory', () => mod('memory', true))
vi.mock('@main/permissions', () => mod('permissions', true))
vi.mock('@main/search', () => mod('search', true))
vi.mock('@main/agents', () => mod('agents', true))
vi.mock('@main/agent_tracker', () => mod('agent_tracker', true))
vi.mock('@main/pyodide', () => mod('pyodide', true))
vi.mock('@main/backup', () => mod('backup', true))
vi.mock('@main/cli_installer', () => mod('cli_installer', true))
vi.mock('@main/code_exec', () => mod('code_exec', true))
vi.mock('@main/commands', () => mod('commands', true))
vi.mock('@main/config', () => mod('config', true))
vi.mock('@main/experts', () => mod('experts', true))
vi.mock('@main/file', () => mod('file', true))
vi.mock('@main/media_file', () => mod('media_file', true))
vi.mock('@main/google', () => mod('google', true))
vi.mock('@main/history', () => mod('history', true))
vi.mock('@main/i18n', () => mod('i18n', true))
vi.mock('@main/interpreter', () => mod('interpreter', true))
vi.mock('@main/markdown', () => mod('markdown', true))
vi.mock('@main/network', () => mod('network', true))
vi.mock('@main/ollama', () => mod('ollama', true))
vi.mock('@main/pdf', () => mod('pdf', true))
vi.mock('@main/scratchpad', () => mod('scratchpad', true))
vi.mock('@main/shortcuts', () => mod('shortcuts', true))
vi.mock('@main/skills', () => mod('skills', true))
vi.mock('@main/text', () => mod('text', true))
vi.mock('@main/webview', () => mod('webview', true))
vi.mock('@main/window', () => mod('window', true))
vi.mock('@main/stt_apple', () => mod('stt_apple', true))
vi.mock('@main/workspace', () => mod('workspace', true))
vi.mock('@main/youtube', () => mod('youtube', true))
vi.mock('@main/agent_utils', () => mod('agent_utils', true))
vi.mock('@main/agent_webhook', () => mod('agent_webhook', true))
vi.mock('@main/http_server', () => mod('http_server', true))
vi.mock('@main/import_oai', () => mod('import_oai', true))
vi.mock('@main/import_md', () => mod('import_md', true))

// channels the preload script calls with ipcRenderer.sendSync: the renderer is frozen until event.returnValue is set
const syncChannels = (): string[] => {
  const preload = fs.readFileSync(path.join(__dirname, '../../../../src/preload.ts'), 'utf-8')
  const channels = new Set<string>()
  for (const match of preload.matchAll(/sendSync\(IPC\.([A-Z0-9_]+)\.([A-Z0-9_]+)/g)) {
    channels.add((IPC as any)[match[1]][match[2]])
  }
  return [...channels]
}

const UNSET = Symbol('unset')

const invokeSync = async (channel: string, payload: any): Promise<{ replied: boolean, threw: boolean }> => {
  let value: any = UNSET
  const event = {
    sender: magic('sender', false),
    senderFrame: magic('senderFrame', false),
    get returnValue() { return value },
    set returnValue(v: any) { value = v },
  }
  let threw = false
  try {
    await state.on.get(channel)!(event, payload, payload, payload)
  } catch {
    threw = true
  }
  return { replied: value !== UNSET, threw }
}

// only defined by Electron
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

afterAll(() => {
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
  else delete (process as any).resourcesPath
})

beforeAll(async () => {
  Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true })
  const { installIpc } = await import('@main/ipc')
  installIpc(magic('store', true), magic('autoUpdater', true), magic('docRepo', true), magic('memoryManager', true), magic('mcp', true), vi.fn(), vi.fn(), vi.fn())
})

beforeEach(() => {
  state.failing = false
  state.calls.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('IPC surface', () => {

  test('every channel called synchronously by the preload script has a handler', () => {
    const channels = syncChannels()
    expect(channels.length).toBeGreaterThan(80)
    expect(channels.filter(channel => !state.on.has(channel))).toEqual([])
  })

  test('no channel is registered both as a listener and as an invoke handler', () => {
    expect([...state.on.keys()].filter(channel => state.handle.has(channel))).toEqual([])
  })

  test('every synchronous handler replies when its implementation succeeds', async () => {
    const silent: string[] = []
    for (const channel of syncChannels()) {
      const replies = []
      for (const payload of [magic('payload', false), '{}', 'text']) {
        replies.push((await invokeSync(channel, payload)).replied)
      }
      if (!replies.includes(true)) silent.push(channel)
    }
    expect(silent).toEqual([])
  })

  bug('every synchronous handler replies when its implementation throws', async () => {
    // most handlers are `event.returnValue = impl(...)` with no try/catch: one exception leaves the calling window frozen
    state.failing = true
    const silent: string[] = []
    for (const channel of syncChannels()) {
      const { replied } = await invokeSync(channel, magic('payload', false))
      if (!replied) silent.push(channel)
    }
    expect(silent).toEqual([])
  })

  bug.each([
    [undefined],
    [null],
    ['not json'],
    [42],
  ])('every synchronous handler replies to a malformed payload: %s', async (payload) => {
    // JSON.parse and destructuring of the payload happen before returnValue is assigned
    const silent: string[] = []
    for (const channel of syncChannels()) {
      const { replied } = await invokeSync(channel, payload)
      if (!replied) silent.push(channel)
    }
    expect(silent).toEqual([])
  })

  test('fuzz: invoke handlers reject instead of throwing synchronously or hanging on malformed payloads', async () => {
    for (const [channel, handler] of state.handle) {
      for (const payload of [undefined, null, '', 'not json', 42, [], {}]) {
        let result: any
        try {
          result = handler({ sender: magic('sender', false) }, payload, payload, payload)
        } catch {
          continue
        }
        await expect(Promise.race([
          Promise.resolve(result).then(() => 'settled', () => 'settled'),
          new Promise((resolve) => setImmediate(() => setImmediate(() => resolve('pending')))),
        ]), channel).resolves.toBe('settled')
      }
    }
  })

})

describe('IPC sender checks', () => {

  const untrusted = () => ({
    sender: { id: 99, getURL: () => 'https://evil.example/page', once: vi.fn(), send: vi.fn() },
    senderFrame: { url: 'https://evil.example/page', origin: 'https://evil.example', parent: null },
    returnValue: undefined as any,
  })

  bug.each([
    ['delete a file', IPC.FILE.DELETE_FILE, 'on', 'file.deleteFile', '/home/me/.ssh/id_rsa'],
    ['read a file', IPC.FILE.READ_FILE, 'on', 'file.getFileContents', '/home/me/.ssh/id_rsa'],
    ['write a file', IPC.FILE.WRITE_FILE, 'on', 'file.writeFile', '/home/me/.bashrc'],
    ['look up a program through a shell', IPC.FILE.FIND_PROGRAM, 'on', 'file.findProgram', 'x; id'],
    ['run native python', IPC.INTERPRETER.PYTHON_RUN, 'handle', 'interpreter.runPython', 'import os'],
    ['install an MCP server', IPC.MCP.INSTALL_SERVER, 'handle', 'mcp.installServer', { registry: 'smithery', server: 'x' }],
  ])('a frame that is not the app cannot %s', async (_, channel, kind, implementation, payload) => {
    // no handler looks at event.senderFrame: any content that gets to run in a window with the preload has the full API
    const handlers = kind === 'on' ? state.on : state.handle
    try {
      await handlers.get(channel)!(untrusted(), payload, payload)
    } catch { /* a rejection is an acceptable way to refuse */ }
    expect(state.calls).not.toContain(implementation)
  })

})
