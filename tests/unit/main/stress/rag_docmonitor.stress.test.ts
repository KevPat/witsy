
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import DocumentMonitor from '@main/rag/docmonitor'
import DocumentSourceImpl from '@main/rag/docsource'
import defaultSettings from '@root/defaults/settings.json'
import { loadSettings } from '@main/config'

vi.mock('electron', async () => {
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
    app: {
      getPath: vi.fn(() => '/userData'),
    },
  }
})

// a fix for the exclude patterns will need the settings
vi.mock('@main/config', async () => {
  return {
    loadSettings: vi.fn(() => JSON.parse(JSON.stringify(defaultSettings))),
  }
})

// chokidar double: it applies the `ignored` and `depth` options like chokidar 4 does,
// so a test only receives the events the real watcher would deliver
type Matcher = string | RegExp | ((path: string) => boolean)
type FakeWatcher = {
  root: string
  options: { ignored?: Matcher | Matcher[], depth?: number }
  handlers: Record<string, (path: string) => void>
  closed: boolean
  on: (event: string, handler: (path: string) => void) => FakeWatcher
  close: () => Promise<void>
}

const watchers: FakeWatcher[] = []

vi.mock('chokidar', () => ({
  watch: vi.fn((root: string, options: FakeWatcher['options']) => {
    const watcher: FakeWatcher = {
      root, options, handlers: {}, closed: false,
      on(event, handler) { watcher.handlers[event] = handler; return watcher },
      close() { watcher.closed = true; return Promise.resolve() },
    }
    watchers.push(watcher)
    return watcher
  }),
}))

const ignores = (watcher: FakeWatcher, path: string): boolean => {
  const matchers = [watcher.options.ignored ?? []].flat()
  return matchers.some(matcher => {
    if (typeof matcher === 'function') return matcher(path)
    if (typeof matcher === 'string') return matcher === path
    return matcher.test(path)
  })
}

const delivers = (watcher: FakeWatcher, path: string): boolean => {
  if (watcher.closed) return false
  if (ignores(watcher, watcher.root) || ignores(watcher, path)) return false
  if (path === watcher.root) return true
  return watcher.options.depth !== 0 && path.startsWith(watcher.root + '/')
}

// what the file system would report: every open watcher that covers the path fires
const emit = (event: 'add' | 'change' | 'unlink' | 'unlinkDir', path: string): number => {
  const targets = watchers.filter(watcher => delivers(watcher, path))
  for (const watcher of targets) watcher.handlers[event]?.(path)
  return targets.length
}

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const docRepo = {
  contents: [] as any[],
  queue: [] as any[],
  isSourceSupported: vi.fn((): boolean => true),
  addDocumentSource: vi.fn().mockResolvedValue('task'),
  addChildDocumentSource: vi.fn().mockResolvedValue('task'),
  removeDocumentSource: vi.fn().mockResolvedValue(undefined),
  removeChildDocumentSource: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}

const docBase = (uuid: string, documents: DocumentSourceImpl[]) => ({ uuid, name: uuid, documents })

const folder = (uuid: string, origin: string, children: string[] = []) => {
  const source = new DocumentSourceImpl(uuid, 'folder', origin)
  source.items = children.map((child, index) => new DocumentSourceImpl(`${uuid}-child-${index}`, 'file', `${origin}/${child}`))
  return source
}

let monitor: DocumentMonitor

const start = (...bases: ReturnType<typeof docBase>[]) => {
  docRepo.contents = bases
  monitor = new DocumentMonitor(app, docRepo as any)
  monitor.start()
  return monitor
}

// lets every debounce timer fire and the async handlers settle
const settle = () => vi.advanceTimersByTimeAsync(5000)

const addedChildren = () => docRepo.addChildDocumentSource.mock.calls.map(call => call[3])

