
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import MemoryManager from '@main/memory'

let userData: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
    },
  }
})

vi.mock('@main/config', async () => {
  return {
    loadSettings: vi.fn(() => ({ plugins: { memory: { engine: 'openai', model: 'text-embedding-3-small' } } })),
  }
})

// embedder double: no network, one fixed vector per text
vi.mock('@main/rag/embedder', async () => {
  class Embedder {
    static async init() { return new Embedder() }
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [0.5, 0.5, 0.5, 0.5])
    }
  }
  return { default: Embedder }
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

// what a restart of the application would find
const persistedFacts = async () => (await new MemoryManager(app).list()).map(fact => fact.content).sort()

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-memory-stress-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('MemoryManager', () => {

  test('facts are stored, queried, deleted and survive a restart', async () => {
    const memory = new MemoryManager(app)
    expect(await memory.isNotEmpty()).toBe(false)
    expect(await memory.store(['fact one', 'fact two'])).toBe(true)
    expect(await memory.store('fact three')).toBe(true)
    expect(await memory.isNotEmpty()).toBe(true)
    expect((await memory.query('fact')).sort()).toEqual(['fact one', 'fact three', 'fact two'])
    const facts = await memory.list()
    expect(await memory.delete(facts.find(fact => fact.content === 'fact two').uuid)).toBe(true)
    expect(await memory.delete('unknown')).toBe(false)
    expect(await persistedFacts()).toEqual(['fact one', 'fact three'])
    await memory.reset()
    expect(await persistedFacts()).toEqual([])
  })

  test('stress: 150 facts stored one after the other are all persisted', async () => {
    const memory = new MemoryManager(app)
    const facts = Array.from({ length: 150 }, (_, i) => `fact number ${String(i).padStart(3, '0')}`)
    for (let i = 0; i < facts.length; i += 3) {
      expect(await memory.store(facts.slice(i, i + 3))).toBe(true)
    }
    expect(await persistedFacts()).toEqual(facts)
  })

  test('a fact stored while another one is being written is persisted too', async () => {
    // the second insert used to join the update of the first one, whose file content was already serialised,
    // and to return without writing: the fact only existed in memory until something else was stored.
    // It now waits for the first write, so it can only complete once that write is released
    const memory = new MemoryManager(app)
    await memory.store('seed')
    const writeFile = fs.promises.writeFile
    const gate = deferred()
    let writes = 0
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof writeFile>) => {
      if (++writes === 1) await gate.promise
      return writeFile(...args)
    })
    const first = memory.store('first fact')
    await vi.waitUntil(() => writes === 1, { timeout: 2000, interval: 2 })
    const second = memory.store('second fact')
    gate.resolve()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await persistedFacts()).toEqual(['first fact', 'second fact', 'seed'])
  })

})
