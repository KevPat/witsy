
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import DocumentRepository from '@main/rag/docrepo'
import { emitIpcEventToAll } from '@main/window'
import { RagConfig } from '@/types/config'
import { DocRepoListener, DocumentSource } from '@/types/rag'
import defaultSettings from '@root/defaults/settings.json'
import { bug } from './bug'

let root: string
let userData: string
let docs: string
let ragConfig: RagConfig

vi.mock('electron', async () => {
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
    app: {
      getPath: vi.fn(() => userData),
    },
  }
})

vi.mock('@main/window', async () => {
  return {
    emitIpcEventToAll: vi.fn(),
  }
})

vi.mock('@main/config', async () => {
  return {
    loadSettings: vi.fn(() => ({ rag: ragConfig })),
  }
})

// embedder double: no network, every batch is recorded and a test can delay or fail a call through `embedHook`
let embedCalls: string[][] = []
let embedHook: null | ((texts: string[], call: number) => void | Promise<void>) = null

vi.mock('@main/rag/embedder', async () => {
  class Embedder {
    static async init() { return new Embedder() }
    async embed(texts: string[]): Promise<number[][]> {
      embedCalls.push(texts)
      if (embedHook) await embedHook(texts, embedCalls.length)
      return texts.map(() => [0.5, 0.5, 0.5, 0.5])
    }
  }
  return { default: Embedder }
})

// deterministic PRNG so a failing scenario can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

const repos: DocumentRepository[] = []

const newRepo = (): DocumentRepository => {
  const docrepo = new DocumentRepository(app)
  repos.push(docrepo)
  return docrepo
}

const createBase = (docrepo: DocumentRepository, name: string) => docrepo.createDocBase('workspace', name, 'openai', 'text-embedding-3-small')

// the queue loop has returned: either everything was processed or it gave up
const settled = (docrepo: DocumentRepository) => vi.waitUntil(() => !docrepo.processing, { timeout: 2000, interval: 2 })

const words = (count: number, word = 'lorem') => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ')

