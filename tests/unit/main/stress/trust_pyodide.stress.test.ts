
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resetPyodide, runPythonCode } from '@main/pyodide'
import { bug } from './bug'

// The "embedded" python runtime executes code written by the model inside the main process and
// is described as a sandbox with no access to the host. Pyodide gives python the `js` module and
// pyodide.code.run_js, which are the JavaScript realm of whoever loaded it: here, the main process.
// The real runtime is loaded once from node_modules/pyodide (no download, no extra packages).
// Nothing is executed on the host: the tests only read values that prove python can see it.

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'userdata') } }))

// the runtime is "cached" as far as src/main/pyodide.ts can tell
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 1 })),
    promises: { mkdir: vi.fn(), writeFile: vi.fn() },
  }
}))

vi.mock('pyodide', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pyodide')>()
  const { createRequire } = await import('node:module')
  const path = await import('node:path')
  const indexURL = path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json')) + path.sep
  return { ...actual, loadPyodide: vi.fn(() => actual.loadPyodide({ indexURL, packages: [] })) }
})

const kCanary = 'canary-7d1f0c'

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  vi.stubEnv('WITSY_TRUST_CANARY', kCanary)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await runPythonCode('1 + 1')).toEqual({ result: '2' })
}, 60000)

afterEach(() => {
  delete (globalThis as any).witsyTrustMarker
})

afterAll(() => {
  resetPyodide()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('embedded python: what works', () => {

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

})

describe('embedded python: the host process', () => {

  bug('python cannot identify the host process', async () => {
    // `import js` is the global object of the process that loaded pyodide
    const result = await runPythonCode('import js\nstr(js.process.pid)')
    expect(result.result).not.toBe(String(process.pid))
  })

  bug('python cannot read the environment of the host process', async () => {
    // js.process.env holds the api keys and tokens the app was started with
    const result = await runPythonCode('import js\nstr(js.process.env.WITSY_TRUST_CANARY)')
    expect(JSON.stringify(result)).not.toContain(kCanary)
  })

  bug('python cannot learn where the app runs', async () => {
    // js.process.cwd() is called in the host, not in the wasm file system
    const result = await runPythonCode('import js\nstr(js.process.cwd())')
    expect(result.result).not.toBe(process.cwd())
  })

  bug('python cannot change the global objects of the host', async () => {
    // attributes set on js.globalThis land on the global object of the main process
    await runPythonCode('import js\njs.globalThis.witsyTrustMarker = "set from python"')
    expect((globalThis as any).witsyTrustMarker).toBeUndefined()
  })

  bug('python cannot evaluate javascript in the host', async () => {
    // pyodide.code.run_js is eval in the host: process.kill, and from there every node module, is a call away
    const result = await runPythonCode('from pyodide.code import run_js\nrun_js("typeof process.kill")')
    expect(result.result).not.toBe('function')
  })

})
