
import { vi, beforeEach, afterEach, expect, test, describe } from 'vitest'
import crypto from 'node:crypto'
import { handleSandboxRequest, isPyodideInitialized, isPyodideSandboxWindow, resetPyodide, runPythonCode } from '@main/pyodide'
import { kSandboxCsp, kSandboxOrigin, kSandboxRunner } from '@main/pyodide_sandbox'
import { createRecordingPage, createSandboxPage, sandbox } from '@tests/mocks/pyodide_sandbox'
import fs from 'fs'

// Mock electron: the sandbox window, its session and the page it loads
vi.mock('electron', async () => {
  const { createElectronMock } = await import('@tests/mocks/pyodide_sandbox')
  return createElectronMock()
})

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
    }
  }
}))

// Mock path (use real implementation)
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { default: actual }
})

// Mock fetch
global.fetch = vi.fn()

// The runtime is never loaded by the main process: if it were, this would be called
vi.mock('pyodide', () => ({
  loadPyodide: vi.fn(() => { throw new Error('pyodide must not be loaded in the main process') }),
}))

const kPackages = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'statsmodels', 'matplotlib']

const sha256 = (content: string) => crypto.createHash('sha256').update(Buffer.from(content)).digest('hex')

const get = (pathname: string, method = 'GET', origin = kSandboxOrigin) => handleSandboxRequest({ url: `${origin}${pathname}`, method })