const writeDoc = (name: string, text: string = words(20)): string => {
  const file = path.join(docs, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const documentsOf = (docrepo: DocumentRepository, baseId: string) => docrepo.list('workspace').find(base => base.uuid === baseId)?.documents ?? []

// what a restart would find in the vector index of a base
const indexOnDisk = (baseId: string): { docId: string, content: string }[] => {
  const file = path.join(userData, 'docrepo', baseId, 'index.json')
  return JSON.parse(fs.readFileSync(file, 'utf-8')).items.map((item: any) => item.metadata)
}

const docIdsOnDisk = (baseId: string) => [...new Set(indexOnDisk(baseId).map(item => item.docId))].sort()

const chunksOnDisk = (baseId: string, docId: string) => indexOnDisk(baseId).filter(item => item.docId === docId)

const processedOrigins = () => vi.mocked(emitIpcEventToAll).mock.calls
  .filter(call => call[0] === 'docrepo-process-item-start')
  .map(call => path.basename((call[1] as { origin: string }).origin))

const reportedErrors = () => vi.mocked(emitIpcEventToAll).mock.calls
  .filter(call => call[0] === 'docrepo-add-document-error' || call[0] === 'docrepo-del-document-error')
  .map(call => (call[1] as { error: string }).error)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-docrepo-stress-'))
  userData = path.join(root, 'userData')
  docs = path.join(root, 'docs')
  fs.mkdirSync(userData)
  fs.mkdirSync(docs)
  ragConfig = JSON.parse(JSON.stringify(defaultSettings.rag))
  embedCalls = []
  embedHook = null
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  embedHook = null
  await vi.waitUntil(() => repos.every(docrepo => !docrepo.processing), { timeout: 2000, interval: 2 }).catch(() => {})
  repos.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('DocumentRepository queue', () => {

  test('documents queued on several bases are all indexed, in order', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const b = await createBase(docrepo, 'B')
    for (let i = 0; i < 10; i++) {
      await docrepo.addDocumentSource(i % 2 ? a : b, 'file', writeDoc(`doc${i}.txt`), true)
    }
    await settled(docrepo)
    expect(docrepo.queueLength()).toBe(0)
    expect(processedOrigins()).toEqual(Array.from({ length: 10 }, (_, i) => `doc${i}.txt`))
    expect(documentsOf(docrepo, a).map(doc => doc.filename)).toEqual(['doc1.txt', 'doc3.txt', 'doc5.txt', 'doc7.txt', 'doc9.txt'])
    expect(docIdsOnDisk(a)).toEqual(documentsOf(docrepo, a).map(doc => doc.uuid).sort())
    expect(docIdsOnDisk(b)).toEqual(documentsOf(docrepo, b).map(doc => doc.uuid).sort())
  })

  test('deleting an idle base leaves the queue usable', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const b = await createBase(docrepo, 'B')
    await docrepo.addDocumentSource(a, 'file', writeDoc('a.txt'), true)
    await settled(docrepo)
    await docrepo.deleteDocBase(a)
    await docrepo.addDocumentSource(b, 'file', writeDoc('b.txt'), true)
    await settled(docrepo)
    expect(docrepo.queueLength()).toBe(0)
    expect(documentsOf(docrepo, b).map(doc => doc.filename)).toEqual(['b.txt'])
    expect(fs.existsSync(path.join(userData, 'docrepo', a))).toBe(false)
  })

  bug('deleting a base that still has queued documents does not block the queue', async () => {
    // the queued item of the deleted base makes connect() throw before it is shifted, on every later run of the loop
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const b = await createBase(docrepo, 'B')
    await docrepo.addDocumentSource(a, 'file', writeDoc('a1.txt'), true)
    await docrepo.addDocumentSource(a, 'file', writeDoc('a2.txt'), true)
    await docrepo.deleteDocBase(a)
    await docrepo.addDocumentSource(b, 'file', writeDoc('b1.txt'), true)
    await settled(docrepo)
    expect(docrepo.queue.map(item => path.basename(item.origin))).toEqual([])
    expect(documentsOf(docrepo, b).map(doc => doc.filename)).toEqual(['b1.txt'])
  })

  bug('a queue blocked by a deleted base recovers when another document is added', async () => {
    // same defect seen later: the stale head is retried and fails again each time something is queued
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const b = await createBase(docrepo, 'B')
    await docrepo.addDocumentSource(a, 'file', writeDoc('a1.txt'), true)
    await docrepo.addDocumentSource(a, 'file', writeDoc('a2.txt'), true)
    await docrepo.deleteDocBase(a)
    await settled(docrepo)
    for (let i = 0; i < 5; i++) {
      await docrepo.addDocumentSource(b, 'file', writeDoc(`b${i}.txt`), true)
      await settled(docrepo)
    }
    expect(documentsOf(docrepo, b).map(doc => doc.filename)).toEqual(['b0.txt', 'b1.txt', 'b2.txt', 'b3.txt', 'b4.txt'])
  })

  bug('deleting a base stops the indexing of its folder that is in progress', async () => {
    // nothing aborts the running task: every remaining file is still sent to the embedding service
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    for (let i = 0; i < 6; i++) writeDoc(`folder/file${i}.txt`)
    const gate = deferred()
    embedHook = (_, call) => call === 1 ? gate.promise : undefined
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await vi.waitUntil(() => embedCalls.length === 1, { timeout: 2000, interval: 2 })
    await docrepo.deleteDocBase(a)
    gate.resolve()
    await settled(docrepo)
    expect(embedCalls.length).toBe(1)
  })

  bug('a base deleted while its folder is being indexed does not stall documents queued for other bases', async () => {
    // listeners are notified with a null document for the vanished base; the monitor dereferences it and the loop dies
    const docrepo = newRepo()
    const notified: string[] = []
    const listener: DocRepoListener = {
      onDocumentSourceAdded: (source: DocumentSource) => { notified.push(source.origin) },
      onDocumentSourceRemoved: () => {},
    }
    docrepo.addListener(listener)
    const a = await createBase(docrepo, 'A')
    const b = await createBase(docrepo, 'B')
    for (let i = 0; i < 3; i++) writeDoc(`folder/file${i}.txt`)
    const gate = deferred()
    embedHook = (_, call) => call === 1 ? gate.promise : undefined
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await docrepo.addDocumentSource(b, 'file', writeDoc('b1.txt'), true)
    await vi.waitUntil(() => embedCalls.length === 1, { timeout: 2000, interval: 2 })
    await docrepo.deleteDocBase(a)
    gate.resolve()
    await settled(docrepo)
    expect(docrepo.queue.map(item => path.basename(item.origin))).toEqual([])
    expect(documentsOf(docrepo, b).map(doc => doc.filename)).toEqual(['b1.txt'])
  })

  bug('a document added twice while the queue is busy is indexed once', async () => {
    // an origin is only looked up in the indexed documents, not in the queue, so the second request gets a new id
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const gate = deferred()
    embedHook = (_, call) => call === 1 ? gate.promise : undefined
    await docrepo.addDocumentSource(a, 'file', writeDoc('first.txt'), true)
    await vi.waitUntil(() => embedCalls.length === 1, { timeout: 2000, interval: 2 })
    const twice = writeDoc('twice.txt')
    await docrepo.addDocumentSource(a, 'file', twice, true)
    await docrepo.addDocumentSource(a, 'file', twice, true)
    gate.resolve()
    await settled(docrepo)
    expect(documentsOf(docrepo, a).map(doc => doc.filename)).toEqual(['first.txt', 'twice.txt'])
  })

  bug('a failed index write during a removal does not block later additions to the base', async () => {
    // the transaction of the failed removal is never cancelled: every later one fails with "Update already in progress"
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await docrepo.addDocumentSource(a, 'file', writeDoc('first.txt'), true)
    await settled(docrepo)
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'))
    await docrepo.removeDocumentSource(a, documentsOf(docrepo, a)[0].uuid)
    await settled(docrepo)
    vi.mocked(emitIpcEventToAll).mockClear()
    await docrepo.addDocumentSource(a, 'file', writeDoc('second.txt'), true)
    await settled(docrepo)
    expect(reportedErrors()).toEqual([])
    expect(documentsOf(docrepo, a).map(doc => doc.filename)).toContain('second.txt')
  })

})

