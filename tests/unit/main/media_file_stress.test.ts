import { App } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  abortMediaFile,
  abortMediaForSender,
  appendMediaChunk,
  finishMediaFile,
  MAX_CHUNK_BYTES,
  MAX_MEDIA_BYTES,
  openMediaFile,
} from '@main/media_file'

// Stress tests for the main-process media file writer. Files are written to a
// throwaway directory under the OS temp folder.
//
// Tests declared with test.fails describe a bug that exists today: they assert
// the behaviour the writer should have and are reported as passing while the
// bug is present. Drop the .fails once the bug is fixed.

const hooks = vi.hoisted(() => ({ skipWrites: false, failRename: false }))

vi.mock('electron', () => {
  return {
    app: {
      getPath: () => '/tmp',
    },
  }
})

// The real module, with two switches: one skips the disk write so the 512 MiB
// cap can be exercised without writing 512 MiB, one makes the final rename fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args)
    if (hooks.skipWrites) {
      handle.write = (async (bytes: Uint8Array) => ({ bytesWritten: bytes.length, buffer: bytes })) as typeof handle.write
    }
    return handle
  }
  const rename = async (...args: Parameters<typeof real.rename>) => {
    if (hooks.failRename) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    return real.rename(...args)
  }
  return { ...real, open, rename, default: { ...real, open, rename } }
})

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

function testApp(): App {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-media-stress-'))
  directories.push(dir)
  return { getPath: () => dir } as App
}

function imagesDir(app: App, workspace = WORKSPACE): string {
  return path.join(app.getPath('userData'), 'workspaces', workspace, 'images')
}