beforeEach(() => {
  watchers.length = 0
  docRepo.queue = []
  vi.clearAllMocks()
  vi.mocked(loadSettings).mockImplementation(() => JSON.parse(JSON.stringify(defaultSettings)))
  vi.useFakeTimers()
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  monitor?.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DocumentMonitor debounce', () => {

  test('a new file reported once is indexed once as a child of its folder', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    emit('add', '/path/to/folder/new.txt')
    await settle()
    expect(docRepo.addChildDocumentSource).toHaveBeenCalledTimes(1)
    expect(docRepo.addChildDocumentSource).toHaveBeenCalledWith('base', 'folder', 'file', '/path/to/folder/new.txt', false)
  })

  test('a file that is created and then written to is still indexed', async () => {
    // the pending add is replaced by the change, and a change on an untracked file is a no-op
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    emit('add', '/path/to/folder/new.txt')
    await vi.advanceTimersByTimeAsync(150)
    emit('change', '/path/to/folder/new.txt')
    await vi.advanceTimersByTimeAsync(150)
    emit('change', '/path/to/folder/new.txt')
    await settle()
    expect(addedChildren()).toEqual(['/path/to/folder/new.txt'])
  })

  test('fuzz: every new file ends up indexed whatever the number of writes that follow its creation', async () => {
    // same defect: only the files that got no change event within the debounce window are indexed
    const rand = mulberry32(20261127)
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    const created: string[] = []
    for (let i = 0; i < 100; i++) {
      const path = `/path/to/folder/sub${i % 7}/file${i}.md`
      created.push(path)
      emit('add', path)
      const writes = Math.floor(rand() * 4)
      for (let j = 0; j < writes; j++) {
        await vi.advanceTimersByTimeAsync(Math.floor(rand() * 300))
        emit('change', path)
      }
    }
    await settle()
    expect(created.filter(path => !addedChildren().includes(path))).toEqual([])
  })

  test('a write to a file that is already waiting to be indexed does not queue it again', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    docRepo.queue = [{ operation: 'add', baseId: 'base', parentDocId: 'folder', origin: '/path/to/folder/new.txt' }]
    emit('change', '/path/to/folder/new.txt')
    await settle()
    expect(docRepo.addChildDocumentSource).not.toHaveBeenCalled()
  })

  test('a write to a file of a type that cannot be indexed is ignored', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    docRepo.isSourceSupported.mockReturnValue(false)
    emit('change', '/path/to/folder/archive.bin')
    await settle()
    expect(docRepo.isSourceSupported).toHaveBeenCalledWith('file', '/path/to/folder/archive.bin')
    expect(docRepo.addChildDocumentSource).not.toHaveBeenCalled()
    docRepo.isSourceSupported.mockReturnValue(true)
  })

  test('a burst of changes on a tracked child re-indexes it once', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder', ['a.txt'])]))
    for (let i = 0; i < 50; i++) {
      emit('change', '/path/to/folder/a.txt')
      await vi.advanceTimersByTimeAsync(100)
    }
    await settle()
    expect(addedChildren()).toEqual(['/path/to/folder/a.txt'])
  })

  test('a file that is created and deleted right away is not indexed', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    emit('add', '/path/to/folder/tmp.txt')
    await vi.advanceTimersByTimeAsync(200)
    emit('unlink', '/path/to/folder/tmp.txt')
    await settle()
    expect(docRepo.addChildDocumentSource).not.toHaveBeenCalled()
    expect(docRepo.removeChildDocumentSource).not.toHaveBeenCalled()
  })

  test('a tracked child that is replaced (unlink then add) is re-indexed and not removed', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder', ['a.txt'])]))
    emit('unlink', '/path/to/folder/a.txt')
    await vi.advanceTimersByTimeAsync(50)
    emit('add', '/path/to/folder/a.txt')
    await settle()
    expect(addedChildren()).toEqual(['/path/to/folder/a.txt'])
    expect(docRepo.removeChildDocumentSource).not.toHaveBeenCalled()
  })

  test('stress: an event storm is reduced to one action per file, decided by its last event', async () => {
    const rand = mulberry32(42)
    const children = Array.from({ length: 40 }, (_, i) => `tracked${i}.txt`)
    const source = folder('folder', '/path/to/folder', children)
    start(docBase('base', [source]))
    const tracked = new Map(source.items.map(item => [item.origin, item.uuid]))
    const last = new Map<string, string>()
    const events = ['add', 'change', 'unlink'] as const
    for (let i = 0; i < 2000; i++) {
      const path = `/path/to/folder/${rand() < 0.5 ? children[Math.floor(rand() * children.length)] : `new${Math.floor(rand() * 40)}.txt`}`
      const event = events[Math.floor(rand() * events.length)]
      last.set(path, event)
      emit(event, path)
    }
    expect(monitor.pendingOperations.size).toBe(last.size)
    await settle()
    expect(monitor.pendingOperations.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    // a write to a file the folder does not have yet indexes it: its creation may have been replaced by that write
    const expectedAdds = [...last].filter(([, event]) => event === 'add' || event === 'change').map(([path]) => path)
    const expectedRemovals = [...last].filter(([path, event]) => event === 'unlink' && tracked.has(path)).map(([path]) => tracked.get(path))
    expect(addedChildren().sort()).toEqual(expectedAdds.sort())
    expect(docRepo.removeChildDocumentSource.mock.calls.map(call => call[1]).sort()).toEqual(expectedRemovals.sort())
  })

  test('stop() cancels every pending operation', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    for (let i = 0; i < 100; i++) emit('add', `/path/to/folder/new${i}.txt`)
    expect(monitor.pendingOperations.size).toBe(100)
    monitor.stop()
    expect(vi.getTimerCount()).toBe(0)
    await settle()
    expect(docRepo.addChildDocumentSource).not.toHaveBeenCalled()
    expect(watchers.every(watcher => watcher.closed)).toBe(true)
  })

})

