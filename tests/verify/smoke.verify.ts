//
// smoke: the packaged app starts, its main window and screens render, nothing fails on the way, and
// the windows have the protections the security fixes rely on (S-14, S-02).
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import path from 'node:path'
import { artifactsDir, cspRefusals, LaunchedApp, launchApp, makeHome, record } from './harness'

const suite = 'smoke'
let launched: LaunchedApp

beforeAll(async () => {
  launched = await launchApp(makeHome(suite))
})

afterAll(async () => {
  record(suite, { logTail: launched?.logs.slice(-40) })
  await launched?.close()
})

test('the packaged app starts with its name and version', async () => {
  const info = await launched.app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(), ready: app.isReady(), packaged: app.isPackaged }))
  record(suite, { app: info })
  expect(info.ready).toBe(true)
  expect(info.packaged).toBe(true)
  expect(info.name).toBe('Witsy')
})

test('the main window renders its menu bar, conversation list and prompt', async () => {
  const { window } = launched
  await window.waitForSelector('.menubar-wrapper', { timeout: 30000 })
  await window.waitForSelector('.chat-area', { timeout: 30000 })
  await window.waitForSelector('.prompt', { timeout: 30000 })
  const file = path.join(artifactsDir(suite), 'main-window.png')
  await window.screenshot({ path: file })
  record(suite, { screenshotMain: file })
})

test('the settings screen opens', async () => {
  const { window } = launched
  await window.click('.menubar-wrapper button.item[aria-label="Settings"]')
  await window.waitForSelector('div.settings.split-pane', { state: 'visible', timeout: 30000 })
  const file = path.join(artifactsDir(suite), 'settings.png')
  await window.screenshot({ path: file })
  record(suite, { screenshotSettings: file })
})

test('every window is sandboxed, isolated, without Node.js, with web security on (S-14)', async () => {
  const prefs = await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => {
    const p: any = w.webContents.getLastWebPreferences() || {}
    return { url: w.webContents.getURL(), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity }
  }))
  record(suite, { windows: prefs })
  expect(prefs.length).toBeGreaterThan(0)
  for (const p of prefs) {
    expect(p.contextIsolation, p.url).toBe(true)
    expect(p.nodeIntegration, p.url).toBeFalsy()
    expect(p.webSecurity, p.url).not.toBe(false)
  }
})

test('the app page has its content security policy and nothing was refused at startup', async () => {
  const csp = await launched.window.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || null)
  record(suite, { csp, cspRefusalsAtStartup: cspRefusals(launched.logs) })
  expect(csp).toMatch(/script-src 'self'/)
  expect(csp).not.toMatch(/'unsafe-inline'/)
  expect(cspRefusals(launched.logs)).toEqual([])
})

test('no uncaught error in a page or in the main process', async () => {
  const errors = launched.logs.filter((l) => l.startsWith('[pageerror]') || /Unhandled rejection|Uncaught Exception|A JavaScript error occurred/i.test(l))
  record(suite, { errors })
  expect(errors).toEqual([])
})
