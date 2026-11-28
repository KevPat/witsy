//
// security: the protections of S-14 and S-02 in the packaged app (the by-hand list of PR #1).
// - the page of the app: inline scripts, inline handlers, javascript: links, scripts from other local
//   folders and from hosts that are not listed do not run, and each refusal is reported;
// - html artifacts: shown in a frame of the witsy-artifact: scheme, their own scripts run, they cannot
//   read a local file, show a local image or reach the app;
// - the "Copy code" link of a code block still works (one listener, no inline handler).
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import { Frame } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactsDir, chat, cspRefusals, historyWith, LaunchedApp, launchApp, makeHome, message, record, sleep, waitFor } from './harness'

const suite = 'security'
let launched: LaunchedApp
const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-secret-'))
const secretFile = path.join(secretDir, 'secret.txt')
const secretImage = path.join(secretDir, 'secret.png')
const outsideScript = path.join(secretDir, 'outside.js')
const kSecret = 'verifyDUMMYlocalFileContent6666'

// a 1x1 png
const kPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const artifactHtml = `\`\`\`html
<!DOCTYPE html>
<html><head><title>verify</title></head>
<body>
<h1 id="title">Verify artifact</h1>
<div id="ran">no</div><div id="file">pending</div><div id="xhr">pending</div><div id="image">pending</div><div id="parent">pending</div><div id="storage">pending</div>
<script>
document.getElementById('ran').textContent = 'ARTIFACT-SCRIPT-RAN';
fetch(${JSON.stringify(pathToFileURL(secretFile).href)}).then(r => r.text()).then(t => { document.getElementById('file').textContent = 'READ:' + t }).catch(e => { document.getElementById('file').textContent = 'blocked' });
try { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(pathToFileURL(secretFile).href)}, false); x.send(); document.getElementById('xhr').textContent = x.responseText ? 'READ:' + x.responseText : 'blocked' } catch (e) { document.getElementById('xhr').textContent = 'blocked' }
const img = new Image(); img.onload = () => { document.getElementById('image').textContent = 'loaded' }; img.onerror = () => { document.getElementById('image').textContent = 'blocked' }; img.src = ${JSON.stringify(pathToFileURL(secretImage).href)};
try { document.getElementById('parent').textContent = (window.parent.api || window.parent.document) ? 'reachable' : 'blocked' } catch (e) { document.getElementById('parent').textContent = 'blocked' }
try { localStorage.setItem('x', '1'); document.getElementById('storage').textContent = 'available' } catch (e) { document.getElementById('storage').textContent = 'blocked' }
</script>
</body></html>
\`\`\``

beforeAll(async () => {
  fs.writeFileSync(secretFile, kSecret)
  fs.writeFileSync(secretImage, kPng)
  fs.writeFileSync(outsideScript, 'window.__verifyOutsideScript = 1')
  const content = [
    'Here is some code:',
    '',
    '```js',
    'console.log("VERIFY-COPY-CODE")',
    '```',
    '',
    `<artifact title="Verify artifact">${artifactHtml}</artifact>`,
  ].join('\n')
  const home = makeHome(suite, { history: historyWith([chat('Security verify', [message('user', 'show me'), message('assistant', content)])]) })
  launched = await launchApp(home)
  // collect the refusals the page reports
  await launched.window.evaluate(() => {
    const w = window as any
    w.__verifyViolations = []
    document.addEventListener('securitypolicyviolation', (e: any) => w.__verifyViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }))
  })
})

afterAll(async () => {
  record(suite, { cspRefusals: cspRefusals(launched?.logs || []) })
  await launched?.close()
  fs.rmSync(secretDir, { recursive: true, force: true })
})

const violations = async () => launched.window.evaluate(() => (window as any).__verifyViolations)

test('an inline event handler in markup does not run and is reported', async () => {
  const ran = await launched.window.evaluate(async () => {
    const div = document.createElement('div')
    div.innerHTML = '<img src="data:image/png;base64,xx" onerror="window.__verifyHandler = 1">'
    document.body.appendChild(div)
    await new Promise((r) => setTimeout(r, 500))
    div.remove()
    return (window as any).__verifyHandler
  })
  expect(ran).toBeUndefined()
  const v = await violations()
  expect(v.some((x: any) => /script-src/.test(x.directive))).toBe(true)
})

test('an inline script element does not run', async () => {
  const ran = await launched.window.evaluate(async () => {
    const s = document.createElement('script')
    s.textContent = 'window.__verifyInline = 1'
    document.body.appendChild(s)
    await new Promise((r) => setTimeout(r, 300))
    s.remove()
    return (window as any).__verifyInline
  })
  expect(ran).toBeUndefined()
})

test('a javascript: link does not run', async () => {
  const ran = await launched.window.evaluate(async () => {
    const a = document.createElement('a')
    a.href = 'javascript:window.__verifyJsUrl=1'
    a.textContent = 'x'
    document.body.appendChild(a)
    a.click()
    await new Promise((r) => setTimeout(r, 300))
    a.remove()
    return (window as any).__verifyJsUrl
  })
  expect(ran).toBeUndefined()
})