describe('Pyodide Manager', () => {
  let mockPyodide: any
  let mockLoadPyodide: any

  beforeEach(async () => {
    // Reset state
    vi.clearAllMocks()
    vi.clearAllTimers()
    resetPyodide()
    sandbox.reset()

    // Setup default fs mocks (cache exists)
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any)
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined)
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('cached') as any)

    // Mock fetch
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
    } as any)

    // Create mock Pyodide instance
    mockPyodide = {
      runPythonAsync: vi.fn(),
      setStdout: vi.fn(),
    }

    // What the page of the sandbox gets as `loadPyodide`
    mockLoadPyodide = vi.fn().mockResolvedValue(mockPyodide)
    sandbox.createPage = () => createSandboxPage(mockLoadPyodide)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('should initialize Pyodide on first call', async () => {
    expect(isPyodideInitialized()).toBe(false)

    mockPyodide.runPythonAsync.mockResolvedValue(42)

    const result = await runPythonCode('2 + 2')

    expect(isPyodideInitialized()).toBe(true)
    expect(result).toEqual({ result: '42' })
  })

  test('should reuse Pyodide instance', async () => {
    // First call initializes
    mockPyodide.runPythonAsync.mockResolvedValue(10)
    await runPythonCode('5 + 5')

    const callCountAfterFirst = mockLoadPyodide.mock.calls.length

    // Second call should reuse
    mockPyodide.runPythonAsync.mockResolvedValue(20)
    await runPythonCode('10 + 10')

    // loadPyodide should not be called again, and there is still one window
    expect(mockLoadPyodide.mock.calls.length).toBe(callCountAfterFirst)
    expect(sandbox.windows).toHaveLength(1)
  })

  test('should execute simple Python code', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue(100)

    const result = await runPythonCode('50 * 2')

    expect(mockPyodide.runPythonAsync).toHaveBeenCalledWith('50 * 2')
    expect(result).toEqual({ result: '100' })
  })

  test('should handle string results', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue('hello world')

    const result = await runPythonCode('"hello" + " world"')

    expect(result).toEqual({ result: 'hello world' })
  })

  test('should handle object results as JSON', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue({ foo: 'bar', num: 123 })

    const result = await runPythonCode('{"foo": "bar", "num": 123}')

    expect(result.result).toContain('"foo"')
    expect(result.result).toContain('"bar"')
    expect(result.result).toContain('123')
  })

  test('should handle None/undefined results', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue(undefined)

    const result = await runPythonCode('None')

    expect(result).toEqual({ result: 'undefined' })
  })

  test('should handle null results', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue(null)

    const result = await runPythonCode('None')

    expect(result).toEqual({ result: 'null' })
  })

  test('should capture stdout from print statements', async () => {
    // Mock stdout capture
    let stdoutCallback: ((msg: string) => void) | null = null
    mockPyodide.setStdout.mockImplementation((opts: any) => {
      stdoutCallback = opts.batched
    })
    mockPyodide.runPythonAsync.mockImplementation(async () => {
      // Simulate print output
      if (stdoutCallback) {
        stdoutCallback('Hello from Python')
      }
      return undefined
    })

    const result = await runPythonCode('print("Hello from Python")')

    expect(mockPyodide.setStdout).toHaveBeenCalled()
    expect(result).toEqual({ result: 'Hello from Python' })
  })

  test('should use return value and ignore stdout when both present', async () => {
    let stdoutCallback: ((msg: string) => void) | null = null
    mockPyodide.setStdout.mockImplementation((opts: any) => {
      stdoutCallback = opts.batched
    })
    mockPyodide.runPythonAsync.mockImplementation(async () => {
      if (stdoutCallback) {
        stdoutCallback('Debug output')
      }
      return 42
    })

    const result = await runPythonCode('print("Debug output"); 21 * 2')

    // Should only return the result, not stdout
    expect(result).toEqual({ result: '42' })
  })

  test('should handle Python errors', async () => {
    mockPyodide.runPythonAsync.mockRejectedValue(new Error('NameError: name "undefined_var" is not defined'))

    const result = await runPythonCode('print(undefined_var)')

    expect(result.error).toContain('NameError')
  })

  test('should handle initialization errors', async () => {
    mockLoadPyodide.mockRejectedValue(new Error('Failed to load WASM'))

    const result = await runPythonCode('1 + 1')

    expect(result.error).toContain('Failed to initialize Pyodide')
    expect(result.error).toContain('Failed to load WASM')

    // the sandbox that failed is not kept
    expect(isPyodideInitialized()).toBe(false)
    expect(sandbox.windows[0].destroy).toHaveBeenCalled()
  })

  test('should handle non-Error exceptions', async () => {
    mockPyodide.runPythonAsync.mockRejectedValue('String error')

    const result = await runPythonCode('bad code')

    expect(result.error).toBe('String error')
  })

  test('should refuse a script that is not a string', async () => {
    const result = await runPythonCode({ toString: () => 'print(1)' } as any)

    expect(result.error).toBe('The script must be a string')
    expect(sandbox.windows).toHaveLength(0)
  })

  test('should load the runtime in the sandbox page, from the sandbox origin', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue(42)

    await runPythonCode('1+1')

    // no indexURL: the page loads pyodide.js from its own origin, which the main process answers from the cache
    expect(sandbox.windows[0].loadURL).toHaveBeenCalledWith(`${kSandboxOrigin}/index.html`)
    expect(mockLoadPyodide).toHaveBeenCalledWith({
      packages: kPackages,
      jsglobals: expect.any(Object),
    })
  })

  test('should not give python the globals of the page', async () => {
    mockPyodide.runPythonAsync.mockResolvedValue(42)

    await runPythonCode('1+1')

    expect(mockLoadPyodide).toHaveBeenCalledTimes(1)
    const [options] = mockLoadPyodide.mock.calls[0]
    expect(options.jsglobals).not.toBe(globalThis)
    expect(Object.getPrototypeOf(options.jsglobals)).toBeNull()
    expect(Reflect.ownKeys(options.jsglobals)).toEqual([])
  })

  test('should download files if cache incomplete', async () => {
    // Simulate cache not existing
    vi.mocked(fs.existsSync).mockReturnValue(false)

    mockPyodide.runPythonAsync.mockResolvedValue(42)

    await runPythonCode('1+1')

    // Should have created directory
    expect(fs.promises.mkdir).toHaveBeenCalled()

    // Should have downloaded files
    expect(global.fetch).toHaveBeenCalled()
    expect(fs.promises.writeFile).toHaveBeenCalled()
  })

  test('should report a runtime that cannot be downloaded', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(global.fetch).mockResolvedValue({ ok: false, statusText: 'Service Unavailable' } as any)

    const result = await runPythonCode('1+1')

    expect(result.error).toContain('Failed to initialize Pyodide')
    expect(result.error).toContain('Service Unavailable')
    expect(sandbox.windows).toHaveLength(0)
  })

  test('should dispose Pyodide after TTL expires', async () => {
    vi.useFakeTimers()

    mockPyodide.runPythonAsync.mockResolvedValue(42)

    await runPythonCode('1+1')
    expect(isPyodideInitialized()).toBe(true)

    // Advance time past TTL (15 minutes)
    vi.advanceTimersByTime(16 * 60 * 1000)

    // the window, and with it the renderer process, is gone
    expect(isPyodideInitialized()).toBe(false)
    expect(sandbox.windows[0].destroy).toHaveBeenCalled()
  })

  test('should reset TTL on subsequent use', async () => {
    vi.useFakeTimers()

    mockPyodide.runPythonAsync.mockResolvedValue(42)

    // First call
    await runPythonCode('1+1')
    expect(isPyodideInitialized()).toBe(true)

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000)

    // Second call resets timer
    await runPythonCode('2+2')
    expect(isPyodideInitialized()).toBe(true)

    // Advance another 10 minutes (20 total, but timer was reset)
    vi.advanceTimersByTime(10 * 60 * 1000)

    // Should still be alive
    expect(isPyodideInitialized()).toBe(true)

    // Advance another 6 minutes (now 16 from last use)
    vi.advanceTimersByTime(6 * 60 * 1000)

    // Should be disposed now
    expect(isPyodideInitialized()).toBe(false)
  })

  test('should reinitialize after disposal', async () => {
    vi.useFakeTimers()

    mockPyodide.runPythonAsync.mockResolvedValue(42)

    // First use
    await runPythonCode('1+1')
    const firstCallCount = mockLoadPyodide.mock.calls.length

    // Dispose
    vi.advanceTimersByTime(16 * 60 * 1000)
    expect(isPyodideInitialized()).toBe(false)

    // Use again
    await runPythonCode('2+2')

    // Should have reinitialized
    expect(isPyodideInitialized()).toBe(true)
    expect(mockLoadPyodide.mock.calls.length).toBe(firstCallCount + 1)
    expect(sandbox.windows).toHaveLength(2)
  })

})

