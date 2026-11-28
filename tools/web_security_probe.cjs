#!/usr/bin/env node
//
// Checks the web security of the app windows (S-14) in a real Electron, without building or
// starting the app: unit tests have no Chromium, so they cannot show what a content security
// policy, a frame or web security really do.
//
//   node tools/web_security_probe.cjs
//
// What is real: src/main/web_security.ts (the artifact page, the local script guard), the policy
// of index.html, the script the app adds to an artifact (src/renderer/services/artifact_frame.ts)
// and vega, the library of the chart plugin. The page that stands for the app is a small one that
// does what MessageItemHtmlBlock.vue does with an artifact.
//
// Two configurations are checked: the packaged app (a file: page inside an app.asar, web security
// on) and the dev server (an http page, web security off).
//
// The windows are shown, since a page that is hidden lays out its frames with no size, but off
// screen and without taking the focus.
//
// Exit code 0 when every check passes. On Linux without a display, run it under xvfb-run.
// The checks of the jsdelivr folders do not need the network: they only look at what the policy
// refuses. One check does (a plain http web site) and is skipped when the network is not there.
//

const fs = require('fs')
const os = require('os')
const path = require('path')

const kRoot = path.join(__dirname, '..')
// the long form of the temp folder (Windows gives an 8.3 short name when the user name is long)
const kWorkDir = path.join(fs.realpathSync.native(os.tmpdir()), 'witsy-web-security-probe')
const kRendererName = 'main_window'

// the packaged app: <resources>/app.asar/.vite/build and <resources>/app.asar/.vite/renderer/<name>
const kAppRoot = path.join(kWorkDir, 'app.asar', '.vite')

