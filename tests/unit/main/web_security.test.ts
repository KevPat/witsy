
import { JSDOM } from 'jsdom'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { protocol, session } from 'electron'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { kArtifactContentMessage, kArtifactFrameUrl, kArtifactReadyMessage, kArtifactScheme } from '@/consts'
import * as webSecurity from '@main/web_security'

// What the windows of the app do with web content (S-14): the policy of index.html, the page html
// artifacts are loaded in and the scripts the main process accepts from local files.
// tools/web_security_probe.cjs checks the same things in a real Electron.

vi.mock('electron', () => {
  const makeSession = () => ({
    protocol: { handle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() },
  })
  return {
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    session: { defaultSession: makeSession() },
  }
})

const kRoot = path.join(__dirname, '..', '..', '..')

const makeSession = () => ({
  protocol: { handle: vi.fn() },
  webRequest: { onBeforeRequest: vi.fn() },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the content security policy of the app', () => {

  const html = fs.readFileSync(path.join(kRoot, 'index.html'), 'utf8')
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
  const directives = new Map(policy.split(';').map((directive) => directive.trim()).filter(Boolean).map((directive) => {
    const [name, ...sources] = directive.split(/\s+/)
    return [name, sources] as [string, string[]]
  }))
  const scripts = directives.get('script-src') ?? []

  test('index.html has a policy, before anything that could run', () => {
    expect(policy).not.toBe('')
    const document = new JSDOM(html).window.document
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(meta.parentElement.tagName).toBe('HEAD')
    const firstScript = document.querySelector('script')
    expect(meta.compareDocumentPosition(firstScript) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy()
  })

  test('inline scripts, inline handlers and javascript: urls do not run', () => {
    expect(scripts).not.toContain('\'unsafe-inline\'')
    expect(scripts).not.toContain('\'unsafe-hashes\'')
    expect(scripts.some((source) => source.startsWith('\'nonce-') || source.startsWith('\'sha'))).toBe(false)
  })

  test('scripts come from the app and from named folders, never from a whole scheme or host', () => {
    expect(scripts).toContain('\'self\'')
    for (const source of scripts) {
      if (source.startsWith('\'')) continue
      if (source === 'blob:') continue
      // a web source is a folder: https, a host and a path that ends with a slash
      expect(source, source).toMatch(/^https:\/\/[a-z0-9.-]+\/.+\/$/)
      expect(source).not.toContain('*')
    }
    expect(scripts).not.toContain('*')
    expect(scripts).not.toContain('https:')
    expect(scripts).not.toContain('http:')
    expect(scripts).not.toContain('data:')
    expect(scripts).not.toContain('file:')
    expect(scripts).not.toContain('\'strict-dynamic\'')
  })

  test('plugins and base tags are refused, workers come from the app or a blob', () => {
    expect(directives.get('object-src')).toEqual(['\'none\''])
    expect(directives.get('base-uri')).toEqual(['\'none\''])
    expect(directives.get('worker-src')).toEqual(['\'self\'', 'blob:'])
  })

  test('nothing else is restricted: the app calls any provider and shows any image, frame or web app', () => {
    // a default-src, connect-src, img-src, frame-src... would break model providers, attachments,
    // web apps and html artifacts: adding one is a decision to take with the app running
    expect([...directives.keys()].sort()).toEqual(['base-uri', 'object-src', 'script-src', 'worker-src'])
  })

  test('the page has no inline script and no inline handler of its own', () => {
    const document = new JSDOM(html).window.document
    for (const script of document.querySelectorAll('script')) {
      expect(script.getAttribute('src')).toBeTruthy()
      expect(script.textContent.trim()).toBe('')
    }
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute.startsWith('on'), `${element.tagName} ${attribute}`).toBe(false)
      }
    }
  })

  // a source with a path that ends with a slash allows what is below it, as the browser does
  const allows = (url: string): boolean => scripts.some((source) => source.endsWith('/') && url.startsWith(source))

  test('the ONNX runtime of the installed transformers.js is allowed', () => {
    // src/backends/onnx.js of the library: wasmPaths defaults to this folder of the CDN
    const version = JSON.parse(fs.readFileSync(path.join(kRoot, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8')).version
    const dist = fs.readFileSync(path.join(kRoot, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.js'), 'utf8')
    expect(dist).toContain('https://cdn.jsdelivr.net/npm/@huggingface/transformers@${')
    expect(allows(`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${version}/dist/ort-wasm-simd-threaded.jsep.mjs`)).toBe(true)
  })

  test('the ONNX runtime of the installed parakeet.js is allowed', () => {
    // src/backend.js of the library has the version in its source
    const backend = fs.readFileSync(path.join(kRoot, 'node_modules', 'parakeet.js', 'src', 'backend.js'), 'utf8')
    const version = backend.match(/const ver = '([^']+)'/)?.[1]
    expect(version).toBeTruthy()
    expect(backend).toContain('`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/`')
    expect(allows(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/ort-wasm-simd-threaded.jsep.mjs`)).toBe(true)
  })

  test('other packages of the same CDN are not', () => {
    expect(allows('https://cdn.jsdelivr.net/npm/left-pad@1.3.0/index.js')).toBe(false)
    expect(allows('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0.0/dist/ort.js')).toBe(false)
    expect(allows('https://cdn.jsdelivr.net/gh/someone/something/x.js')).toBe(false)
    expect(allows('https://cdn.jsdelivr.net.example.com/npm/@huggingface/x.js')).toBe(false)
  })

})

describe('the scheme of html artifacts', () => {

  test('the scheme is standard and secure, and has no other privilege', () => {
    webSecurity.registerPrivilegedSchemes()
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce()
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: kArtifactScheme, privileges: { standard: true, secure: true } },
    ])
  })

  test('the artifact page is the only thing it serves', async () => {
    const response = webSecurity.handleArtifactRequest({ url: kArtifactFrameUrl, method: 'GET' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(webSecurity.kArtifactFramePage)
  })

  test('the artifact page has no policy of its own: an artifact runs its inline scripts', () => {
    const response = webSecurity.handleArtifactRequest({ url: kArtifactFrameUrl, method: 'GET' })
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(webSecurity.kArtifactFramePage).not.toContain('Content-Security-Policy')
  })

  test.each([
    ['a query and a hash', `${kArtifactFrameUrl}?x=<script>alert(1)</script>#y`, 200],
    ['another path', `${kArtifactFrameUrl}index.html`, 404],
    ['a path that climbs', `${kArtifactScheme}://frame/a/../../etc/passwd`, 404],
    ['another host', `${kArtifactScheme}://other/`, 404],
    ['a host with a port', `${kArtifactScheme}://frame:8080/`, 404],
    ['another scheme', 'https://frame/', 404],
    ['something that is not a url', 'not a url', 400],
  ])('%s', async (_, url, status) => {
    const response = webSecurity.handleArtifactRequest({ url, method: 'GET' })
    expect(response.status).toBe(status)
    const body = await response.text()
    expect(body === '' || body === webSecurity.kArtifactFramePage).toBe(true)
    // nothing of the request is ever in the answer
    expect(body).not.toContain('alert(1)')
  })

  test.each(['POST', 'PUT', 'DELETE', 'HEAD'])('%s is refused', (method) => {
    const response = webSecurity.handleArtifactRequest({ url: kArtifactFrameUrl, method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

})

describe('the artifact page', () => {

  // the page in a window of its own, with scripts enabled. That window is its own parent,
  // so what the page posts to its parent is caught here.
  const loadPage = async () => {
    const posted = vi.fn()
    const dom = new JSDOM(webSecurity.kArtifactFramePage, {
      runScripts: 'dangerously',
      beforeParse: (frame) => {
        frame.postMessage = posted
      },
    })
    await vi.waitFor(() => expect(dom.window.document.readyState).toBe('complete'))
    const receive = (data: unknown, source: unknown = dom.window) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: source as any }))
    }
    return { dom, posted, receive }
  }

  const kArtifact = '<!DOCTYPE html><html><head><title>Report</title></head><body><h1>Quarterly report</h1><script>document.body.dataset.ran = "yes"</script></body></html>'

  test('it tells its parent it is loaded, and nothing else', async () => {
    const { dom, posted } = await loadPage()
    expect(posted).toHaveBeenCalledOnce()
    expect(posted).toHaveBeenCalledWith({ type: kArtifactReadyMessage }, '*')
    expect(dom.window.document.body.innerHTML.trim()).toBe('')
    dom.window.close()
  })

  test('it becomes the page its parent sends, scripts included', async () => {
    const { dom, receive } = await loadPage()
    receive({ type: kArtifactContentMessage, html: kArtifact })
    expect(dom.window.document.title).toBe('Report')
    expect(dom.window.document.querySelector('h1').textContent).toBe('Quarterly report')
    expect(dom.window.document.body.dataset.ran).toBe('yes')
    expect(dom.window.document.compatMode).toBe('CSS1Compat')
    dom.window.close()
  })

  test('it ignores what does not come from its parent', async () => {
    const { dom, receive } = await loadPage()
    const other = new JSDOM('')
    receive({ type: kArtifactContentMessage, html: kArtifact }, other.window)
    receive({ type: kArtifactContentMessage, html: kArtifact }, null)
    expect(dom.window.document.title).toBe('')
    expect(dom.window.document.querySelector('h1')).toBeNull()
    other.window.close()
    dom.window.close()
  })

  test.each([
    ['another type', { type: 'update', html: kArtifact }],
    ['no type', { html: kArtifact }],
    ['html that is not a string', { type: kArtifactContentMessage, html: { toString: () => kArtifact } }],
    ['no html', { type: kArtifactContentMessage }],
    ['a string', kArtifactContentMessage],
    ['nothing', null],
  ])('it ignores a message with %s', async (_, data) => {
    const { dom, receive } = await loadPage()
    receive(data)
    expect(dom.window.document.title).toBe('')
    expect(dom.window.document.querySelector('h1')).toBeNull()
    dom.window.close()
  })

  test('it is written once: the page it became is not replaced by a second message', async () => {
    const { dom, receive } = await loadPage()
    receive({ type: kArtifactContentMessage, html: kArtifact })
    receive({ type: kArtifactContentMessage, html: '<html><head><title>Forged</title></head><body></body></html>' })
    expect(dom.window.document.title).toBe('Report')
    dom.window.close()
  })

  test('nothing in the page depends on the request', () => {
    expect(webSecurity.kArtifactFramePage).not.toMatch(/location\.|document\.URL|document\.referrer|searchParams/)
  })

})

describe('local scripts', () => {

  const appFolder = path.join(os.tmpdir(), 'witsy-app', '.vite', 'renderer', 'main_window')
  const fileUrl = (...segments: string[]): string => pathToFileURL(path.join(...segments)).href

  test('a script of the app is accepted', () => {
    expect(webSecurity.isAllowedScriptUrl(fileUrl(appFolder, 'assets', 'index-1234.js'), appFolder)).toBe(true)
    expect(webSecurity.isAllowedScriptUrl(fileUrl(appFolder, 'assets', 'index-1234.js') + '?v=1#x', appFolder)).toBe(true)
    expect(webSecurity.isAllowedScriptUrl(fileUrl(appFolder, 'with space', 'chunk.js'), appFolder)).toBe(true)
  })

  test.each([
    ['a file next to the app', () => fileUrl(os.tmpdir(), 'witsy-app', '.vite', 'renderer', 'evil.js')],
    ['a folder whose name starts like the app folder', () => fileUrl(os.tmpdir(), 'witsy-app', '.vite', 'renderer', 'main_window-evil', 'x.js')],
    ['a download', () => fileUrl(os.homedir(), 'Downloads', 'evil.js')],
    ['a path that climbs out of the app', () => `${fileUrl(appFolder)}/assets/../../../evil.js`],
    ['an encoded path that climbs out of the app', () => `${fileUrl(appFolder)}/assets/%2e%2e/%2e%2e/%2e%2e/evil.js`],
    ['a file on a share', () => 'file://server/share/evil.js'],
    ['something that is not a url', () => 'evil.js'],
  ])('%s is refused', (_, build) => {
    expect(webSecurity.isAllowedScriptUrl(build(), appFolder)).toBe(false)
  })

  test.runIf(process.platform === 'win32')('the case of a Windows path does not matter, the drive does', () => {
    const url = fileUrl(appFolder, 'assets', 'index.js')
    expect(webSecurity.isAllowedScriptUrl(url.replace('witsy-app', 'WITSY-APP'), appFolder)).toBe(true)
    const drive = appFolder[0].toLowerCase() === 'z' ? 'y' : 'z'
    expect(webSecurity.isAllowedScriptUrl(`file:///${drive}:${url.slice('file:///c:'.length)}`, appFolder)).toBe(false)
  })

  test('what is not a local file is left to the policy of the page', () => {
    expect(webSecurity.isAllowedScriptUrl('http://localhost:5173/src/renderer.ts', appFolder)).toBe(true)
    expect(webSecurity.isAllowedScriptUrl('https://cdn.jsdelivr.net/npm/left-pad@1.3.0/index.js', appFolder)).toBe(true)
    expect(webSecurity.isAllowedScriptUrl('blob:file:///1234', appFolder)).toBe(true)
  })

  const guard = () => {
    const ses = makeSession()
    webSecurity.installLocalScriptGuard(ses as any, appFolder)
    const [filter, listener] = ses.webRequest.onBeforeRequest.mock.calls[0]
    const decide = (resourceType: string, url: string) => {
      const callback = vi.fn()
      listener({ resourceType, url }, callback)
      expect(callback).toHaveBeenCalledOnce()
      return callback.mock.calls[0][0]
    }
    return { ses, filter, decide }
  }

  test('the guard only looks at local files', () => {
    const { ses, filter } = guard()
    expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    expect(filter).toEqual({ urls: ['file://*/*'] })
  })

  test('a script that is not the app is cancelled, a script of the app is not', () => {
    const { decide } = guard()
    expect(decide('script', fileUrl(os.homedir(), 'Downloads', 'evil.js'))).toEqual({ cancel: true })
    expect(decide('script', 'file://server/share/evil.js')).toEqual({ cancel: true })
    expect(decide('script', fileUrl(appFolder, 'assets', 'index-1234.js'))).toEqual({})
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  test.each(['image', 'media', 'stylesheet', 'font', 'xhr', 'subFrame', 'mainFrame', 'other'])('a local %s is not touched', (resourceType) => {
    const { decide } = guard()
    expect(decide(resourceType, fileUrl(os.homedir(), 'Pictures', 'photo.png'))).toEqual({})
  })

})

describe('installation', () => {

  test('the packaged app: the artifact page and the guard of the folder of the app', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined)
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
    const ses = makeSession()
    webSecurity.installWebSecurity(ses as any)
    expect(ses.protocol.handle).toHaveBeenCalledOnce()
    expect(ses.protocol.handle).toHaveBeenCalledWith(kArtifactScheme, webSecurity.handleArtifactRequest)
    expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledOnce()

    // the guard is the one of the folder the page of the app is in
    const listener = ses.webRequest.onBeforeRequest.mock.calls[0][1]
    const decide = (url: string) => {
      const callback = vi.fn()
      listener({ resourceType: 'script', url }, callback)
      return callback.mock.calls[0][0]
    }
    expect(webSecurity.appRendererFolder().split(path.sep).slice(-2)).toEqual(['renderer', 'main_window'])
    expect(decide(pathToFileURL(path.join(webSecurity.appRendererFolder(), 'assets', 'index.js')).href)).toEqual({})
    expect(decide(pathToFileURL(path.join(webSecurity.appRendererFolder(), '..', 'evil.js')).href)).toEqual({ cancel: true })
  })

  test('the dev server: the artifact page, and no guard since the page is not a file', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173')
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
    const ses = makeSession()
    webSecurity.installWebSecurity(ses as any)
    expect(ses.protocol.handle).toHaveBeenCalledWith(kArtifactScheme, webSecurity.handleArtifactRequest)
    expect(ses.webRequest.onBeforeRequest).not.toHaveBeenCalled()
  })

  test('by default it is installed on the session of the app windows', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173')
    webSecurity.installWebSecurity()
    expect(session.defaultSession.protocol.handle).toHaveBeenCalledWith(kArtifactScheme, webSecurity.handleArtifactRequest)
  })

})