describe('DocumentRepository random interleavings', () => {

  // fires add / re-add / remove / update / cancel requests without waiting for the queue
  const scenario = async (seed: number, withBaseDeletion: boolean) => {
    const rand = mulberry32(seed)
    const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]
    const docrepo = newRepo()
    const bases = [await createBase(docrepo, 'base0'), await createBase(docrepo, 'base1')]
    const tasks: string[] = []
    let files = 0
    const addNew = async (baseId: string) => {
      tasks.push(await docrepo.addDocumentSource(baseId, 'file', writeDoc(`file${files++}.txt`, words(5 + Math.floor(rand() * 40))), true))
    }
    for (let i = 0; i < 100; i++) {
      const index = Math.floor(rand() * bases.length)
      const baseId = bases[index]
      const documents = docrepo.contents.find(base => base.uuid === baseId).documents
      const action = rand()
      if (action < 0.40) {
        await addNew(baseId)
      } else if (action < 0.50) {
        if (documents.length) tasks.push(await docrepo.addDocumentSource(baseId, 'file', pick(documents).origin, false))
      } else if (action < 0.65) {
        if (documents.length) await docrepo.removeDocumentSource(baseId, pick(documents).uuid)
      } else if (action < 0.75) {
        if (documents.length) await docrepo.updateDocumentSource(baseId, pick(documents).uuid, false)
      } else if (action < 0.90) {
        if (tasks.length) docrepo.cancelTask(pick(tasks))
      } else if (withBaseDeletion) {
        await addNew(baseId)
        await addNew(baseId)
        await docrepo.deleteDocBase(baseId)
        bases[index] = await createBase(docrepo, `base${i}`)
      } else {
        await settled(docrepo)
      }
      if (rand() < 0.1) await settled(docrepo)
    }
    await settled(docrepo)
    return docrepo
  }

  const snapshot = (docrepo: DocumentRepository) => docrepo.list('workspace').map(base => ({
    uuid: base.uuid,
    name: base.name,
    documents: base.documents.map(doc => ({ uuid: doc.uuid, origin: doc.origin })),
  }))

  const checkInvariants = (docrepo: DocumentRepository, seed: number) => {
    expect(docrepo.queue.length, `seed=${seed}: documents left in the queue`).toBe(0)
    expect(docrepo.activeProcessingTasks.size, `seed=${seed}: abort controllers left`).toBe(0)
    for (const base of docrepo.contents) {
      const uuids = base.documents.map(doc => doc.uuid).sort()
      expect(new Set(uuids).size, `seed=${seed}: duplicate document ids`).toBe(uuids.length)
      expect(docIdsOnDisk(base.uuid), `seed=${seed}: vector index and document list differ`).toEqual(uuids)
    }
    expect(snapshot(newRepo()), `seed=${seed}: docrepo.json differs from memory`).toEqual(snapshot(docrepo))
  }

  test.each([1, 20261127, 424242])('seed %i: add, re-add, remove, update and cancel requests drain and leave index and list consistent', async (seed) => {
    const docrepo = await scenario(seed, false)
    checkInvariants(docrepo, seed)
  })

  bug.each([1, 20261127, 424242])('seed %i: the same requests mixed with base deletions drain and leave index and list consistent', async (seed) => {
    // the first base deleted with queued documents blocks the queue for the rest of the scenario
    const docrepo = await scenario(seed, true)
    checkInvariants(docrepo, seed)
  })

})