describe('DocumentMonitor watcher scope', () => {

  test('files in regular sub directories are indexed', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    expect(emit('add', '/path/to/folder/a/b/c/deep.md')).toBe(1)
    await settle()
    expect(addedChildren()).toEqual(['/path/to/folder/a/b/c/deep.md'])
  })

  test.each(['.hidden', '.git/config', 'sub/.env', 'sub/.cache/data.json'])('dot file %s inside a watched folder is not indexed', async (name) => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    expect(emit('add', `/path/to/folder/${name}`)).toBe(0)
    await settle()
    expect(docRepo.addChildDocumentSource).not.toHaveBeenCalled()
  })

  test.each(['/home/me/.notes/kb', '/Users/me/.config/witsy docs', '/srv/.snapshots/2026/docs'])('a folder located at %s still gets its new files indexed', async (origin) => {
    // the dot file pattern is tested against the whole path, so it matches the watched root itself
    start(docBase('base', [folder('folder', origin)]))
    emit('add', `${origin}/new.txt`)
    await settle()
    expect(addedChildren()).toEqual([`${origin}/new.txt`])
  })

  test('a single file located under a dot directory is re-indexed when it changes', async () => {
    // same pattern: the watcher of /home/me/.notes/todo.md ignores its own root
    start(docBase('base', [new DocumentSourceImpl('file', 'file', '/home/me/.notes/todo.md')]))
    emit('change', '/home/me/.notes/todo.md')
    await settle()
    expect(docRepo.addDocumentSource).toHaveBeenCalledWith('base', 'file', '/home/me/.notes/todo.md', false)
  })

  test.each(defaultSettings.rag.excludePatterns.split(',').filter(pattern => !pattern.startsWith('.')))('a new file under an excluded "%s" directory is not indexed', async (excluded) => {
    // rag.excludePatterns is applied when a folder is listed but never by the watcher
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    emit('add', `/path/to/folder/project/${excluded}/pkg/readme.md`)
    await settle()
    expect(addedChildren()).toEqual([])
  })

  test('the exclude patterns of the settings are used', async () => {
    vi.mocked(loadSettings).mockReturnValue({ rag: { excludePatterns: 'drafts, *.tmp' } } as any)
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    expect(emit('add', '/path/to/folder/drafts/a.md')).toBe(0)
    expect(emit('add', '/path/to/folder/sub/b.tmp')).toBe(0)
    expect(emit('add', '/path/to/folder/node_modules/c.md')).toBe(1)
    await settle()
    expect(addedChildren()).toEqual(['/path/to/folder/node_modules/c.md'])
  })

  test('a folder is still watched when the settings cannot be read', async () => {
    vi.mocked(loadSettings).mockImplementation(() => { throw new Error('unreadable') })
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    expect(emit('add', '/path/to/folder/node_modules/c.md')).toBe(0)
    expect(emit('add', '/path/to/folder/a.md')).toBe(1)
    await settle()
    expect(addedChildren()).toEqual(['/path/to/folder/a.md'])
  })

  test('a change of a file that was excluded after its folder was added is not indexed', async () => {
    start(docBase('base', [folder('folder', '/path/to/folder')]))
    vi.mocked(loadSettings).mockReturnValue({ rag: { excludePatterns: 'private' } } as any)
    watchers[0].handlers.add('/path/to/folder/private/a.md')
    watchers[0].handlers.change('/path/to/folder/private/b.md')
    await settle()
    expect(docRepo.addChildDocumentSource).not.toHaveBeenCalled()
  })

  test('fuzz: a new file is attributed to exactly the folders that contain it', async () => {
    const rand = mulberry32(7)
    const origins = ['/data', '/data/docs', '/data/docs2', '/data/docs/sub', '/data/docs/sub space', '/other/docs', '/data-backup']
    const sources = origins.map((origin, index) => folder(`folder${index}`, origin))
    start(docBase('one', sources.slice(0, 4)), docBase('two', sources.slice(4)))
    const segments = ['docs', 'docs2', 'sub', 'sub space', 'data', 'other', 'x', 'docs.bak', 'data-backup']
    for (let i = 0; i < 300; i++) {
      const depth = 1 + Math.floor(rand() * 4)
      let path = rand() < 0.8 ? '/data' : rand() < 0.5 ? '/other' : '/data-backup'
      for (let j = 0; j < depth; j++) path += '/' + segments[Math.floor(rand() * segments.length)]
      path += `/file${i}.txt`
      docRepo.addChildDocumentSource.mockClear()
      emit('add', path)
      await settle()
      const expected = sources.filter(source => path.startsWith(source.origin + '/')).map(source => source.uuid)
      expect(docRepo.addChildDocumentSource.mock.calls.map(call => call[1]).sort(), path).toEqual(expected.sort())
    }
  })

})

