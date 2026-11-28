
import { vi, expect, test, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import Monitor from '@main/monitor'
import path from 'path'
import fs from 'fs'
import os from 'os'

let monitor: Monitor|null = null
const callback = vi.fn()
const tempFile = path.join(os.tmpdir(), 'vitest')

beforeAll(async () => {
  fs.writeFileSync(tempFile, 'Hello')
})

afterAll(async () => {
  try {
    fs.unlinkSync(tempFile)
  } catch (error) {
    console.error(error)
  }
})

beforeEach(async () => {
  vi.clearAllMocks()
})

afterEach(async () => {
  monitor!.stop()
})

test('Start monitor', async () => {
  monitor = new Monitor(callback)
  monitor.start(tempFile)
  expect(monitor.calculateDigest()).toBe('8b1a9953c4611296a827abf8c47804d7')
})

test('Stop monitor', async () => {
  monitor = new Monitor(callback)
  monitor.start(tempFile)
  monitor.stop()
  expect(monitor.calculateDigest()).toBe('')
})

test('Notify monitor', async () => {
  monitor = new Monitor(callback)
  monitor.start(tempFile)
  // Small delay to ensure watcher is ready
  await new Promise(resolve => setTimeout(resolve, 100))
  fs.appendFileSync(tempFile, ' World')
  await vi.waitUntil(() => callback.mock.calls.length > 0, { timeout: 500 })
})

test('Notify after stop', async () => {
  monitor = new Monitor(callback)
  monitor.start(tempFile)
  monitor.stop()
  // Small delay to ensure watcher is stopped
  await new Promise(resolve => setTimeout(resolve, 100))
  fs.appendFileSync(tempFile, ' World')
  // Wait a bit to verify no callback is triggered
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(callback).toHaveBeenCalledTimes(0)
})

test('Notify after the file was replaced by a rename', async () => {
  // editors, sync tools and our own atomic writes save through a temporary file
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-monitor-'))
  const file = path.join(dir, 'settings.json')
  const replaceAtomically = (content: string) => {
    fs.writeFileSync(`${file}.tmp`, content)
    fs.renameSync(`${file}.tmp`, file)
  }
  try {
    fs.writeFileSync(file, '{}')
    monitor = new Monitor(callback)
    monitor.start(file)
    replaceAtomically('{"a":1}')
    await vi.waitUntil(() => callback.mock.calls.length === 1, { timeout: 2000 })
    replaceAtomically('{"a":2}')
    await vi.waitUntil(() => callback.mock.calls.length === 2, { timeout: 2000 })
    replaceAtomically('{"a":3}')
    await vi.waitUntil(() => callback.mock.calls.length === 3, { timeout: 2000 })
  } finally {
    monitor!.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('A file that is removed then written again is watched again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-monitor-'))
  const file = path.join(dir, 'settings.json')
  try {
    fs.writeFileSync(file, '{}')
    monitor = new Monitor(callback)
    monitor.start(file)
    fs.rmSync(file)
    fs.writeFileSync(file, '{"a":1}')
    await vi.waitUntil(() => callback.mock.calls.length === 1, { timeout: 3000 })
    fs.writeFileSync(file, '{"a":2}')
    await vi.waitUntil(() => callback.mock.calls.length === 2, { timeout: 3000 })
  } finally {
    monitor!.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