describe('DocumentRepository index consistency', () => {

  const addFolder = async (docrepo: DocumentRepository, baseId: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) writeDoc(`folder/${name}`, text)
    const taskId = await docrepo.addDocumentSource(baseId, 'folder', path.join(docs, 'folder'), true)
    return taskId
  }

  beforeEach(() => {
    ragConfig.chunkSize = 100
    ragConfig.chunkOverlap = 0
  })

  test('a folder is indexed with one set of chunks per file', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await addFolder(docrepo, a, { 'a.txt': words(60, 'alpha'), 'b.txt': words(60, 'beta'), 'c.txt': words(60, 'gamma') })
    await settled(docrepo)
    const folder = documentsOf(docrepo, a)[0]
    expect(folder.items.map(item => item.filename).sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(docIdsOnDisk(a)).toEqual(folder.items.map(item => item.uuid).sort())
    for (const item of folder.items) {
      expect(chunksOnDisk(a, item.uuid).map(chunk => chunk.content).join('').replace(/\s+/g, '')).toBe(fs.readFileSync(item.origin, 'utf-8').replace(/\s+/g, ''))
    }
  })

  test('re-indexing a top level file replaces its chunks', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const file = writeDoc('note.txt', words(60, 'obsolete'))
    await docrepo.addDocumentSource(a, 'file', file, true)
    await settled(docrepo)
    const uuid = documentsOf(docrepo, a)[0].uuid
    fs.writeFileSync(file, words(60, 'current'))
    await docrepo.updateDocumentSource(a, uuid, false)
    await settled(docrepo)
    expect(documentsOf(docrepo, a).map(doc => doc.uuid)).toEqual([uuid])
    expect(chunksOnDisk(a, uuid).filter(chunk => chunk.content.includes('obsolete'))).toEqual([])
    expect(chunksOnDisk(a, uuid).length).toBeGreaterThan(0)
  })

  bug.each([
    ['offline scan (updateChildDocumentSource)', (docrepo: DocumentRepository, baseId: string, folder: DocumentSource, child: DocumentSource) => docrepo.updateChildDocumentSource(baseId, child.uuid, false)],
    ['file watcher (addChildDocumentSource)', (docrepo: DocumentRepository, baseId: string, folder: DocumentSource, child: DocumentSource) => docrepo.addChildDocumentSource(baseId, folder.uuid, 'file', child.origin, false)],
  ])('re-indexing a file of a folder through the %s does not duplicate its chunks', async (_, reindex) => {
    // processChildDocumentSource() embeds the file again without deleting the chunks it already has
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await addFolder(docrepo, a, { 'a.txt': words(60, 'alpha'), 'b.txt': words(60, 'beta') })
    await settled(docrepo)
    const folder = documentsOf(docrepo, a)[0]
    const child = folder.items.find(item => item.filename === 'a.txt')
    const before = chunksOnDisk(a, child.uuid).length
    expect(before).toBeGreaterThan(1)
    await reindex(docrepo, a, folder, child)
    await settled(docrepo)
    expect(chunksOnDisk(a, child.uuid).length).toBe(before)
  })

  bug('the previous content of a modified folder file is no longer in the index', async () => {
    // same defect: the old chunks stay next to the new ones and keep being returned by queries
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await addFolder(docrepo, a, { 'a.txt': words(60, 'obsolete'), 'b.txt': words(60, 'beta') })
    await settled(docrepo)
    const child = documentsOf(docrepo, a)[0].items.find(item => item.filename === 'a.txt')
    fs.writeFileSync(child.origin, words(60, 'current'))
    await docrepo.doScanForUpdates(a)
    await settled(docrepo)
    expect(chunksOnDisk(a, child.uuid).some(chunk => chunk.content.includes('current'))).toBe(true)
    expect(chunksOnDisk(a, child.uuid).filter(chunk => chunk.content.includes('obsolete')).length).toBe(0)
  })

  bug.each([
    ['offline scan or rescan (updateDocumentSource)', (docrepo: DocumentRepository, baseId: string, doc: DocumentSource) => docrepo.updateDocumentSource(baseId, doc.uuid, false)],
    ['file watcher (addDocumentSource)', (docrepo: DocumentRepository, baseId: string, doc: DocumentSource) => docrepo.addDocumentSource(baseId, 'file', doc.origin, false)],
  ])('a document survives a re-indexing through the %s that fails because embeddings are unavailable', async (_, reindex) => {
    // the old chunks are deleted and committed before the new ones are computed, and the document is dropped on error
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await docrepo.addDocumentSource(a, 'file', writeDoc('note.txt', words(60)), true)
    await settled(docrepo)
    const doc = documentsOf(docrepo, a)[0]
    const before = chunksOnDisk(a, doc.uuid).length
    embedHook = () => { throw new Error('embedding service unavailable') }
    await reindex(docrepo, a, doc)
    await settled(docrepo)
    expect(documentsOf(docrepo, a).map(item => item.uuid)).toEqual([doc.uuid])
    expect(chunksOnDisk(a, doc.uuid).length).toBe(before)
  })

  bug('a document whose indexing failed halfway is not returned by queries', async () => {
    // the vectra "transaction" shares its items array with the live index, so cancelling it removes nothing
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    embedHook = (_, call) => { if (call === 2) throw new Error('rate limited') }
    await docrepo.addDocumentSource(a, 'file', writeDoc('big.txt', words(600)), true)
    await settled(docrepo)
    expect(embedCalls.length).toBe(2)
    expect(documentsOf(docrepo, a)).toEqual([])
    embedHook = null
    const results = await docrepo.query(a, 'lorem')
    expect(results.map(result => result.metadata.title)).toEqual([])
  })

  bug('the chunks of a document whose indexing failed halfway are not persisted by the next commit', async () => {
    // same defect: the orphan chunks are written to index.json when the next document is added
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    embedHook = (_, call) => { if (call === 2) throw new Error('rate limited') }
    await docrepo.addDocumentSource(a, 'file', writeDoc('big.txt', words(600)), true)
    await settled(docrepo)
    embedHook = null
    await docrepo.addDocumentSource(a, 'file', writeDoc('small.txt', words(10)), true)
    await settled(docrepo)
    expect(docIdsOnDisk(a)).toEqual(documentsOf(docrepo, a).map(doc => doc.uuid))
  })

  bug('a file whose indexing is cancelled halfway leaves nothing in the index', async () => {
    // same defect, reached through cancelTask(): the batches embedded before the abort stay in the live index
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const gate = deferred()
    embedHook = (_, call) => call === 2 ? gate.promise : undefined
    const taskId = await docrepo.addDocumentSource(a, 'file', writeDoc('big.txt', words(600)), true)
    await vi.waitUntil(() => embedCalls.length === 2, { timeout: 2000, interval: 2 })
    docrepo.cancelTask(taskId)
    gate.resolve()
    await settled(docrepo)
    expect(documentsOf(docrepo, a)).toEqual([])
    embedHook = null
    await docrepo.addDocumentSource(a, 'file', writeDoc('small.txt', words(10)), true)
    await settled(docrepo)
    expect(docIdsOnDisk(a)).toEqual(documentsOf(docrepo, a).map(doc => doc.uuid))
  })

  bug('a folder whose indexing is cancelled leaves nothing in the index', async () => {
    // the folder entry is dropped from the list but the chunks of the files already committed are never deleted
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const gate = deferred()
    embedHook = (_, call) => call === 3 ? gate.promise : undefined
    const taskId = await addFolder(docrepo, a, { 'a.txt': words(30), 'b.txt': words(30), 'c.txt': words(30), 'd.txt': words(30), 'e.txt': words(30) })
    await vi.waitUntil(() => embedCalls.length === 3, { timeout: 2000, interval: 2 })
    docrepo.cancelTask(taskId)
    gate.resolve()
    await settled(docrepo)
    expect(embedCalls.length).toBe(3)
    expect(documentsOf(docrepo, a)).toEqual([])
    expect(docIdsOnDisk(a)).toEqual([])
  })

  bug('a chunk size above 24576 characters does not ask for empty embedding batches', async () => {
    // the batch size is floor(6144 / (chunkSize / 4)) = 0, so the loop never consumes a chunk;
    // the embedder double rejects the empty batch, otherwise this loop would spin forever
    ragConfig.chunkSize = 30000
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    embedHook = (texts) => { if (texts.length === 0) throw new Error('empty batch') }
    await docrepo.addDocumentSource(a, 'file', writeDoc('note.txt', words(50)), true)
    await settled(docrepo)
    expect(embedCalls.map(batch => batch.length)).toEqual([1])
    expect(documentsOf(docrepo, a).map(doc => doc.filename)).toEqual(['note.txt'])
  })

  test.each([100, 1000, 24576])('a chunk size of %i characters embeds every chunk exactly once', async (chunkSize) => {
    ragConfig.chunkSize = chunkSize
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await docrepo.addDocumentSource(a, 'file', writeDoc('note.txt', words(400)), true)
    await settled(docrepo)
    const uuid = documentsOf(docrepo, a)[0].uuid
    expect(embedCalls.every(batch => batch.length > 0)).toBe(true)
    expect(embedCalls.flat().length).toBe(chunksOnDisk(a, uuid).length)
  })

})

