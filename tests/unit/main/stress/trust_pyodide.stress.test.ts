
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { handleSandboxRequest, resetPyodide, runPythonCode } from '@main/pyodide'
import { kSandboxCsp, kSandboxOrigin } from '@main/pyodide_sandbox'
import { createRecordingPage, createSandboxPage, sandbox } from '@tests/mocks/pyodide_sandbox'

// The "embedded" python runtime executes code written by the model and is described as a sandbox
// with no access to the host. Pyodide used to be loaded by the main process: python had the `js`
// module and pyodide.code.run_js, which are the JavaScript realm of whoever loaded it, and any
// JavaScript object python created led back to that realm (process, require, the api keys).
//
// src/main/pyodide.ts now only sends the script, as text, to a hidden window whose renderer is
// sandboxed, has no preload and no Node.js, and whose session answers one made-up origin and
// nothing else. There is no host realm left to reach.
//
// What these tests can and cannot show:
// - "what works" and "the js module" run the real runtime (node_modules/pyodide, no download, no
//   extra packages) through the real script of the sandbox page. vitest has no renderer process,
//   so the page is evaluated in this process: these cases check what python is given, not where
//   it runs.
// - "the host process" checks where it runs: with a page that only records what it is sent,
//   nothing python is evaluated in the process that calls runPythonCode.
// - That the renderer really has no `process` or `require`, no network and no eval was checked in
//   Electron itself (38.2.0, Windows) with the code of this branch; see the pull request.
// Nothing is executed on the host: the tests only read values that prove python can see it.

vi.mock('electron', async () => {
  const { createElectronMock } = await import('@tests/mocks/pyodide_sandbox')
  return createElectronMock()
})

// the runtime is "cached" as far as src/main/pyodide.ts can tell
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 1 })),
    promises: { mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(async () => '{"packages":{}}') },
  }
}))

// what the main process would load if it still ran python itself
const hostLoadPyodide = vi.hoisted(() => vi.fn())

vi.mock('pyodide', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pyodide')>()
  return { ...actual, loadPyodide: hostLoadPyodide }
})

// the real runtime, for the stand-in of the sandbox page
const loadRealPyodide = async (options?: object) => {
  const actual = await vi.importActual<typeof import('pyodide')>('pyodide')
  const { createRequire } = await import('node:module')
  const path = await import('node:path')
  const indexURL = path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json')) + path.sep
  return actual.loadPyodide({ ...options, indexURL, packages: [] })
}

const kCanary = 'canary-7d1f0c'

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  vi.stubEnv('WITSY_TRUST_CANARY', kCanary)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  delete (globalThis as any).witsyTrustMarker
})