describe('Pyodide sandbox window', () => {

  let page: ReturnType<typeof createRecordingPage>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.clearAllTimers()
    resetPyodide()
    sandbox.reset()
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any)
    page = createRecordingPage()
    sandbox.createPage = () => page
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('is a sandboxed renderer without node, preload or a visible window', async () => {
    await runPythonCode('1+1')

    expect(sandbox.windows).toHaveLength(1)
    const { options } = sandbox.windows[0]
    expect(options.show).toBe(false)
    expect(options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
    })
    expect(options.webPreferences.preload).toBeUndefined()
    expect(options.webPreferences.session).toBe(sandbox.session)
  })

  test('uses an in-memory session of its own', async () => {
    const { session } = await import('electron')

    await runPythonCode('1+1')
    await runPythonCode('2+2')

    expect(session.fromPartition).toHaveBeenCalledTimes(1)
    const [partition] = vi.mocked(session.fromPartition).mock.calls[0]
    expect(partition).toBe('pyodide-sandbox')
    expect(partition.startsWith('persist:')).toBe(false)
  })

  test('answers https itself and lets nothing else through', async () => {
    await runPythonCode('1+1')

    // http and https never reach the network
    const handled = Object.fromEntries(sandbox.session.protocol.handle.mock.calls)
    expect(handled.https).toBe(handleSandboxRequest)
    expect((await handled.http({ url: 'http://example.com/', method: 'GET' })).status).toBe(403)

    // any request that is not for the sandbox origin is cancelled
    const [filter] = sandbox.session.webRequest.onBeforeRequest.mock.calls[0]
    const cancelled = (url: string) => {
      const callback = vi.fn()
      filter({ url }, callback)
      return callback.mock.calls[0][0].cancel
    }
    expect(cancelled(`${kSandboxOrigin}/pyodide.js`)).toBe(false)
    expect(cancelled('https://example.com/')).toBe(true)
    expect(cancelled('http://127.0.0.1:8090/api/complete')).toBe(true)
    expect(cancelled('wss://example.com/socket')).toBe(true)
    expect(cancelled('file:///etc/passwd')).toBe(true)
    expect(cancelled(`${kSandboxOrigin}.example.com/pyodide.js`)).toBe(true)
  })

  test('refuses every permission and download', async () => {
    await runPythonCode('1+1')

    const [onRequest] = sandbox.session.setPermissionRequestHandler.mock.calls[0]
    const granted = vi.fn()
    onRequest({}, 'media', granted)
    expect(granted).toHaveBeenCalledWith(false)

    const [onCheck] = sandbox.session.setPermissionCheckHandler.mock.calls[0]
    expect(onCheck({}, 'clipboard-read')).toBe(false)

    const [event, onDownload] = sandbox.session.on.mock.calls[0]
    expect(event).toBe('will-download')
    const download = { preventDefault: vi.fn() }
    onDownload(download)
    expect(download.preventDefault).toHaveBeenCalled()
  })

  test('cannot navigate, open windows or attach webviews', async () => {
    await runPythonCode('1+1')

    const win = sandbox.windows[0]
    const [openHandler] = win.webContents.setWindowOpenHandler.mock.calls[0]
    expect(openHandler({ url: 'https://example.com/' })).toEqual({ action: 'deny' })

    for (const event of ['will-navigate', 'will-attach-webview']) {
      const navigation = { preventDefault: vi.fn() }
      win.emitContents(event, navigation)
      expect(navigation.preventDefault).toHaveBeenCalled()
    }
  })

  test('gets the script as a string literal, never as code', async () => {
    const script = 'x = "\\"); globalThis.pwned = true; (\\""\n`${process.pid}`\n</script> '

    await runPythonCode(script)

    expect(page.calls).toEqual([
      `witsyPyodide.init(${JSON.stringify(kPackages)})`,
      `witsyPyodide.run(${JSON.stringify(script)})`,
    ])

    // evaluating the call gives the script back, unchanged, as the one argument of run()
    const run = vi.fn()
    new Function('witsyPyodide', page.calls[1])({ run })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(script)
    expect((globalThis as any).pwned).toBeUndefined()
  })

  test('only strings are taken from what the sandbox answers', async () => {
    const answers: unknown[] = [
      { result: { toString: () => 'object' } },
      { result: 42 },
      { error: { message: 'object' } },
      null,
      'text',
      { result: 'fine', error: 'but failed' },
      { result: 'fine' },
    ]
    page = createRecordingPage((code) => code.includes('.init(') ? true : answers.shift())
    sandbox.createPage = () => page

    const kUnexpected = { error: 'Unexpected response from the Python sandbox' }
    expect(await runPythonCode('1')).toEqual(kUnexpected)
    expect(await runPythonCode('2')).toEqual(kUnexpected)
    expect(await runPythonCode('3')).toEqual(kUnexpected)
    expect(await runPythonCode('4')).toEqual(kUnexpected)
    expect(await runPythonCode('5')).toEqual(kUnexpected)
    expect(await runPythonCode('6')).toEqual({ error: 'but failed' })
    expect(await runPythonCode('7')).toEqual({ result: 'fine' })
  })

  test('a script that does not finish is stopped with its sandbox', async () => {
    vi.useFakeTimers()

    // init answers, run never does
    page = createRecordingPage((code) => code.includes('.init(') ? true : new Promise(() => {}))
    sandbox.createPage = () => page

    const pending = runPythonCode('while True:\n    pass')
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)

    expect(await pending).toEqual({ error: 'Python execution timed out after 300 seconds' })
    expect(sandbox.windows[0].destroy).toHaveBeenCalled()
    expect(isPyodideInitialized()).toBe(false)

    // the next script gets a new sandbox
    sandbox.createPage = () => createRecordingPage()
    expect(await runPythonCode('1+1')).toEqual({ result: 'recorded' })
    expect(sandbox.windows).toHaveLength(2)
    expect(sandbox.windows[1].destroy).not.toHaveBeenCalled()
  })

  test('scripts run one after the other', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    page = createRecordingPage((code) => {
      if (code.includes('.init(')) return true
      order.push(`start ${code}`)
      if (code.includes('"first"')) {
        return new Promise((resolve) => { release = () => { order.push('end first'); resolve({ result: 'first' }) } })
      }
      return { result: 'second' }
    })
    sandbox.createPage = () => page

    const first = runPythonCode('first')
    const second = runPythonCode('second')
    await vi.waitFor(() => expect(order).toEqual(['start witsyPyodide.run("first")']))

    release()
    expect(await first).toEqual({ result: 'first' })
    expect(await second).toEqual({ result: 'second' })
    expect(order).toEqual(['start witsyPyodide.run("first")', 'end first', 'start witsyPyodide.run("second")'])
  })

  test('a sandbox process that dies is replaced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runPythonCode('1+1')
    const win = sandbox.windows[0]
    expect(isPyodideSandboxWindow(win as any)).toBe(true)

    win.emitContents('render-process-gone', {}, { reason: 'oom' })
    expect(isPyodideInitialized()).toBe(false)
    expect(win.destroy).toHaveBeenCalled()
    expect(isPyodideSandboxWindow(win as any)).toBe(false)

    expect(await runPythonCode('2+2')).toEqual({ result: 'recorded' })
    expect(sandbox.windows).toHaveLength(2)
  })

  test('is told apart from the windows of the app', async () => {
    expect(isPyodideSandboxWindow(null)).toBe(false)
    expect(isPyodideSandboxWindow(undefined)).toBe(false)

    await runPythonCode('1+1')

    expect(isPyodideSandboxWindow(sandbox.windows[0] as any)).toBe(true)
    expect(isPyodideSandboxWindow({} as any)).toBe(false)
  })

})