describe('DocumentRepository rescan', () => {

  test('a rescan with nothing changed queues nothing', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    writeDoc('folder/a.txt')
    writeDoc('folder/b.txt')
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await docrepo.addDocumentSource(a, 'file', writeDoc('single.txt'), true)
    await settled(docrepo)
    vi.mocked(emitIpcEventToAll).mockClear()
    await docrepo.doScanForUpdates()
    await settled(docrepo)
    expect(processedOrigins()).toEqual([])
  })

  test('a rescan indexes a new file of a folder once', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    writeDoc('folder/a.txt')
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await settled(docrepo)
    writeDoc('folder/b.txt')
    await docrepo.doScanForUpdates()
    await settled(docrepo)
    expect(documentsOf(docrepo, a)[0].items.map(item => item.filename).sort()).toEqual(['a.txt', 'b.txt'])
  })

  test('two overlapping rescans on an idle queue list a new file of a folder once', async () => {
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    writeDoc('folder/a.txt')
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await settled(docrepo)
    writeDoc('folder/b.txt')
    await Promise.all([docrepo.doScanForUpdates(), docrepo.doScanForUpdates()])
    await settled(docrepo)
    expect(documentsOf(docrepo, a)[0].items.map(item => item.filename).sort()).toEqual(['a.txt', 'b.txt'])
  })

  bug('two rescans requested while the queue is busy index a new file of a folder once', async () => {
    // a file that is queued but not processed yet is seen as untracked again, and is queued with a second id
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    writeDoc('folder/a.txt')
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await settled(docrepo)
    writeDoc('folder/b.txt')
    const gate = deferred()
    const busy = embedCalls.length + 1
    embedHook = (_, call) => call === busy ? gate.promise : undefined
    await docrepo.addDocumentSource(a, 'file', writeDoc('large.txt'), true)
    await vi.waitUntil(() => embedCalls.length === busy, { timeout: 2000, interval: 2 })
    await docrepo.doScanForUpdates()
    await docrepo.doScanForUpdates()
    gate.resolve()
    await settled(docrepo)
    expect(documentsOf(docrepo, a)[0].items.map(item => item.filename).sort()).toEqual(['a.txt', 'b.txt'])
  })

  bug('a rescan requested while a folder is being indexed does not index its files twice', async () => {
    // the folder is listed before its files are processed, so the scan reports all the pending files as new
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) writeDoc(`folder/${name}`)
    const gate = deferred()
    embedHook = (_, call) => call === 1 ? gate.promise : undefined
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await vi.waitUntil(() => embedCalls.length === 1, { timeout: 2000, interval: 2 })
    await docrepo.doScanForUpdates()
    gate.resolve()
    await settled(docrepo)
    expect(documentsOf(docrepo, a)[0].items.map(item => item.filename).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
  })

  bug('a rescan does not queue again the files of a folder that can never be parsed', async () => {
    // the scan reports every file that is not an indexed child as new, without asking the loader if it is supported
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    writeDoc('folder/a.txt')
    writeDoc('folder/picture.png', 'not really a png')
    writeDoc('folder/archive.zip', 'not really a zip')
    await docrepo.addDocumentSource(a, 'folder', path.join(docs, 'folder'), true)
    await settled(docrepo)
    expect(documentsOf(docrepo, a)[0].items.map(item => item.filename)).toEqual(['a.txt'])
    vi.mocked(emitIpcEventToAll).mockClear()
    await docrepo.doScanForUpdates()
    await settled(docrepo)
    expect(processedOrigins()).toEqual([])
  })

})

