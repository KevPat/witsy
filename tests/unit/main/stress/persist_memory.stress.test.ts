
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Embedder from '@main/rag/embedder'
import MemoryManager from '@main/memory'
import { bug } from './bug'

let root: string
let userData: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
      getLocale: vi.fn(() => 'en-US'),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
    },
  }
})

vi.mock('electron-store', async () => {
  class Store {
    get store() { return {} }
    set() {}
    delete() {}
  }
  return { default: Store }
})

// no model, no network: a text always gets the same small vector, different texts get different ones
vi.mock('@main/rag/embedder', async () => {
  const Embedder = vi.fn()
  Embedder.prototype.embed = vi.fn()
  Embedder['init'] = vi.fn()
  return { default: Embedder }
})

const vectorOf = (text: string): number[] => {
  const vector = Array(16).fill(0)
  for (let i = 0; i < text.length; i++) vector[(text.charCodeAt(i) * 7 + i) % 16] += 1
  return vector
}

const memoryDir = () => path.join(userData, 'memory')

const contents = async (memory: MemoryManager): Promise<string[]> => (await memory.list()).map(fact => fact.content).sort()

// settles a promise into a value that can be compared
const outcome = <T>(promise: Promise<T>): Promise<{ value: T } | { rejected: string }> => promise.then(value => ({ value }), error => ({ rejected: String(error?.message ?? error) }))

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-memory-'))
  userData = path.join(root, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  vi.mocked(Embedder.prototype.embed).mockImplementation(async (texts: string[]) => texts.map(vectorOf))
  vi.mocked(Embedder.init).mockImplementation(async () => new Embedder(null, null, null))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('memory', () => {

  test('a new install has no facts, and asking for them creates nothing on disk', async () => {
    const memory = new MemoryManager(app)
    expect(await memory.list()).toEqual([])
    expect(await memory.isNotEmpty()).toBe(false)
    expect(fs.existsSync(memoryDir())).toBe(false)
    expect(await memory.delete('unknown')).toBe(false)
  })

  test('stress: 40 facts stored one after the other are all listed, found again by another instance, and can be deleted', async () => {
    const facts = Array.from({ length: 40 }, (_, i) => `fact number ${i} about ${['tennis', 'squash', '日本語', 'cooking'][i % 4]}`)
    const memory = new MemoryManager(app)
    for (let i = 0; i < facts.length; i += 4) {
      expect(await memory.store(facts.slice(i, i + 4))).toBe(true)
    }
    expect(await contents(memory)).toEqual([...facts].sort())

    const reopened = new MemoryManager(app)
    expect(await reopened.isNotEmpty()).toBe(true)
    expect(await contents(reopened)).toEqual([...facts].sort())
    expect(await reopened.query(facts[7])).toContain(facts[7])

    const listed = await reopened.list()
    for (const fact of listed.slice(0, 20)) expect(await reopened.delete(fact.uuid)).toBe(true)
    expect(await reopened.list()).toHaveLength(20)
    expect(await reopened.delete(listed[0].uuid)).toBe(false)
  })

  test('a single string is stored as one fact', async () => {
    const memory = new MemoryManager(app)
    expect(await memory.store('I play squash' as any)).toBe(true)
    expect(await contents(memory)).toEqual(['I play squash'])
  })

  test('reset forgets everything, and facts can be stored again afterwards', async () => {
    const memory = new MemoryManager(app)
    await memory.store(['one', 'two'])
    await memory.reset()
    expect(fs.existsSync(memoryDir())).toBe(false)
    expect(await memory.list()).toEqual([])
    expect(await memory.store(['three'])).toBe(true)
    expect(await contents(memory)).toEqual(['three'])
  })

  test.each([
    ['cannot be created', () => vi.mocked(Embedder.init).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'))],
    ['fails to embed', () => vi.mocked(Embedder.prototype.embed).mockRejectedValue(new Error('401 Incorrect API key provided'))],
  ])('store reports failure and keeps the existing facts when the embedder %s', async (_, breakEmbedder) => {
    const memory = new MemoryManager(app)
    await memory.store(['one'])
    breakEmbedder()
    expect(await memory.store(['two'])).toBe(false)
    expect(await contents(memory)).toEqual(['one'])
  })

  bug.each([
    ['cannot be created', () => vi.mocked(Embedder.init).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'))],
    ['fails to embed', () => vi.mocked(Embedder.prototype.embed).mockRejectedValue(new Error('401 Incorrect API key provided'))],
  ])('query resolves to no result instead of rejecting when the embedder %s', async (_, breakEmbedder) => {
    // unlike store(), query() has no try/catch; the MEMORY.RETRIEVE sendSync handler awaits it, so the chat window waits forever
    const memory = new MemoryManager(app)
    await memory.store(['one'])
    breakEmbedder()
    expect(await outcome(memory.query('one'))).toEqual({ value: [] })
  })

  test('facts stored concurrently by two windows are all kept once the memory is open', async () => {
    const memory = new MemoryManager(app)
    await memory.store(['first'])
    const facts = Array.from({ length: 12 }, (_, i) => `concurrent fact ${i}`)
    const results = await Promise.all(facts.map(fact => memory.store([fact])))
    expect(results).toEqual(Array(12).fill(true))
    expect(await contents(memory)).toEqual([...facts, 'first'].sort())
    expect(await contents(new MemoryManager(app))).toEqual([...facts, 'first'].sort())
  })

  bug('facts stored concurrently by two windows on a new install are all kept', async () => {
    // every call sees no database yet and creates and opens its own index; each one then writes index.json with its own fact, and every call reports success
    const memory = new MemoryManager(app)
    const facts = Array.from({ length: 12 }, (_, i) => `concurrent fact ${i}`)
    const results = await Promise.all(facts.map(fact => memory.store([fact])))
    const stored = await contents(new MemoryManager(app))
    expect({ reported: results.filter(result => result === true).length, stored: stored.length }).toEqual({ reported: 12, stored: 12 })
  })

  bug.each([
    ['list', (memory: MemoryManager) => memory.list()],
    ['isNotEmpty', (memory: MemoryManager) => memory.isNotEmpty()],
    ['query', (memory: MemoryManager) => memory.query('one')],
    ['delete', (memory: MemoryManager) => memory.delete('unknown')],
  ])('%s does not reject when the index file is truncated', async (_, call) => {
    // only store() catches errors; the JSON.parse error of the index reaches the sendSync handlers, which then never reply
    const memory = new MemoryManager(app)
    await memory.store(['one', 'two'])
    const indexFile = path.join(memoryDir(), 'index.json')
    const text = fs.readFileSync(indexFile, 'utf-8')
    fs.writeFileSync(indexFile, text.slice(0, Math.floor(text.length / 2)))
    expect(await outcome(call(new MemoryManager(app)))).toHaveProperty('value')
  })

  bug('a memory folder left without its index does not disable the memory for good', async () => {
    // the folder alone makes open() succeed, so the index is never created again: store() fails every time and list() rejects
    fs.mkdirSync(memoryDir(), { recursive: true })
    const memory = new MemoryManager(app)
    expect(await outcome(memory.store(['one']))).toEqual({ value: true })
    expect(await outcome(memory.list())).toMatchObject({ value: [{ content: 'one' }] })
  })

})