describe('Pyodide sandbox requests', () => {

  const kWheel = 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl'
  const kWheelContent = 'wheel bytes'

  // file name -> content of what is in the cache
  let cached: Record<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetPyodide()
    sandbox.reset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    cached = {
      'pyodide.js': 'runtime loader',
      'pyodide.asm.wasm': 'wasm',
      'pyodide-lock.json': JSON.stringify({
        packages: {
          numpy: { file_name: kWheel, sha256: sha256(kWheelContent) },
          broken: { file_name: 42 },
        }
      }),
    }

    const name = (file: unknown) => String(file).split(/[\\/]/).pop()
    vi.mocked(fs.existsSync).mockImplementation((file) => name(file) in cached)
    vi.mocked(fs.statSync).mockImplementation(((file: unknown) => ({ size: cached[name(file)].length })) as any)
    vi.mocked(fs.promises.readFile).mockImplementation((async (file: unknown) => {
      if (!(name(file) in cached)) throw new Error('ENOENT')
      return Buffer.from(cached[name(file)])
    }) as any)
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined)
    vi.mocked(global.fetch).mockImplementation((async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(kWheelContent).buffer,
    })) as any)
  })

  test('serves the page with a policy that forbids eval and other origins', async () => {
    for (const pathname of ['/', '/index.html']) {
      const response = await get(pathname)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('content-security-policy')).toBe(kSandboxCsp)
      expect(await response.text()).toContain('<script src="runner.js"></script>')
    }

    expect(kSandboxCsp).toContain(`default-src 'none'`)
    expect(kSandboxCsp).toContain(`script-src 'self' 'wasm-unsafe-eval'`)
    expect(kSandboxCsp).toContain(`connect-src 'self'`)
    expect(kSandboxCsp).not.toContain(`'unsafe-eval'`)
    expect(kSandboxCsp).not.toContain(`'unsafe-inline'`)
    expect(kSandboxCsp).not.toMatch(/https?:|\*/)
  })

  test('serves the runner script', async () => {
    const response = await get('/runner.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(kSandboxRunner)
  })

  test('serves the runtime files from the cache', async () => {
    const loader = await get('/pyodide.js')
    expect(loader.status).toBe(200)
    expect(loader.headers.get('content-type')).toBe('text/javascript')
    expect(await loader.text()).toBe('runtime loader')

    // streaming compilation needs this content type
    const wasm = await get('/pyodide.asm.wasm')
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')

    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('serves a cached package of the lock file', async () => {
    cached[kWheel] = kWheelContent

    const response = await get(`/${kWheel}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.text()).toBe(kWheelContent)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('downloads a package of the lock file once, from the pyodide cdn, and checks it', async () => {
    const response = await get(`/${kWheel}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(kWheelContent)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith(`https://cdn.jsdelivr.net/pyodide/v0.29.0/full/${kWheel}`)
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1)
    const [file, content] = vi.mocked(fs.promises.writeFile).mock.calls[0]
    expect(String(file).split(/[\\/]/).slice(-3)).toEqual(['pyodide-cache', '0.29.0', kWheel])
    expect(content.toString()).toBe(kWheelContent)
  })

  test('does not keep or serve a package whose checksum is wrong', async () => {
    vi.mocked(global.fetch).mockImplementation((async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('tampered bytes').buffer,
    })) as any)

    const response = await get(`/${kWheel}`)

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('')
    expect(fs.promises.writeFile).not.toHaveBeenCalled()
  })

  test('serves nothing that is not the runtime or a package of the lock file', async () => {
    const refused = [
      '/evil-1.0-py3-none-any.whl',
      '/settings.json',
      '/..%2F..%2Fsettings.json',
      '/..%5C..%5Csettings.json',
      '/%2e%2e/settings.json',
      '/sub/pyodide.js',
      '/pyodide.js%00.whl',
      '/.env',
      '/C:%5CWindows%5Cwin.ini',
      '/%E0%A4%A',
    ]
    for (const pathname of refused) {
      const response = await get(pathname)
      expect([404, 500], pathname).toContain(response.status)
      expect(await response.text(), pathname).toBe('')
    }
    expect(global.fetch).not.toHaveBeenCalled()
    expect(fs.promises.writeFile).not.toHaveBeenCalled()
  })

  test('answers its own origin only, and only to GET', async () => {
    expect((await get('/pyodide.js', 'POST')).status).toBe(403)
    expect((await get('/pyodide.js', 'PUT')).status).toBe(403)
    expect((await get('/pyodide.js', 'GET', 'https://example.com')).status).toBe(403)
    expect((await get('/pyodide.js', 'GET', 'https://cdn.jsdelivr.net')).status).toBe(403)
    expect((await get('/pyodide.js', 'GET', `${kSandboxOrigin}.example.com`)).status).toBe(403)
    expect((await get('/pyodide.js', 'GET', kSandboxOrigin.replace('https:', 'http:'))).status).toBe(403)
    expect((await handleSandboxRequest({ url: 'not a url', method: 'GET' })).status).toBe(500)
    expect(global.fetch).not.toHaveBeenCalled()
  })

})