describe('DocumentRepository web sources', () => {

  const page = '<html><head><title>My Page Title</title></head><body><h1>Heading</h1><p>Some paragraph of text.</p></body></html>'

  test('a web page is indexed from its text', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(page, { status: 200 }))
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await docrepo.addDocumentSource(a, 'url', 'https://example.com/page', true)
    await settled(docrepo)
    const doc = documentsOf(docrepo, a)[0]
    expect(doc.origin).toBe('https://example.com/page')
    expect(chunksOnDisk(a, doc.uuid).map(chunk => chunk.content).join(' ')).toContain('Some paragraph of text.')
  })

  bug('a web page gets the title of its <title> tag', async () => {
    // the title is searched in the output of html-to-text, which has no tags left
    vi.mocked(fetch).mockResolvedValue(new Response(page, { status: 200 }))
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await docrepo.addDocumentSource(a, 'url', 'https://example.com/page', true)
    await settled(docrepo)
    expect(documentsOf(docrepo, a)[0].title).toBe('My Page Title')
  })

  bug.each([403, 404, 500, 503])('an HTTP %i error page is not indexed as the content of a web page', async (status) => {
    // loadUrl() never looks at response.ok
    vi.mocked(fetch).mockResolvedValue(new Response('<html><body>Something went wrong</body></html>', { status }))
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    await docrepo.addDocumentSource(a, 'url', 'https://example.com/page', true)
    await settled(docrepo)
    expect(indexOnDisk(a).map(chunk => chunk.content)).toEqual([])
  })

  bug('cancelling the indexing of a web page aborts the download in progress', async () => {
    // the abort signal of the task is not passed to fetch(), the queue waits for the server
    let release: () => void = () => {}
    vi.mocked(fetch).mockImplementation((_, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      release = () => resolve(new Response(page, { status: 200 }))
    }))
    const docrepo = newRepo()
    const a = await createBase(docrepo, 'A')
    const taskId = await docrepo.addDocumentSource(a, 'url', 'https://example.com/slow', true)
    await vi.waitUntil(() => vi.mocked(fetch).mock.calls.length === 1, { timeout: 2000, interval: 2 })
    docrepo.cancelTask(taskId)
    try {
      await vi.waitFor(() => expect(docrepo.queue.map(item => item.origin)).toEqual([]), { timeout: 300, interval: 10 })
    } finally {
      release()
      await settled(docrepo)
    }
  })

})