const readPolicy = (file) => {
  const match = fs.readFileSync(file, 'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
  if (!match) throw new Error(`no content security policy in ${file}`)
  return match[1]
}

// started by node: bundle what is under test, then run this same file as an Electron main script
const launch = async () => {

  const { spawnSync } = require('child_process')
  const esbuild = require('esbuild')

  fs.rmSync(kWorkDir, { recursive: true, force: true })
  const unpacked = path.join(kWorkDir, 'unpacked')
  const buildDir = path.join(unpacked, '.vite', 'build')
  const appDir = path.join(unpacked, '.vite', 'renderer', kRendererName)
  const elsewhere = path.join(kWorkDir, 'elsewhere')
  for (const dir of [buildDir, path.join(appDir, 'assets'), elsewhere, path.join(kWorkDir, 'userData')]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // the main process module, laid out like the packaged app
  esbuild.buildSync({
    entryPoints: [path.join(kRoot, 'src', 'main', 'web_security.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined', MAIN_WINDOW_VITE_NAME: JSON.stringify(kRendererName) },
    outfile: path.join(buildDir, 'web_security.bundle.cjs'),
    logLevel: 'error',
  })

  // the script of the page that stands for the app
  esbuild.buildSync({
    stdin: { contents: kPageScript, resolveDir: kRoot, sourcefile: 'probe_page.js', loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(appDir, 'assets', 'page.js'),
    logLevel: 'error',
  })

  const policy = readPolicy(path.join(kRoot, 'index.html'))
  const page = (csp) => `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="${csp}" />\n<title>app-page</title>\n</head>\n<body>\n<div id="app"></div>\n<script src="./assets/page.js"></script>\n</body>\n</html>\n`
  fs.writeFileSync(path.join(appDir, 'index.html'), page(policy))
  fs.writeFileSync(path.join(appDir, 'no-eval.html'), page(policy.replace(" 'unsafe-eval'", '')))
  fs.writeFileSync(path.join(appDir, 'assets', 'chunk.js'), 'export default "chunk"\n')
  fs.writeFileSync(path.join(buildDir, 'preload.js'), `const { contextBridge } = require('electron')\ncontextBridge.exposeInMainWorld('api', { secret: () => 'api-reachable' })\n`)

  // files that are on the computer but are not the app
  fs.writeFileSync(path.join(elsewhere, 'evil.js'), 'window.__evil = "ran"\n')
  fs.writeFileSync(path.join(elsewhere, 'evil.mjs'), 'window.__evilModule = "ran"\nexport default 1\n')
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'local-file-content\n')
  fs.writeFileSync(path.join(elsewhere, 'picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'))

  // where the installed speech libraries get the ONNX runtime from
  const transformers = JSON.parse(fs.readFileSync(path.join(kRoot, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8')).version
  const parakeet = fs.readFileSync(path.join(kRoot, 'node_modules', 'parakeet.js', 'src', 'backend.js'), 'utf8').match(/`(https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@)\$\{ver\}(\/dist\/)`/)
  const parakeetVersion = fs.readFileSync(path.join(kRoot, 'node_modules', 'parakeet.js', 'src', 'backend.js'), 'utf8').match(/const ver = '([^']+)'/)
  if (!parakeet || !parakeetVersion) throw new Error('parakeet.js no longer builds its ONNX runtime url the way this probe expects')
  const info = {
    policy,
    transformersRuntime: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${transformers}/dist/ort-wasm-simd-threaded.jsep.mjs`,
    parakeetRuntime: `${parakeet[1]}${parakeetVersion[1]}${parakeet[2]}ort-wasm-simd-threaded.jsep.mjs`,
  }

  // in an archive, as the packaged app is: its scripts are then asked for through the asar support of Electron
  await require('@electron/asar').createPackage(unpacked, path.join(kWorkDir, 'app.asar'))

  const result = spawnSync(require('electron'), [__filename], { stdio: 'inherit', env: { ...process.env, WITSY_PROBE_INFO: JSON.stringify(info) } })
  process.exit(result.status ?? 1)

}

// the script of the page that stands for the app: bundled with the real modules
const kPageScript = `
import { buildFrameBridge, injectFrameBridge, kFrameHeightMessage, kFrameSnapshotMessage, kFrameSnapshotRequestMessage } from './src/renderer/services/artifact_frame.ts'
import { kArtifactContentMessage, kArtifactFrameUrl, kArtifactReadyMessage } from './src/consts.ts'
import * as vega from 'vega'

const violations = []
document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective + ' ' + event.blockedURI))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// what MessageItemHtmlBlock.vue does with an html artifact: a sandboxed frame on the artifact page,
// which gets the html, with the script of the app in it, each time it says it is loaded
const showArtifact = async (html, options = {}) => {
  const { settle = null, loads = 1, update = null, snapshot = false, sandbox = 'allow-scripts allow-forms' } = options
  const id = crypto.randomUUID()
  const frame = document.createElement('iframe')
  if (sandbox !== null) frame.setAttribute('sandbox', sandbox)
  frame.style.cssText = 'width: 400px; border: none;'
  const seen = { ready: 0, heights: [], notes: [], snapshot: null }
  let loaded = 0
  const onMessage = (event) => {
    const data = event.data
    if (event.source !== frame.contentWindow || !data || typeof data !== 'object') return
    if (data.type === kArtifactReadyMessage) {
      seen.ready++
      frame.contentWindow.postMessage({ type: kArtifactContentMessage, html: injectFrameBridge(html, buildFrameBridge(id)) }, '*')
    } else if (data.id === id && data.type === kFrameHeightMessage) {
      // the first report after the page asked for its content is the one of its load event
      if (loaded < seen.ready) loaded = seen.ready
      seen.heights.push(data.height)
    } else if (data.id === id && data.type === kFrameSnapshotMessage) {
      seen.snapshot = data.html
    } else if (data.note !== undefined) {
      seen.notes.push(data.note)
    }
  }
  window.addEventListener('message', onMessage)
  frame.src = kArtifactFrameUrl
  document.body.appendChild(frame)
  if (settle !== null) {
    await wait(settle)
  } else {
    // a first frame starts a process: wait for the page to be loaded rather than for a fixed time,
    // then for what it still has to say (the second height report, the notes of the checks)
    const start = Date.now()
    while (loaded < loads && Date.now() - start < 12000) await wait(50)
    await wait(500)
  }
  if (update !== null) {
    frame.contentWindow.postMessage({ type: 'update', body: update }, '*')
    await wait(250)
  }
  if (snapshot) {
    frame.contentWindow.postMessage({ type: kFrameSnapshotRequestMessage, id }, '*')
    await wait(350)
  }
  window.removeEventListener('message', onMessage)
  frame.remove()
  return seen
}

// markup that reaches the page of the app the way a message does: as html, not as a script
const inject = (markup) => {
  const holder = document.createElement('div')
  holder.innerHTML = markup
  document.body.appendChild(holder)
  return holder
}

// a frame the injected markup creates: it has the origin of the app, so the app can look into it
const injectedFrame = async (srcdoc, read) => {
  const holder = inject('<iframe></iframe>')
  const frame = holder.querySelector('iframe')
  frame.srcdoc = srcdoc
  await wait(900)
  let result
  try { result = read(frame.contentWindow) } catch (error) { result = 'ERR ' + error.name }
  holder.remove()
  return result
}

// the calls of src/renderer/services/plugins/vega.ts
const chart = async () => {
  const spec = {
    width: 40, height: 20,
    signals: [{ name: 'factor', update: '1 + 1' }],
    data: [{ name: 'table', values: [{ a: 4 }, { a: 9 }], transform: [{ type: 'formula', as: 'b', expr: 'datum.a * factor' }] }],
    marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { field: 'a' }, y: { value: 0 }, width: { value: 3 }, height: { field: 'b' }, fill: { value: 'steelblue' } } } }],
  }
  const view = new vega.View(vega.parse(spec)).renderer('none').initialize()
  const image = await view.toImageURL('png')
  return image.slice(0, 22)
}

window.probe = { violations, wait, showArtifact, inject, injectedFrame, chart }
`

// started by electron
const probe = async () => {

  const { app, BrowserWindow, session } = require('electron')
  const http = require('http')
  const { pathToFileURL } = require('url')

  const info = JSON.parse(process.env.WITSY_PROBE_INFO)
  const buildDir = path.join(kAppRoot, 'build')
  const appDir = path.join(kAppRoot, 'renderer', kRendererName)
  const elsewhere = (name) => pathToFileURL(path.join(kWorkDir, 'elsewhere', name)).href

  app.setPath('userData', path.join(kWorkDir, 'userData'))
  app.on('window-all-closed', () => { /* windows come and go during the probe */ })

  // a window that is off screen or behind another one must still count as visible
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MacWebContentsOcclusion')

  const quiet = { log: console.log }
  console.log = () => {}
  console.warn = () => {}

  // the module under test: the scheme before the app is ready, the rest once it is
  const webSecurity = require(path.join(buildDir, 'web_security.bundle.cjs'))
  webSecurity.registerPrivilegedSchemes()
  await app.whenReady()
  webSecurity.installWebSecurity()

  let failures = 0
  const check = (name, actual, ok) => {
    const passed = ok(actual)
    if (!passed) failures++
    quiet.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : `\n      got: ${JSON.stringify(actual)}`}`)
  }
  const is = (expected) => (actual) => JSON.stringify(actual) === JSON.stringify(expected)
  const startsWith = (text) => (actual) => typeof actual === 'string' && actual.startsWith(text)

  // a web server that is not the app: an api without CORS headers, a script, a page
  const seen = []
  const png = fs.readFileSync(path.join(kWorkDir, 'elsewhere', 'picture.png'))
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.method === 'OPTIONS') { res.writeHead(405); res.end(); return }
    if (req.url === '/lib.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.__lib = "ran"; if (window.parent !== window) window.parent.postMessage({ note: "web script ran" }, "*")'); return }
    if (req.url === '/guest.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!DOCTYPE html><html><head><title>guest-page</title></head><body>guest</body></html>'); return }
    if (req.url === '/picture.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return }
    if (req.url === '/open') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); res.end('open-answer'); return }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      let count = 0
      const timer = setInterval(() => { res.write(`data: chunk${count++}\n\n`); if (count === 3) { clearInterval(timer); res.end() } }, 60)
      return
    }
    if (req.url.startsWith('/dev/')) {
      // the dev server: the same page and script as the packaged app, over http
      const file = path.join(appDir, req.url.slice('/dev/'.length))
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/javascript' })
      res.end(fs.readFileSync(file))
      return
    }
    let body = ''
    req.on('data', (chunk) => body += chunk)
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null, custom: req.headers['x-custom'] ?? null, body }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const web = `http://127.0.0.1:${server.address().port}`

  const exec = async (win, code) => {
    try {
      return await Promise.race([win.webContents.executeJavaScript(code, true), new Promise((resolve) => setTimeout(() => resolve('(no answer)'), 15000))])
    } catch (error) {
      return `threw: ${error?.message ?? error}`
    }
  }
  const createWindow = (webPreferences) => {
    const window = new BrowserWindow({
      show: false, x: -4000, y: -4000, width: 600, height: 500, focusable: false, skipTaskbar: true,
      webPreferences: { preload: path.join(buildDir, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, ...webPreferences },
    })
    window.showInactive()
    return window
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // what the checks run in the page
  const loadScript = (url, type = '') => `new Promise((resolve) => { const s = document.createElement('script'); ${type ? `s.type = '${type}';` : ''} s.src = ${JSON.stringify(url)}; s.onload = () => resolve('LOADED'); s.onerror = () => resolve('refused'); document.head.appendChild(s) })`
  const refusedByPolicy = (url) => `import(${JSON.stringify(url)}).catch(() => null).then(() => probe.violations.some((v) => v.endsWith(' ' + ${JSON.stringify(new URL(url).href)})) ? 'refused by the policy' : 'accepted by the policy')`
  const canvasRead = (url) => `new Promise((resolve) => { const img = new Image(); img.onload = () => { try { const c = document.createElement('canvas'); c.width = 1; c.height = 1; c.getContext('2d').drawImage(img, 0, 0); c.toDataURL(); resolve('displayed and read') } catch (e) { resolve('displayed, ' + e.name) } }; img.onerror = () => resolve('not displayed'); img.src = ${JSON.stringify(url)} })`
  const provider = `fetch('${web}/v1/chat', { method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json', 'x-custom': 'yes' }, body: '{"q":1}' }).then((r) => r.json()).catch((e) => 'ERR ' + e.message)`
  const stream = `fetch('${web}/stream').then(async (r) => { const reader = r.body.getReader(); let chunks = 0; let text = ''; for (;;) { const { done, value } = await reader.read(); if (done) break; chunks++; text += new TextDecoder().decode(value) } return [chunks > 1, text.includes('chunk2')] }).catch((e) => 'ERR ' + e.message)`
  const artifact = (html, options = {}) => `probe.showArtifact(${JSON.stringify(html)}, ${JSON.stringify(options)})`
  const note = (expression) => `<script>(async () => { let note; try { note = await (${expression}) } catch (e) { note = 'ERR ' + e.name } parent.postMessage({ note }, '*') })()</` + `script>`
  const kReach = note(`(() => { const r = { origin: self.origin }; try { r.document = parent.document.title } catch (e) { r.document = 'ERR ' + e.name } try { r.api = parent.api.secret() } catch (e) { r.api = 'ERR ' + e.name } return r })()`)
  const kNoReach = { origin: 'null', document: 'ERR SecurityError', api: 'ERR SecurityError' }

  quiet.log(`Electron ${process.versions.electron} (Chromium ${process.versions.chrome}) on ${process.platform}\n`)
  quiet.log(`policy of index.html: ${info.policy}\n`)

  //
  // the packaged app: a file: page, web security on, the session of the app
  //
  quiet.log('--- packaged app (file: page in app.asar, web security on)')
  const win = createWindow({ webSecurity: true })
  await win.loadFile(path.join(appDir, 'index.html'))

  // the app works
  check('the page of the app is in the archive', await exec(win, 'location.pathname.includes("/app.asar/.vite/renderer/")'), is(true))
  check('the script of the app runs', await exec(win, 'typeof probe.showArtifact'), is('function'))
  check('a chunk of the app is imported', await exec(win, `import('./assets/chunk.js').then((m) => m.default).catch((e) => 'ERR ' + e.message)`), is('chunk'))
  check('a request to a server without CORS headers, as the model providers are', await exec(win, provider), is({ auth: 'Bearer key', custom: 'yes', body: '{"q":1}' }))
  check('that request needed no preflight', seen.filter((line) => line.startsWith('OPTIONS')), is([]))
  check('a streamed answer is read as it arrives', await exec(win, stream), is([true, true]))
  const plain = await exec(win, `fetch('http://example.com/').then((r) => 'status ' + r.status).catch(() => 'failed')`)
  const online = plain === 'status 200' || await session.defaultSession.fetch('http://example.com/').then((r) => r.status === 200).catch(() => false)
  if (online) {
    check('a plain http server that is not this machine, as a model server of the local network is', plain, is('status 200'))
  } else {
    quiet.log('SKIP  a plain http server that is not this machine (no network)')
  }
  check('a local image is displayed and read from a canvas', await exec(win, canvasRead(elsewhere('picture.png'))), is('displayed and read'))
  check('a web image is displayed and read from a canvas', await exec(win, canvasRead(`${web}/picture.png`)), is('displayed and read'))
  check('a chart is drawn by vega', await exec(win, `probe.chart().catch((e) => 'ERR ' + e.name)`), is('data:image/png;base64,'))
  check('WebAssembly', await exec(win, `WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => 'ok').catch((e) => 'ERR ' + e.name)`), is('ok'))
  check('a worker made from a blob', await exec(win, `new Promise((resolve) => { try { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); w.onmessage = () => resolve('ok'); w.onerror = () => resolve('error') } catch (e) { resolve('ERR ' + e.name) } setTimeout(() => resolve('timeout'), 3000) })`), is('ok'))
  check('an audio worklet made from a blob', await exec(win, `(async () => { try { const c = new AudioContext(); await c.audioWorklet.addModule(URL.createObjectURL(new Blob(['class P extends AudioWorkletProcessor { process() { return true } }; registerProcessor("p", P)'], { type: 'application/javascript' }))); return 'ok' } catch (e) { return 'ERR ' + e.name } })()`), is('ok'))
  check('the ONNX runtime of transformers.js (Whisper)', await exec(win, refusedByPolicy(info.transformersRuntime)), is('accepted by the policy'))
  check('the ONNX runtime of parakeet.js', await exec(win, refusedByPolicy(info.parakeetRuntime)), is('accepted by the policy'))
  check('a webview shows a web page', await exec(win, `new Promise((resolve) => { const w = document.createElement('webview'); w.setAttribute('src', '${web}/guest.html'); w.style.cssText = 'width: 200px; height: 100px'; w.addEventListener('did-finish-load', () => resolve(w.getTitle())); w.addEventListener('did-fail-load', (e) => resolve('failed ' + e.errorDescription)); document.body.appendChild(w); setTimeout(() => resolve('timeout'), 8000) })`), is('guest-page'))

  // what a message can no longer do in the page of the app
  check('an inline event handler in injected markup does not run', await exec(win, `(async () => { probe.inject('<img src="x:" onerror="window.__handler = 1">'); await probe.wait(400); return String(window.__handler) })()`), is('undefined'))
  check('a javascript: link does not run', await exec(win, `(async () => { const a = probe.inject('<a href="javascript:window.__link = 1">x</a>').querySelector('a'); a.click(); await probe.wait(400); return String(window.__link) })()`), is('undefined'))
  check('an injected frame does not run an inline script', await exec(win, `probe.injectedFrame('<script>window.__inline = 1</` + `script>', (w) => String(w.__inline))`), is('undefined'))
  check('an injected frame does not run the script of a web site', await exec(win, `probe.injectedFrame('<script src="${web}/lib.js"></` + `script>', (w) => String(w.__lib))`), is('undefined'))
  check('an injected frame does not run a local script that is not the app', await exec(win, `probe.injectedFrame('<script src="${elsewhere('evil.js')}"></` + `script>', (w) => String(w.__evil))`), is('undefined'))
  check('a script element for a web site is refused', await exec(win, loadScript(`${web}/lib.js`)), is('refused'))
  check('a local script that is not the app is refused', await exec(win, loadScript(elsewhere('evil.js'))), is('refused'))
  check('a local module that is not the app is refused', await exec(win, loadScript(elsewhere('evil.mjs'), 'module')), is('refused'))
  check('import() of a local module that is not the app is refused', await exec(win, `import(${JSON.stringify(elsewhere('evil.mjs'))}).then(() => 'IMPORTED').catch(() => 'refused')`), is('refused'))
  check('none of them ran', await exec(win, `[window.__evil, window.__evilModule, window.__lib].map(String).join('|')`), is('undefined|undefined|undefined'))
  check('another package of the CDN is refused', await exec(win, refusedByPolicy('https://cdn.jsdelivr.net/npm/left-pad@1.3.0/index.js')), is('refused by the policy'))
  check('a path that climbs out of the allowed CDN folder is refused', await exec(win, refusedByPolicy('https://cdn.jsdelivr.net/npm/@huggingface/../left-pad@1.3.0/index.js')), is('refused by the policy'))
  check('a base tag is refused', await exec(win, `(() => { const b = document.createElement('base'); b.href = 'http://example.invalid/'; document.head.appendChild(b); const moved = document.baseURI.startsWith('http://example.invalid'); b.remove(); return moved })()`), is(false))
  check('plugin content is refused', await exec(win, `(async () => { probe.inject('<embed src="${web}/guest.html" type="text/html">'); await probe.wait(400); return probe.violations.some((v) => v.startsWith('object-src')) })()`), is(true))

  // html artifacts
  check('artifact: its inline scripts and handlers run', await exec(win, artifact(`<!DOCTYPE html><html><head><title>A</title></head><body onload="parent.postMessage({ note: 'onload handler ran' }, '*')"><script>parent.postMessage({ note: 'inline script ran' }, '*')</` + `script></body></html>`)), (seen) => seen.ready === 1 && is(['inline script ran', 'onload handler ran'])(seen.notes))
  check('artifact: opaque origin, no way to the app', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body>${kReach}</body></html>`)), (seen) => is([kNoReach])(seen.notes))
  check('artifact: its height is reported to the app', await exec(win, artifact('<!DOCTYPE html><html><head></head><body><div style="height: 321px">tall</div></body></html>')), (seen) => seen.heights.some((height) => height >= 321) && seen.heights.every((height) => height === 0 || height >= 321))
  win.hide()
  await wait(600)
  await exec(win, `(() => { window.__pending = ${artifact('<!DOCTYPE html><html><head></head><body><div style="height: 321px">tall</div></body></html>', { settle: 2600 })}; return true })()`)
  await wait(1200)
  win.showInactive()
  check('artifact: loaded while the window is hidden, its height is reported when the window is shown', await exec(win, 'window.__pending'), (seen) => seen.ready === 1 && seen.heights.length >= 2 && seen.heights[0] === 0 && seen.heights[seen.heights.length - 1] >= 321)
  check('artifact: the body of a streaming message replaces the body', await exec(win, artifact('<!DOCTYPE html><html><head><title>S</title></head><body></body></html>', { update: '<p id="streamed">streamed</p>', snapshot: true })), (seen) => typeof seen.snapshot === 'string' && seen.snapshot.includes('<p id="streamed">streamed</p>'))
  check('artifact: the snapshot for the PDF export', await exec(win, artifact('<!DOCTYPE html><html><head><title>Snap</title></head><body><h1>Report</h1><canvas width="2" height="2"></canvas></body></html>', { snapshot: true })), (seen) => typeof seen.snapshot === 'string' && seen.snapshot.includes('<h1>Report</h1>') && seen.snapshot.includes('<img src="data:image/png;base64,'))
  check('artifact: a page without head or doctype', await exec(win, artifact(`<p>plain</p>${note(`document.querySelector('p').textContent`)}`)), (seen) => is(['plain'])(seen.notes) && seen.heights.length >= 1)
  check('artifact: the script of a web site runs, as before', await exec(win, artifact(`<!DOCTYPE html><html><head><script src="${web}/lib.js"></` + `script></head><body></body></html>`)), (seen) => is(['web script ran'])(seen.notes))
  check('artifact: a server that allows it can be called', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body>${note(`fetch('${web}/open').then((r) => r.text())`)}</body></html>`)), (seen) => is(['open-answer'])(seen.notes))
  check('artifact: the answer of a server without CORS headers cannot be read', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body>${note(`fetch('${web}/v1/models').then((r) => r.text())`)}</body></html>`)), (seen) => is(['ERR TypeError'])(seen.notes))
  check('artifact: a local file cannot be read', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body>${note(`fetch(${JSON.stringify(elsewhere('secret.txt'))}).then((r) => r.text())`)}</body></html>`)), (seen) => is(['ERR TypeError'])(seen.notes))
  check('artifact: a local image is not displayed', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body>${note(`new Promise((resolve) => { const img = new Image(); img.onload = () => resolve('displayed'); img.onerror = () => resolve('not displayed'); img.src = ${JSON.stringify(elsewhere('picture.png'))} })`)}</body></html>`)), (seen) => is(['not displayed'])(seen.notes))
  check('artifact: reloading itself gets its page again', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body><script>parent.postMessage({ note: 'shown' }, '*'); if (!location.hash) { location.hash = 'again'; location.reload() }</` + `script></body></html>`, { loads: 2 })), (seen) => seen.ready === 2 && is(['shown', 'shown'])(seen.notes))
  check('artifact: even without the sandbox attribute it is not the app', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body>${kReach}</body></html>`, { sandbox: null })), (seen) => is([{ origin: 'witsy-artifact://frame', document: 'ERR SecurityError', api: 'ERR SecurityError' }])(seen.notes))
  check('artifact: the page only takes its content from the app', await exec(win, artifact(`<!DOCTYPE html><html><head></head><body><iframe src="witsy-artifact://frame/"></iframe><script>addEventListener('message', (e) => { if (e.data && e.data.type === 'witsy-artifact-ready') { parent.postMessage({ note: 'inner frame asked the artifact, not the app' }, '*') } })</` + `script></body></html>`)), (seen) => seen.ready === 1 && is(['inner frame asked the artifact, not the app'])(seen.notes))
  win.destroy()

  // the artifact scheme
  const status = async (url, init) => { try { return (await session.defaultSession.fetch(url, init)).status } catch (error) { return `threw: ${error?.message ?? error}` } }
  check('scheme: the artifact page', await status('witsy-artifact://frame/'), is(200))
  check('scheme: any other path', await status('witsy-artifact://frame/index.html'), is(404))
  check('scheme: any other host', await status('witsy-artifact://other/'), is(404))
  check('scheme: POST', await status('witsy-artifact://frame/', { method: 'POST', body: 'x' }), is(405))

  // why the policy keeps 'unsafe-eval'
  const strict = createWindow({ webSecurity: true })
  await strict.loadFile(path.join(appDir, 'no-eval.html'))
  check("without 'unsafe-eval' in the policy, vega cannot draw a chart", await exec(strict, `probe.chart().catch((e) => 'ERR ' + e.name)`), startsWith('ERR'))
  strict.destroy()

  //
  // the dev server: an http page, web security off, the artifact scheme in the session
  //
  quiet.log('\n--- dev server (http page, web security off)')
  const devSession = session.fromPartition('probe-dev')
  devSession.protocol.handle('witsy-artifact', webSecurity.handleArtifactRequest)
  const dev = createWindow({ webSecurity: false, session: devSession })
  await dev.loadURL(`${web}/dev/index.html`)
  check('dev: the script of the app runs', await exec(dev, 'typeof probe.showArtifact'), is('function'))
  check('dev: a request to a server without CORS headers', await exec(dev, `fetch('${web.replace('127.0.0.1', 'localhost')}/v1/chat', { method: 'POST', headers: { authorization: 'Bearer key', 'x-custom': 'yes' }, body: 'x' }).then((r) => r.json()).catch((e) => 'ERR ' + e.message)`), is({ auth: 'Bearer key', custom: 'yes', body: 'x' }))
  check('dev: a local image is displayed and read from a canvas', await exec(dev, canvasRead(elsewhere('picture.png'))), is('displayed and read'))
  check('dev: an inline event handler in injected markup does not run', await exec(dev, `(async () => { probe.inject('<img src="x:" onerror="window.__handler = 1">'); await probe.wait(400); return String(window.__handler) })()`), is('undefined'))
  check('dev: a local script is refused by the policy', await exec(dev, loadScript(elsewhere('evil.js'))), is('refused'))
  check('dev: an injected frame does not run a local script', await exec(dev, `probe.injectedFrame('<script src="${elsewhere('evil.js')}"></` + `script>', (w) => String(w.__evil))`), is('undefined'))
  check('dev: artifact scripts run, with no way to the app', await exec(dev, artifact(`<!DOCTYPE html><html><head></head><body>${kReach}</body></html>`)), (seen) => seen.ready === 1 && seen.heights.length >= 1 && is([kNoReach])(seen.notes))
  dev.destroy()

  server.close()
  quiet.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`)
  app.exit(failures === 0 ? 0 : 1)

}

if (process.versions.electron) {
  probe().catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  launch().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