test('a script from a local folder that is not the app does not run', async () => {
  const url = pathToFileURL(outsideScript).href
  const result = await launched.window.evaluate(async (url) => {
    const s = document.createElement('script')
    s.src = url
    const done = new Promise((resolve) => { s.onload = () => resolve('load'); s.onerror = () => resolve('error') })
    document.body.appendChild(s)
    const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
    s.remove()
    return { outcome, ran: (window as any).__verifyOutsideScript }
  }, url)
  expect(result.ran).toBeUndefined()
  expect(result.outcome).not.toBe('load')
})

test('a script from a host the policy does not list does not run', async () => {
  const result = await launched.window.evaluate(async () => {
    const s = document.createElement('script')
    s.src = 'https://example.com/verify.js'
    const done = new Promise((resolve) => { s.onload = () => resolve('load'); s.onerror = () => resolve('error') })
    document.body.appendChild(s)
    const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
    s.remove()
    return outcome
  })
  expect(result).toBe('error')
  const v = await violations()
  expect(v.some((x: any) => String(x.blocked).includes('example.com'))).toBe(true)
})

test('the artifact scheme serves its one page and nothing else', async () => {
  const results = await launched.app.evaluate(async ({ session }) => {
    const get = async (url: string, method = 'GET') => {
      try { const r = await session.defaultSession.fetch(url, { method }); return r.status } catch (e) { return String(e) }
    }
    return {
      frame: await get('witsy-artifact://frame/'),
      other: await get('witsy-artifact://frame/other'),
      host: await get('witsy-artifact://elsewhere/'),
      post: await get('witsy-artifact://frame/', 'POST'),
    }
  })
  record(suite, { artifactScheme: results })
  expect(results).toEqual({ frame: 200, other: 404, host: 404, post: 405 })
})

const artifactFrame = async (): Promise<Frame> => {
  return waitFor(async () => {
    for (const frame of launched.window.frames()) {
      if (!frame.url().startsWith('witsy-artifact:')) continue
      if (await frame.$('#ran').catch(() => null)) return frame
    }
    return null
  }, 30000)
}

test('an html artifact is shown from the artifact scheme, in a sandbox, and its own scripts run', async () => {
  await launched.window.click('.chat-list .chat, .chats .chat')
  await launched.window.waitForSelector('.messages .message', { timeout: 30000 })
  const sandbox = await waitFor(() => launched.window.evaluate(() => {
    const frame = [...document.querySelectorAll('iframe')].find((f) => f.src.startsWith('witsy-artifact:'))
    return frame ? { src: frame.src, sandbox: frame.getAttribute('sandbox') } : null
  }), 30000)
  record(suite, { artifactFrameElement: sandbox })
  expect(sandbox.sandbox).toContain('allow-scripts')
  expect(sandbox.sandbox).not.toContain('allow-same-origin')
  const frame = await artifactFrame()
  await waitFor(async () => (await frame.textContent('#ran')) === 'ARTIFACT-SCRIPT-RAN', 15000)
  const file = path.join(artifactsDir(suite), 'html-artifact.png')
  await sleep(1000)
  await launched.window.screenshot({ path: file })
  record(suite, { screenshotArtifact: file })
})

test('an html artifact cannot read a local file, show a local image or reach the app', async () => {
  const frame = await artifactFrame()
  const read = async (id: string) => waitFor(async () => { const t = await frame.textContent(id); return t !== 'pending' ? t : null }, 15000)
  const outcome = { file: await read('#file'), xhr: await read('#xhr'), image: await read('#image'), parent: await read('#parent'), storage: await read('#storage') }
  record(suite, { artifactProbes: outcome })
  expect(outcome.file).toBe('blocked')
  expect(outcome.xhr).toBe('blocked')
  expect(outcome.image).toBe('blocked')
  expect(outcome.parent).toBe('blocked')
  // the frame has an opaque origin: no storage of its own either
  expect(outcome.storage).toBe('blocked')
  // and the secret never reached the page of the app
  const html = await launched.window.content()
  expect(html).not.toContain(kSecret)
})

test('the "Copy code" link of a code block copies the code', async () => {
  await launched.app.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await launched.window.click('a.copy-code')
  const text = await waitFor(async () => {
    const t = await launched.app.evaluate(({ clipboard }) => clipboard.readText())
    return t !== 'before' ? t : null
  }, 10000)
  expect(text).toContain('console.log("VERIFY-COPY-CODE")')
})

test('nothing the app itself needs was refused by the policy', async () => {
  // the refusals above were provoked by this suite: none other may appear (fonts, styles, workers...)
  const provoked = /verifyHandler|verifyInline|verifyJsUrl|outside\.js|example\.com|data:image\/png;base64,xx|script-src-attr|inline script|javascript:/i
  const unexpected = cspRefusals(launched.logs).filter((l) => !provoked.test(l))
  record(suite, { unexpectedRefusals: unexpected })
  expect(unexpected).toEqual([])
})

test('the web security probe passes in a real Electron (packaged and dev configurations)', async () => {
  const { runProbe } = await import('./probes')
  const res = runProbe(suite, 'web_security_probe.cjs', 600000)
  record(suite, { webSecurityProbe: { status: res.status, passed: res.passed, failed: res.failed, skipped: res.skipped, log: res.log } })
  expect(res.failed).toEqual([])
  expect(res.status).toBe(0)
})