describe('DocumentMonitor watcher lifecycle', () => {

  test('one watcher is created per file or folder source and none for web sources', () => {
    start(docBase('base', [
      folder('folder', '/path/to/folder', ['a.txt', 'b.txt']),
      new DocumentSourceImpl('file', 'file', '/path/to/file.txt'),
      new DocumentSourceImpl('url', 'url', 'https://example.com'),
      new DocumentSourceImpl('sitemap', 'sitemap', 'https://example.com/sitemap.xml'),
      new DocumentSourceImpl('text', 'text', 'some text'),
    ]))
    expect(watchers.map(watcher => watcher.root).sort()).toEqual(['/path/to/file.txt', '/path/to/folder'])
  })

  test('stress: 500 sources added and removed leave no open watcher', () => {
    start()
    const sources = Array.from({ length: 500 }, (_, i) => new DocumentSourceImpl(`doc${i}`, i % 2 ? 'file' : 'folder', `/library/item${i}`))
    for (const source of sources) monitor.onDocumentSourceAdded(source)
    for (const source of sources) monitor.onDocumentSourceAdded(source)
    expect(watchers).toHaveLength(500)
    expect(monitor.watchers.size).toBe(500)
    for (const source of sources) monitor.onDocumentSourceRemoved(source.origin)
    expect(monitor.watchers.size).toBe(0)
    expect(watchers.every(watcher => watcher.closed)).toBe(true)
  })

  test('indexing a child of a watched folder does not create a watcher for that child', () => {
    // the repository notifies every indexed document, and the monitor watches any file it is told about
    const source = folder('folder', '/path/to/folder', ['a.txt'])
    start(docBase('base', [source]))
    monitor.onDocumentSourceAdded(source.items[0])
    expect(watchers.map(watcher => watcher.root)).toEqual(['/path/to/folder'])
  })

  test('removing a folder leaves no watcher behind for the children indexed while it was watched', () => {
    // the per child watchers are only closed when each child is removed one by one
    const source = folder('folder', '/path/to/folder')
    const base = docBase('base', [source])
    start(base)
    for (let i = 0; i < 20; i++) {
      const child = new DocumentSourceImpl(`child${i}`, 'file', `/path/to/folder/new${i}.txt`)
      source.items.push(child)
      monitor.onDocumentSourceAdded(child)
    }
    base.documents = []
    monitor.onDocumentSourceRemoved(source.origin)
    expect(watchers.filter(watcher => !watcher.closed).map(watcher => watcher.root)).toEqual([])
  })

  test('the watchers of a base that is deleted are closed once the base is gone', async () => {
    // the repository notifies the removal of each source before it drops the base
    const base = docBase('A', [folder('folderA', '/path/to/folder'), new DocumentSourceImpl('file', 'file', '/path/to/file.txt')])
    start(base)
    monitor.onDocumentSourceRemoved('/path/to/folder')
    monitor.onDocumentSourceRemoved('/path/to/file.txt')
    expect(watchers.filter(watcher => !watcher.closed)).toHaveLength(2)
    docRepo.contents = []
    await settle()
    expect(watchers.filter(watcher => !watcher.closed)).toHaveLength(0)
    expect(monitor.watchers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('stop() cancels the pending check of the watchers', () => {
    start(docBase('A', [folder('folderA', '/path/to/folder')]))
    monitor.onDocumentSourceRemoved('/path/to/folder')
    expect(vi.getTimerCount()).toBe(1)
    monitor.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(watchers.every(watcher => watcher.closed)).toBe(true)
  })

  test('removing a source from one base keeps the watcher that another base relies on', async () => {
    // watchers are keyed by path only, so the removal notification closes the watcher shared by both bases
    const baseA = docBase('A', [folder('folderA', '/shared/folder')])
    const baseB = docBase('B', [folder('folderB', '/shared/folder')])
    start(baseA, baseB)
    baseA.documents = []
    monitor.onDocumentSourceRemoved('/shared/folder')
    emit('add', '/shared/folder/new.txt')
    await settle()
    expect(docRepo.addChildDocumentSource.mock.calls.map(call => call.slice(0, 2))).toEqual([['B', 'folderB']])
  })

})