describe('DocumentRepository docrepo.json', () => {

  const docrepoFile = () => path.join(userData, 'docrepo.json')

  // the ids of the given bases that can still be found in a file of the user data folder
  const recoverable = (baseIds: string[]): string[] => {
    const files = fs.readdirSync(userData, { withFileTypes: true }).filter(entry => entry.isFile())
    const contents = files.map(entry => fs.readFileSync(path.join(userData, entry.name), 'utf-8'))
    return baseIds.filter(baseId => contents.some(content => content.includes(baseId)))
  }

  test('a repository without docrepo.json starts empty', () => {
    expect(newRepo().list('workspace')).toEqual([])
  })

  test('stress: 50 bases with documents survive a reload', async () => {
    const docrepo = newRepo()
    const ids: string[] = []
    for (let i = 0; i < 50; i++) ids.push(await createBase(docrepo, `base ${String(i).padStart(2, '0')}`))
    for (let i = 0; i < 20; i++) await docrepo.addDocumentSource(ids[i], 'file', writeDoc(`doc${i}.txt`), true)
    await settled(docrepo)
    const reloaded = newRepo()
    expect(reloaded.list('workspace').map(base => base.uuid)).toEqual(ids)
    expect(reloaded.list('workspace').map(base => base.documents.length)).toEqual(ids.map((_, i) => i < 20 ? 1 : 0))
    await reloaded.updateDocBase(ids[49], 'renamed')
    expect(newRepo().list('workspace').map(base => base.uuid).sort()).toEqual([...ids].sort())
  })

  test('a docrepo.json truncated by a crash is not overwritten with an empty list', async () => {
    // load() swallows the parse error and starts empty, the next save() replaces the file
    const first = newRepo()
    const alpha = await createBase(first, 'Alpha')
    await createBase(first, 'Beta')
    const json = fs.readFileSync(docrepoFile(), 'utf-8')
    fs.writeFileSync(docrepoFile(), json.slice(0, Math.floor(json.length * 0.6)))
    expect(recoverable([alpha])).toEqual([alpha])
    const second = newRepo()
    await createBase(second, 'Gamma')
    expect(recoverable([alpha])).toEqual([alpha])
  })

  test('one malformed entry in docrepo.json does not make the following bases disappear', async () => {
    // loading stops at the first entry that throws, and the next save() only writes what was loaded before it
    const first = newRepo()
    const alpha = await createBase(first, 'Alpha')
    const beta = await createBase(first, 'Beta')
    const entries = JSON.parse(fs.readFileSync(docrepoFile(), 'utf-8'))
    fs.writeFileSync(docrepoFile(), JSON.stringify([entries[0], { uuid: 'broken', name: 'Broken' }, entries[1]]))
    const second = newRepo()
    await createBase(second, 'Gamma')
    expect(recoverable([alpha, beta])).toEqual([alpha, beta])
  })

})