function listing(app: App, workspace = WORKSPACE): string[] {
  const dir = imagesDir(app, workspace)
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

function localPath(url: string): string {
  return url.slice('file://'.length)
}

function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

function bytes(random: () => number, size: number): Buffer {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = int(random, 0, 255)
  return out
}

afterEach(() => {
  hooks.skipWrites = false
  hooks.failRename = false
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('chunk handling', () => {

  test('any mix of chunk sizes and views lands on disk byte for byte', async () => {
    const random = prng(1)
    const app = testApp()
    for (let round = 0; round < 25; round++) {
      const payload = bytes(random, int(random, 12, 300000))
      const id = await openMediaFile(app, WORKSPACE, 1)
      let offset = 0
      while (offset < payload.length) {
        const size = Math.min(int(random, 0, 70000), payload.length - offset)
        const kind = int(random, 0, 2)
        if (kind === 0) {
          await appendMediaChunk(id, 1, payload.subarray(offset, offset + size))
        } else if (kind === 1) {
          await appendMediaChunk(id, 1, new Uint8Array(payload.subarray(offset, offset + size)))
        } else {
          // A view in the middle of a larger buffer: only the view may be written.
          const padded = new Uint8Array(size + 64).fill(0xee)
          padded.set(payload.subarray(offset, offset + size), 32)
          await appendMediaChunk(id, 1, padded.subarray(32, 32 + size))
        }
        offset += size
      }
      const url = await finishMediaFile(id, 1)
      expect(fs.readFileSync(localPath(url)).equals(payload)).toBe(true)
    }
    expect(listing(app).filter((name) => name.endsWith('.partial'))).toEqual([])
    expect(listing(app)).toHaveLength(25)
  })

  test('a chunk at the 4 MiB limit is written and one byte more ends the session', async () => {
    const app = testApp()
    const id = await openMediaFile(app, WORKSPACE, 1)
    await appendMediaChunk(id, 1, Buffer.alloc(MAX_CHUNK_BYTES, 7))
    expect(fs.statSync(path.join(imagesDir(app), listing(app)[0])).size).toBe(MAX_CHUNK_BYTES)

    await expect(appendMediaChunk(id, 1, Buffer.alloc(MAX_CHUNK_BYTES + 1))).rejects.toThrow('Video exceeds size limit')
    expect(listing(app)).toEqual([])
    await expect(appendMediaChunk(id, 1, Buffer.from('more'))).rejects.toThrow('Media session not found')
    await expect(finishMediaFile(id, 1)).rejects.toThrow('Media session not found')
    await expect(abortMediaFile(id, 1)).resolves.toBeUndefined()
  })

  test('the 512 MiB total is allowed exactly and refused one byte later', async () => {
    hooks.skipWrites = true
    const app = testApp()
    const chunk = Buffer.alloc(MAX_CHUNK_BYTES)
    const chunkCount = MAX_MEDIA_BYTES / MAX_CHUNK_BYTES

    const exact = await openMediaFile(app, WORKSPACE, 1)
    for (let i = 0; i < chunkCount; i++) await appendMediaChunk(exact, 1, chunk)
    const url = await finishMediaFile(exact, 1)
    expect(fs.existsSync(localPath(url))).toBe(true)

    const over = await openMediaFile(app, WORKSPACE, 1)
    for (let i = 0; i < chunkCount; i++) await appendMediaChunk(over, 1, chunk)
    await expect(appendMediaChunk(over, 1, Buffer.alloc(1))).rejects.toThrow('Video exceeds size limit')
    await expect(finishMediaFile(over, 1)).rejects.toThrow('Media session not found')
    expect(listing(app)).toEqual([path.basename(localPath(url))])
  })

  test('anything that is not bytes is refused and the session stays usable', async () => {
    const app = testApp()
    const id = await openMediaFile(app, WORKSPACE, 1)
    const invalid: unknown[] = [
      'text', '', 0, 42, NaN, true, null, undefined, [], [1, 2, 3], {}, { length: 4 },
      { type: 'Buffer', data: [1, 2, 3] },
      new ArrayBuffer(16), new DataView(new ArrayBuffer(16)),
      new Uint16Array(8), new Float64Array(2), new Uint8ClampedArray(4),
      Symbol('chunk'), () => Buffer.from('x'),
    ]
    for (const chunk of invalid) {
      await expect(appendMediaChunk(id, 1, chunk)).rejects.toThrow('Invalid media chunk')
    }
    await appendMediaChunk(id, 1, Buffer.from('0123456789abcdef'))
    const url = await finishMediaFile(id, 1)
    expect(fs.readFileSync(localPath(url)).toString()).toBe('0123456789abcdef')
  })

  test('files shorter than 12 bytes are never published, 12 bytes are', async () => {
    const app = testApp()
    for (const size of [0, 1, 11]) {
      const id = await openMediaFile(app, WORKSPACE, 1)
      if (size) await appendMediaChunk(id, 1, Buffer.alloc(size, 1))
      await expect(finishMediaFile(id, 1)).rejects.toThrow('Video file was empty')
      expect(listing(app)).toEqual([])
    }
    const id = await openMediaFile(app, WORKSPACE, 1)
    for (let i = 0; i < 12; i++) await appendMediaChunk(id, 1, Buffer.alloc(1, i))
    await appendMediaChunk(id, 1, new Uint8Array(0))
    const url = await finishMediaFile(id, 1)
    expect(fs.statSync(localPath(url)).size).toBe(12)
  })

})

describe('concurrent sessions', () => {

  test('interleaved writers across renderers and workspaces never mix their bytes', async () => {
    const random = prng(2)
    const app = testApp()
    type Writer = { id: string, sender: number, workspace: string, payload: Buffer, offset: number, fate: 'finish' | 'abort' | 'orphan' }
    const writers: Writer[] = []
    for (let index = 0; index < 30; index++) {
      const sender = 1 + (index % 4)
      const workspace = index % 3 === 0 ? OTHER_WORKSPACE : WORKSPACE
      writers.push({
        id: await openMediaFile(app, workspace, sender),
        sender,
        workspace,
        payload: bytes(random, int(random, 2000, 60000)),
        offset: 0,
        fate: sender === 4 ? 'orphan' : index % 5 === 1 ? 'abort' : 'finish',
      })
    }
    expect(new Set(writers.map((writer) => writer.id)).size).toBe(30)

    // Each round every unfinished writer appends one chunk, all at the same time.
    while (writers.some((writer) => writer.offset < writer.payload.length)) {
      await Promise.all(writers.filter((writer) => writer.offset < writer.payload.length).map((writer) => {
        const size = Math.min(int(random, 1, 5000), writer.payload.length - writer.offset)
        const chunk = writer.payload.subarray(writer.offset, writer.offset + size)
        writer.offset += size
        return appendMediaChunk(writer.id, writer.sender, chunk)
      }))
    }

    // Renderer 4 goes away mid-flight. The others finish or abort, all at once.
    const closing = abortMediaForSender(4)
    const urls = await Promise.all(writers.map(async (writer) => {
      if (writer.fate === 'finish') return finishMediaFile(writer.id, writer.sender)
      if (writer.fate === 'abort') await abortMediaFile(writer.id, writer.sender)
      return null
    }))
    await closing

    const expected: Record<string, number> = { [WORKSPACE]: 0, [OTHER_WORKSPACE]: 0 }
    writers.forEach((writer, index) => {
      if (writer.fate !== 'finish') return
      expected[writer.workspace] += 1
      const file = localPath(urls[index])
      expect(path.dirname(file)).toBe(imagesDir(app, writer.workspace))
      expect(fs.readFileSync(file).equals(writer.payload)).toBe(true)
    })
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      const names = listing(app, workspace)
      expect(names.filter((name) => name.endsWith('.partial'))).toEqual([])
      expect(names).toHaveLength(expected[workspace])
    }
    for (const writer of writers) {
      await expect(appendMediaChunk(writer.id, writer.sender, Buffer.from('late'))).rejects.toThrow('Media session not found')
    }
  })

  test('random open, append, finish, and abort calls keep the folder in step with the sessions', async () => {
    const random = prng(3)
    const app = testApp()
    type Model = { id: string, sender: number, size: number, state: 'open' | 'published' | 'gone' }
    const sessions: Model[] = []
    const any = () => sessions[int(random, 0, sessions.length - 1)]

    for (let step = 0; step < 600; step++) {
      const action = int(random, 0, 9)
      if (action <= 1 || sessions.length === 0) {
        const sender = int(random, 1, 3)
        sessions.push({ id: await openMediaFile(app, WORKSPACE, sender), sender, size: 0, state: 'open' })
      } else if (action <= 5) {
        const target = any()
        const chunk = Buffer.alloc(int(random, 0, 40), step & 0xff)
        const work = appendMediaChunk(target.id, target.sender, chunk)
        if (target.state === 'open') {
          await work
          target.size += chunk.length
        } else {
          await expect(work).rejects.toThrow('Media session not found')
        }
      } else if (action === 6) {
        const target = any()
        const work = finishMediaFile(target.id, target.sender)
        if (target.state !== 'open') {
          await expect(work).rejects.toThrow('Media session not found')
        } else if (target.size < 12) {
          await expect(work).rejects.toThrow('Video file was empty')
          target.state = 'gone'
        } else {
          expect(fs.statSync(localPath(await work)).size).toBe(target.size)
          target.state = 'published'
        }
      } else if (action === 7) {
        const target = any()
        await abortMediaFile(target.id, target.sender)
        if (target.state === 'open') target.state = 'gone'
      } else if (action === 8) {
        // Another renderer cannot touch the session in any way.
        const target = any()
        const stranger = target.sender + 10
        await expect(appendMediaChunk(target.id, stranger, Buffer.from('x'))).rejects.toThrow('Media session not found')
        await expect(finishMediaFile(target.id, stranger)).rejects.toThrow('Media session not found')
        await abortMediaFile(target.id, stranger)
        await abortMediaForSender(stranger)
      } else {
        const sender = int(random, 1, 3)
        await abortMediaForSender(sender)
        for (const session of sessions) {
          if (session.sender === sender && session.state === 'open') session.state = 'gone'
        }
      }

      const names = listing(app)
      const open = sessions.filter((session) => session.state === 'open').map((session) => `${session.id}.mp4.partial`).sort()
      const published = sessions.filter((session) => session.state === 'published').map((session) => `${session.id}.mp4`).sort()
      expect(names.filter((name) => name.endsWith('.partial'))).toEqual(open)
      expect(names.filter((name) => name.endsWith('.mp4'))).toEqual(published)
    }

    await Promise.all([1, 2, 3].map((sender) => abortMediaForSender(sender)))
    expect(listing(app).filter((name) => name.endsWith('.partial'))).toEqual([])
  })

})

describe('paths and housekeeping', () => {

  test('hostile workspace ids and sender ids are refused and nothing is created for them', async () => {
    const app = testApp()
    const root = app.getPath('userData')
    const workspaces = [
      '', ' ', '.', '..', '../..', '../../etc', '/etc', 'C:\\Windows', `${WORKSPACE}/..`, `${WORKSPACE}\\..`,
      `${WORKSPACE}\u0000`, `${WORKSPACE}\n`, ` ${WORKSPACE}`, `${WORKSPACE} `, `{${WORKSPACE}}`,
      WORKSPACE.replace(/-/g, ''), WORKSPACE.replace('1', 'g'), `${WORKSPACE}${WORKSPACE}`,
      '１１１１１１１１-1111-4111-8111-111111111111', 'default', 'a'.repeat(5000),
    ]
    for (const workspace of workspaces) {
      await expect(openMediaFile(app, workspace, 1)).rejects.toThrow('Invalid workspace')
    }
    for (const sender of [-1, 1.5, NaN, Infinity, -Infinity, '1' as unknown as number, null as unknown as number, undefined as unknown as number]) {
      await expect(openMediaFile(app, WORKSPACE, sender)).rejects.toThrow('Invalid media session')
    }
    expect(fs.readdirSync(root)).toEqual([])
    expect(fs.readdirSync(path.dirname(root)).filter((name) => name === 'etc' || name === 'outside')).toEqual([])
  })

  test('opening a file sweeps stale partials and leaves everything else alone', async () => {
    const app = testApp()
    const dir = imagesDir(app)
    fs.mkdirSync(dir, { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const recent = new Date(Date.now() - 10 * 60 * 1000)
    const touch = (name: string, when: Date) => {
      fs.writeFileSync(path.join(dir, name), 'data')
      fs.utimesSync(path.join(dir, name), when, when)
    }
    const stale = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4.partial'
    const staleUpper = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB.MP4.PARTIAL'
    const fresh = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp4.partial'
    const keep = [
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd.mp4',
      'holiday.mp4.partial',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png.partial',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.mp4.partial.bak',
      'picture.png',
    ]
    touch(stale, old)
    touch(staleUpper, old)
    touch(fresh, recent)
    for (const name of keep) touch(name, old)
    const folder = 'ffffffff-ffff-4fff-8fff-ffffffffffff.mp4.partial'
    fs.mkdirSync(path.join(dir, folder))
    fs.utimesSync(path.join(dir, folder), old, old)

    const id = await openMediaFile(app, WORKSPACE, 1)

    expect(listing(app)).toEqual([...keep, fresh, folder, `${id}.mp4.partial`].sort())
    await abortMediaFile(id, 1)
  })

  test('an in-flight download is not swept by a later one, however many are opened', async () => {
    const app = testApp()
    const first = await openMediaFile(app, WORKSPACE, 1)
    await appendMediaChunk(first, 1, Buffer.from('0123456789abcdef'))
    const later = await Promise.all(Array.from({ length: 40 }, () => openMediaFile(app, WORKSPACE, 2)))
    await appendMediaChunk(first, 1, Buffer.from('0123456789abcdef'))
    const url = await finishMediaFile(first, 1)
    expect(fs.statSync(localPath(url)).size).toBe(32)
    await abortMediaForSender(2)
    expect(listing(app)).toEqual([`${first}.mp4`])
    expect(new Set(later).size).toBe(40)
  })

  test.fails('BUG: a publish that fails on rename does not leave the partial file behind', async () => {
    const app = testApp()
    const id = await openMediaFile(app, WORKSPACE, 1)
    await appendMediaChunk(id, 1, Buffer.from('0123456789abcdef'))
    hooks.failRename = true

    await expect(finishMediaFile(id, 1)).rejects.toThrow('EPERM')
    await abortMediaFile(id, 1)

    expect(listing(app)).toEqual([])
  })

})
