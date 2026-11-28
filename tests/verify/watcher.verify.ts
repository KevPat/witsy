//
// watcher (L-01): the app notices every outside change of a file it watches, also after the file was
// replaced through a temporary file and a rename (what editors, sync tools and atomic writes do).
// Before the fix the watcher stayed on the old file after the first replace (inotify, Linux) and the
// app never saw a change again. Real file system events, real app: the history of the workspace.
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { chat, historyFile, historyWith, LaunchedApp, launchApp, makeHome, message, record, sleep, waitFor } from './harness'

const suite = 'watcher'
let launched: LaunchedApp
let home: string
const timeline: { step: string, events: number, ms: number }[] = []

const history = (title: string) => JSON.stringify(historyWith([chat(title, [message('user', `hello ${title}`), message('assistant', 'hi')])]), null, 2)

const events = () => launched.window.evaluate(() => (window as any).__verifyFileEvents.filter((v: string) => v === 'history').length)

const step = async (name: string, change: () => void, title: string) => {
  const before = await events()
  const t0 = Date.now()
  change()
  const count = await waitFor(async () => { const n = await events(); return n > before ? n : null }, 10000).catch(() => before)
  timeline.push({ step: name, events: count - before, ms: Date.now() - t0 })
  expect(count, `no change event after: ${name}`).toBeGreaterThan(before)
  // and the app shows the new content
  await launched.window.waitForSelector(`.chats .chat:has-text("${title}")`, { timeout: 10000 })
}

const atomicReplace = (content: string) => {
  const file = historyFile(home)
  const tmp = path.join(path.dirname(file), `.history.json.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

beforeAll(async () => {
  home = makeHome(suite, { history: JSON.parse(history('Watcher start')) })
  launched = await launchApp(home)
  await launched.window.waitForSelector('.chats .chat:has-text("Watcher start")', { timeout: 30000 })
  await launched.window.evaluate(() => {
    const w = window as any
    w.__verifyFileEvents = []
    w.api._on('file-modified', (v: string) => w.__verifyFileEvents.push(v))
  })
  // let the app settle (its own first save)
  await sleep(1500)
})

afterAll(async () => {
  record(suite, { timeline, fsType: process.platform })
  await launched?.close()
})

test('a change written in place is seen', async () => {
  await step('write in place', () => fs.writeFileSync(historyFile(home), history('Watcher in place')), 'Watcher in place')
})

test('a replace through a temporary file and a rename is seen', async () => {
  await step('atomic replace 1', () => atomicReplace(history('Watcher replace one')), 'Watcher replace one')
})

test('a second replace is seen too (the watcher was re-armed on the new file)', async () => {
  await step('atomic replace 2', () => atomicReplace(history('Watcher replace two')), 'Watcher replace two')
})

test('a write in place after the replaces is seen', async () => {
  await step('write in place after replaces', () => fs.writeFileSync(historyFile(home), history('Watcher in place again')), 'Watcher in place again')
})

test('a file deleted and written again is seen', async () => {
  await step('delete then write', () => {
    fs.unlinkSync(historyFile(home))
    setTimeout(() => fs.writeFileSync(historyFile(home), history('Watcher recreated')), 50)
  }, 'Watcher recreated')
})

test('ten replaces in a row: the last one is shown', async () => {
  const before = await events()
  for (let i = 1; i <= 10; i++) {
    atomicReplace(history(`Watcher burst ${i}`))
    await sleep(30)
  }
  await launched.window.waitForSelector('.chats .chat:has-text("Watcher burst 10")', { timeout: 15000 })
  timeline.push({ step: 'burst of 10 replaces', events: (await events()) - before, ms: 0 })
})