afterAll(() => {
  resetPyodide()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('embedded python', () => {

  beforeAll(async () => {
    resetPyodide()
    sandbox.reset()
    sandbox.createPage = () => createSandboxPage(loadRealPyodide)
    expect(await runPythonCode('1 + 1')).toEqual({ result: '2' })
  }, 60000)

  describe('what works', () => {

    test('the value of the last expression is returned', async () => {
      expect(await runPythonCode('sum(range(10))')).toEqual({ result: '45' })
    })

    test('printed text is returned when there is no value', async () => {
      expect(await runPythonCode('print("hello")\nprint("world")')).toEqual({ result: 'hello\nworld' })
    })

    test('an exception is returned as an error', async () => {
      const result = await runPythonCode('raise ValueError("nope")')
      expect(result.result).toBeUndefined()
      expect(result.error).toContain('ValueError: nope')
    })

    test('the files of the host are not visible to python', async () => {
      const hostFile = fileURLToPath(import.meta.url)
      expect(await runPythonCode(`import os\nstr(os.path.exists(${JSON.stringify(hostFile)}))`)).toEqual({ result: 'False' })
      expect(await runPythonCode('import os\nstr(os.environ.get("WITSY_TRUST_CANARY"))')).toEqual({ result: 'None' })
    })

    test('scripts sent together do not mix their output', async () => {
      const [first, second] = await Promise.all([
        runPythonCode('import asyncio\nprint("a1")\nawait asyncio.sleep(0.05)\nprint("a2")'),
        runPythonCode('print("b1")'),
      ])
      expect(first).toEqual({ result: 'a1\na2' })
      expect(second).toEqual({ result: 'b1' })
    })

  })

  // defence in depth: even inside the sandbox page, python is not handed the globals of the page
  describe('the js module', () => {

    test('python cannot identify the process it was loaded by', async () => {
      // `import js` is the global object of the process that loaded pyodide
      const result = await runPythonCode('import js\nstr(js.process.pid)')
      expect(result.result).not.toBe(String(process.pid))
    })

    test('python cannot read the environment through it', async () => {
      const result = await runPythonCode('import js\nstr(js.process.env.WITSY_TRUST_CANARY)')
      expect(JSON.stringify(result)).not.toContain(kCanary)
    })

    test('python cannot learn where the app runs', async () => {
      const result = await runPythonCode('import js\nstr(js.process.cwd())')
      expect(result.result).not.toBe(process.cwd())
    })

    test('python cannot change global objects through it', async () => {
      await runPythonCode('import js\njs.globalThis.witsyTrustMarker = "set from python"')
      expect((globalThis as any).witsyTrustMarker).toBeUndefined()
    })

    test('python cannot evaluate javascript with run_js', async () => {
      const result = await runPythonCode('from pyodide.code import run_js\nrun_js("typeof process.kill")')
      expect(result.result).not.toBe('function')
    })

    test('the js module is empty', async () => {
      expect(await runPythonCode('import js\nstr(len(js.object_keys()))')).toEqual({ result: '0' })
      const result = await runPythonCode('from js import fetch')
      expect(result.result).toBeUndefined()
      expect(result.error).toContain('ImportError')
    })

  })

})

describe('embedded python: the host process', () => {

  // every way python had to the host, the last one being the case that stayed open after `js` was emptied
  const kAttempts: Record<string, string> = {
    'the js module': 'import js\nstr(js.process.env.WITSY_TRUST_CANARY)',
    'run_js': 'from pyodide.code import run_js\nrun_js("process.env.WITSY_TRUST_CANARY")',
    'a javascript object it creates': 'from pyodide.ffi import to_js\nstr(to_js([1]).constructor.constructor("return process.pid")())',
  }

  let page: ReturnType<typeof createRecordingPage>

  beforeEach(() => {
    resetPyodide()
    sandbox.reset()
    hostLoadPyodide.mockClear()
    page = createRecordingPage((code) => code.includes('.init(') ? true : { result: 'answer of the sandbox' })
    sandbox.createPage = () => page
  })

  test.each(Object.entries(kAttempts))('python cannot reach the host through %s', async (name, script) => {

    const result = await runPythonCode(script)

    // any JsProxy has a constructor, and the constructor of that is the Function of the realm python
    // runs in. That realm is no longer this process: nothing of the script was evaluated here.
    expect(result).toEqual({ result: 'answer of the sandbox' })
    expect(result.result).not.toBe(String(process.pid))
    expect(JSON.stringify(result)).not.toContain(kCanary)
    expect(hostLoadPyodide).not.toHaveBeenCalled()

    // it was sent, as a string literal, to the one sandbox window
    expect(sandbox.windows).toHaveLength(1)
    expect(sandbox.windows[0].url).toBe(`${kSandboxOrigin}/index.html`)
    expect(page.calls).toHaveLength(2)
    expect(page.calls[1]).toBe(`witsyPyodide.run(${JSON.stringify(script)})`)

    // whose renderer has the chromium sandbox, no node and no bridge to the app
    const { webPreferences } = sandbox.windows[0].options
    expect(webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
    expect(webPreferences.preload).toBeUndefined()
    expect(webPreferences.session).toBe(sandbox.session)

  })

  test('the sandbox has no network to send anything to', async () => {

    await runPythonCode('1 + 1')

    // http and https are answered by the main process, which serves the runtime and nothing else
    const handled = Object.fromEntries(sandbox.session.protocol.handle.mock.calls)
    expect(Object.keys(handled).sort()).toEqual(['http', 'https'])
    expect((await handled.http({ url: 'http://127.0.0.1:8090/api/complete', method: 'POST' })).status).toBe(403)
    expect((await handled.https({ url: 'https://example.com/collect', method: 'GET' })).status).toBe(403)
    expect((await handled.https({ url: `${kSandboxOrigin}/collect?canary=1`, method: 'GET' })).status).toBe(404)
    expect(handled.https).toBe(handleSandboxRequest)

    // everything else is cancelled before it starts
    const [filter] = sandbox.session.webRequest.onBeforeRequest.mock.calls[0]
    for (const url of ['https://example.com/', 'http://169.254.169.254/latest/meta-data/', 'wss://example.com/', 'file:///etc/passwd']) {
      const callback = vi.fn()
      filter({ url }, callback)
      expect(callback, url).toHaveBeenCalledWith({ cancel: true })
    }

  })

  test('the sandbox page cannot turn a string into javascript', async () => {
    // `constructor.constructor("...")` is eval: the policy of the page allows scripts from its own origin and WebAssembly only
    const response = await handleSandboxRequest({ url: `${kSandboxOrigin}/index.html`, method: 'GET' })
    const policy = response.headers.get('content-security-policy')
    expect(policy).toBe(kSandboxCsp)
    expect(policy).toContain(`script-src 'self' 'wasm-unsafe-eval'`)
    expect(policy).not.toContain(`'unsafe-eval'`)
    expect(policy).not.toContain(`'unsafe-inline'`)
  })

})
