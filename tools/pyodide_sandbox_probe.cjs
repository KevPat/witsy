#!/usr/bin/env node
//
// Checks the Python sandbox (src/main/pyodide.ts) in a real Electron, without building or starting
// the app: unit tests have no renderer process, so they cannot show where python really runs.
//
//   node tools/pyodide_sandbox_probe.cjs
//
// The first run downloads the Pyodide runtime and its packages (about 60 MB) to a temporary folder.
// Exit code 0 when every check passes. On Linux without a display, run it under xvfb-run.
//

const fs = require('fs')
const os = require('os')
const path = require('path')

const kWorkDir = path.join(os.tmpdir(), 'witsy-pyodide-sandbox-probe')

// started by node: bundle the module under test, then run this same file as an Electron main script
const launch = () => {
  const { spawnSync } = require('child_process')
  const esbuild = require('esbuild')
  const bundle = path.join(kWorkDir, 'pyodide.bundle.cjs')
  fs.mkdirSync(kWorkDir, { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'pyodide.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: bundle,
    logLevel: 'error',
  })
  const result = spawnSync(require('electron'), [__filename, bundle], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

// started by electron
const probe = async () => {

  const { app, BrowserWindow, session } = require('electron')
  const kCanary = 'canary-probe-51c2'
  process.env.WITSY_PROBE_CANARY = kCanary
  app.setPath('userData', path.join(kWorkDir, 'userData'))
  app.on('window-all-closed', () => { /* the app has other windows; do not quit when the sandbox goes */ })
  await app.whenReady()

  const quiet = { log: console.log }
  console.log = () => {}
  const py = require(process.argv[2])

  let failures = 0
  const check = (name, actual, ok) => {
    const passed = ok(actual)
    if (!passed) failures++
    quiet.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : `\n      got: ${JSON.stringify(actual)}`}`)
  }
  const is = (expected) => (actual) => JSON.stringify(actual) === JSON.stringify(expected)
  const errorWith = (text) => (actual) => typeof actual?.error === 'string' && actual.error.includes(text) && actual.result === undefined
  const run = (script) => py.runPythonCode(script)

  quiet.log(`Electron ${process.versions.electron} on ${process.platform}, runtime cache in ${app.getPath('userData')}\n`)

  // python works
  check('value of the last expression', await run('1 + 1'), is({ result: '2' }))
  check('printed text', await run('print("hello")\nprint("world")'), is({ result: 'hello\nworld' }))
  check('exception', await run('raise ValueError("nope")'), errorWith('ValueError: nope'))
  check('numpy', await run('import numpy as np\nint(np.arange(10).sum())'), is({ result: '45' }))
  check('pandas', await run('import pandas as pd\nstr(pd.DataFrame({"a": [1, 2, 3]})["a"].sum())'), is({ result: '6' }))
  check('scripts sent together', await Promise.all([run('import asyncio\nprint("a1")\nawait asyncio.sleep(0.3)\nprint("a2")'), run('print("b1")')]), is([{ result: 'a1\na2' }, { result: 'b1' }]))

  // python sees nothing of the host
  check('environment of the app', await run('import os\nstr(os.environ.get("WITSY_PROBE_CANARY"))'), is({ result: 'None' }))
  check('files of the host', await run(`import os\nstr(os.path.exists(${JSON.stringify(__filename)}))`), is({ result: 'False' }))
  check('js module is empty', await run('import js\nstr(len(js.object_keys()))'), is({ result: '0' }))
  check('js.process', await run('import js\nstr(js.process.pid)'), errorWith('AttributeError'))
  check('run_js', await run('from pyodide.code import run_js\nstr(run_js("typeof process"))'), errorWith('ImportError'))
  check('pyfetch', await run('from pyodide.http import pyfetch\nr = await pyfetch("https://example.com/")\nstr(r.status)'), (actual) => actual.result === undefined)

  // the case S-16 was about: from a javascript object to the Function of its realm
  const escape = (body) => `from pyodide.ffi import to_js\nstr(to_js([1]).constructor.constructor(${JSON.stringify(body)})())`
  check('Function() from a JsProxy is refused', await run(escape('return 1')), errorWith('EvalError'))
  check('no pid of the app through a JsProxy', await run(escape('return process.pid')), (actual) => actual.result !== String(process.pid) && actual.result === undefined)

  // the page python runs in, as if python had got out of the interpreter
  const win = BrowserWindow.getAllWindows().find((w) => py.isPyodideSandboxWindow(w))
  check('one hidden sandbox window', [BrowserWindow.getAllWindows().length, !!win, win?.isVisible()], is([1, true, false]))
  const page = async (code) => {
    try {
      return await Promise.race([win.webContents.executeJavaScript(code), new Promise((resolve) => setTimeout(() => resolve('(no answer)'), 8000))])
    } catch (error) {
      return `threw: ${error}`
    }
  }
  const attempt = (expr) => `(async () => { try { const r = await ${expr}; return 'status ' + r.status } catch (e) { return 'refused' } })()`
  check('page: no node globals', await page(`[typeof process, typeof require, typeof module, typeof Buffer, typeof global].join('|')`), is('undefined|undefined|undefined|undefined|undefined'))
  check('page: no bridge to the app', await page(`[typeof ipcRenderer, typeof window.api, typeof window.electron].join('|')`), is('undefined|undefined|undefined'))
  check('page: eval is refused', await page(`(() => { try { return String(eval('1+1')) } catch (e) { return e.name } })()`), is('EvalError'))
  check('page: fetch of a web site', await page(attempt(`fetch('https://example.com/')`)), is('refused'))
  check('page: fetch of this machine', await page(attempt(`fetch('http://127.0.0.1:8090/api/health')`)), is('refused'))
  check('page: fetch of the pyodide cdn', await page(attempt(`fetch('https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide-lock.json')`)), is('refused'))
  check('page: its own runtime file', await page(attempt(`fetch('/pyodide-lock.json')`)), is('status 200'))
  check('page: a file that is not in the lock file', await page(attempt(`fetch('/evil-1.0-py3-none-any.whl')`)), is('status 404'))
  check('page: path traversal', await page(attempt(`fetch('/..%2f..%2fsettings.json')`)), is('status 404'))
  check('page: POST', await page(attempt(`fetch('/pyodide.js', { method: 'POST', body: 'x' })`)), is('status 403'))
  check('page: websocket', await page(`new Promise((resolve) => { try { const ws = new WebSocket('wss://echo.websocket.org/'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('refused') } catch (e) { resolve('refused') } })`), is('refused'))
  check('page: image from a web site', await page(`new Promise((resolve) => { const img = new Image(); img.onload = () => resolve('loaded'); img.onerror = () => resolve('refused'); img.src = 'https://example.com/favicon.ico' })`), is('refused'))
  check('page: window.open', await page(`String(window.open('https://example.com/'))`), is('null'))
  await page(`(() => { location.href = 'https://example.com/'; return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  check('page: navigation', [await page('location.href'), BrowserWindow.getAllWindows().length], is(['https://pyodide-sandbox.witsy.invalid/index.html', 1]))

  // the session, without the page and its content security policy
  const ses = session.fromPartition('pyodide-sandbox')
  const status = async (url) => { try { return (await ses.fetch(url)).status } catch { return 'refused' } }
  check('session: a web site over https', await status('https://example.com/'), (actual) => actual === 403 || actual === 'refused')
  check('session: a web site over http', await status('http://example.com/'), (actual) => actual === 403 || actual === 'refused')

  // recovery
  check('python still works', await run('2 + 2'), is({ result: '4' }))
  win.webContents.forcefullyCrashRenderer()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  check('crashed sandbox is dropped', [BrowserWindow.getAllWindows().length, py.isPyodideInitialized()], is([0, false]))
  check('a new sandbox is started', await run('3 + 3'), is({ result: '6' }))

  py.resetPyodide()
  check('no window left', BrowserWindow.getAllWindows().length, is(0))

  quiet.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`)
  app.exit(failures === 0 ? 0 : 1)

}

if (process.versions.electron) {
  probe().catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  launch()
}
