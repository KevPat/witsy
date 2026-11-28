
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Monitor from '@main/monitor'
import { bug, isLinux } from './bug'

// fs.watch semantics differ per OS; these expectations were established on Linux (inotify)
describe.runIf(isLinux)('file monitor', () => {

  let dir: string
  let file: string
  let monitor: Monitor
  let callback: ReturnType<typeof vi.fn>

  const replaceAtomically = (content: string) => {
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, content)
    fs.renameSync(temp, file)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-stress-'))
    file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{}')
    callback = vi.fn()
    monitor = new Monitor(callback)
    monitor.start(file)
  })

  afterEach(() => {
    monitor.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a burst of in-place writes is reported once', async () => {
    for (let i = 0; i < 50; i++) fs.writeFileSync(file, JSON.stringify({ i }))
    await vi.waitUntil(() => callback.mock.calls.length > 0, { timeout: 2000 })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  test('rewriting the same content is not reported', async () => {
    fs.writeFileSync(file, '{}')
    fs.writeFileSync(file, '{"a":1}')
    await vi.waitUntil(() => callback.mock.calls.length > 0, { timeout: 2000 })
    callback.mockClear()
    fs.writeFileSync(file, '{"a":1}')
    await expect(vi.waitUntil(() => callback.mock.calls.length > 0, { timeout: 600 })).rejects.toThrow()
  })

  bug('changes are still reported after the file was replaced by a rename', async () => {
    // editors and sync tools save through a temporary file: the watcher stays attached to the old inode
    replaceAtomically('{"a":1}')
    await vi.waitUntil(() => callback.mock.calls.length === 1, { timeout: 2000 })
    replaceAtomically('{"a":2}')
    await vi.waitUntil(() => callback.mock.calls.length === 2, { timeout: 1500 })
  })

})
