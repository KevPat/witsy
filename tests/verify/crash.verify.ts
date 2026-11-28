//
// crash (D-15): a renderer that dies takes its own window down, not the app.
// - the main window is reloaded after a crash and works again;
// - a second crash right after closes it (no reload loop), the app keeps running;
// - another window whose renderer dies is closed, the app keeps running.
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { artifactsDir, LaunchedApp, launchApp, mainWindow, makeHome, record, sleep, waitFor } from './harness'

const suite = 'crash'
let launched: LaunchedApp

beforeAll(async () => {
  launched = await launchApp(makeHome(suite))
  // count the loads of the main window from the main process
  await launched.app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as any
    const main = BrowserWindow.getAllWindows().find((w) => /main_window/.test(w.webContents.getURL()) && /[?&]view=/.test(w.webContents.getURL()))
    g.__verifyMain = main
    g.__verifyLoads = 0
    g.__verifyGone = []
    main.webContents.on('did-finish-load', () => { g.__verifyLoads++ })
    main.webContents.on('render-process-gone', (_e: any, d: any) => g.__verifyGone.push(d.reason))
  })
})

afterAll(async () => {
  record(suite, { logTail: launched?.logs.filter((l) => /crash|render process/i.test(l)) })
  await launched?.close()
})

const state = () => launched.app.evaluate(() => {
  const g = globalThis as any
  return { loads: g.__verifyLoads, gone: g.__verifyGone, destroyed: g.__verifyMain.isDestroyed(), crashed: g.__verifyMain.isDestroyed() ? null : g.__verifyMain.webContents.isCrashed() }
})

test('the main window reloads after its renderer crashes, and works again', async () => {
  await launched.app.evaluate(() => (globalThis as any).__verifyMain.webContents.forcefullyCrashRenderer())
  const after = await waitFor(async () => { const s = await state(); return s.loads >= 1 && !s.crashed ? s : null }, 30000)
  record(suite, { afterFirstCrash: after })
  expect(after.destroyed).toBe(false)
  expect(after.gone).toEqual(['crashed'])
  // Playwright gives up on a page whose renderer crashed: look at the new one from the main process
  const rendered = await waitFor(() => launched.app.evaluate(() => (globalThis as any).__verifyMain.webContents.executeJavaScript(
    `!!document.querySelector('.main-window .prompt') && typeof window.api?.app?.getVersion === 'function'`)), 30000)
  expect(rendered).toBe(true)
  const file = path.join(artifactsDir(suite), 'after-reload.png')
  const png: string = await launched.app.evaluate(async () => (await (globalThis as any).__verifyMain.webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(file, Buffer.from(png, 'base64'))
  record(suite, { screenshotAfterReload: file })
})

test('a second crash right after closes the main window instead of reloading it again', async () => {
  const pid = launched.app.process().pid
  await launched.app.evaluate(() => (globalThis as any).__verifyMain.webContents.forcefullyCrashRenderer())
  // the window is destroyed; with no other window the app then quits (Electron default on Windows and Linux)
  const outcome = await waitFor(async () => {
    try {
      const s = await state()
      return s.destroyed ? { ...s, appRunning: true } : null
    } catch {
      return { appRunning: false }
    }
  }, 30000)
  await sleep(2000)
  let loadsLater: number | null = null
  try { loadsLater = (await state()).loads } catch { /* the app quit */ }
  record(suite, { afterSecondCrash: outcome, loadsAfterSecondCrash: loadsLater, pid })
  if ((outcome as any).appRunning) {
    expect((outcome as any).destroyed).toBe(true)
    expect(loadsLater).toBe(1)
  }
  // no reload loop in the log either
  const reloads = launched.logs.filter((l) => /\[crash\] Render process gone .*: reload/.test(l))
  expect(reloads.length).toBe(1)
  expect(launched.logs.some((l) => /\[crash\] Render process gone .*: close/.test(l))).toBe(true)
})

test('another window whose renderer crashes is closed, the app keeps running', async () => {
  await launched.close()
  launched = await launchApp(makeHome(suite))
  const id = await launched.app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
    await w.loadURL('data:text/html,<p>secondary</p>')
    ;(globalThis as any).__verifySecondary = w
    return w.id
  })
  expect(id).toBeGreaterThan(0)
  await launched.app.evaluate(() => (globalThis as any).__verifySecondary.webContents.forcefullyCrashRenderer())
  const closed = await waitFor(() => launched.app.evaluate(() => (globalThis as any).__verifySecondary.isDestroyed()), 30000)
  expect(closed).toBe(true)
  await sleep(1000)
  expect(await launched.app.evaluate(({ app }) => app.isReady())).toBe(true)
  // and the main window was not touched
  const page = await mainWindow(launched.app)
  expect(await page.evaluate(() => !!document.querySelector('.main-window'))).toBe(true)
  expect(launched.logs.some((l) => /\[crash\] Render process gone .*: close/.test(l))).toBe(true)
})
