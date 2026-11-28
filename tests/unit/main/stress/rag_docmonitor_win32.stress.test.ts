
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import DocumentMonitor from '@main/rag/docmonitor'
import DocumentSourceImpl from '@main/rag/docsource'
import { bug } from './bug'

// the monitor is run with the Windows flavour of `path` so its drive handling can be checked on any host
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { ...actual.win32, default: actual.win32 }
})

vi.mock('electron', async () => {
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
    app: {
      getPath: vi.fn(() => 'C:\\Users\\me\\AppData\\Roaming\\Witsy'),
    },
  }
})

// chokidar double: like chokidar on Windows it reports backslash paths and only for the watched tree
type FakeWatcher = {
  root: string
  options: { depth?: number }
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

const isUnder = (root: string, path: string) => path.toLowerCase().startsWith(root.toLowerCase() + '\\')

const emit = (event: 'add' | 'change' | 'unlink' | 'unlinkDir', path: string): number => {
  const targets = watchers.filter(watcher => !watcher.closed && (path === watcher.root || (watcher.options.depth !== 0 && isUnder(watcher.root, path))))
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
  source.items = children.map((child, index) => new DocumentSourceImpl(`${uuid}-child-${index}`, 'file', `${origin}\\${child}`))
  return source
}

let monitor: DocumentMonitor

const start = (...bases: ReturnType<typeof docBase>[]) => {
  docRepo.contents = bases
  monitor = new DocumentMonitor(app, docRepo as any)
  monitor.start()
  return monitor
}

const settle = () => vi.advanceTimersByTimeAsync(5000)

const parentsOfAddedChildren = () => docRepo.addChildDocumentSource.mock.calls.map(call => call[1]).sort()
const removedSources = () => docRepo.removeDocumentSource.mock.calls.map(call => call[1]).sort()

beforeEach(() => {
  watchers.length = 0
  vi.clearAllMocks()
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

describe('DocumentMonitor on Windows: one drive', () => {

  test('the monitor runs with win32 path semantics', () => {
    const source = folder('docs', 'C:\\Docs')
    expect(source.filename).toBe('Docs')
    start(docBase('base', [source]))
    expect(watchers.map(watcher => watcher.root)).toEqual(['C:\\Docs'])
  })

  test('a new file is indexed in the folder that contains it and not in its siblings', async () => {
    start(docBase('base', [folder('docs', 'C:\\Docs'), folder('docs2', 'C:\\Docs2'), folder('other', 'C:\\Other')]))
    emit('add', 'C:\\Docs\\sub\\new.txt')
    await settle()
    expect(docRepo.addChildDocumentSource).toHaveBeenCalledTimes(1)
    expect(docRepo.addChildDocumentSource).toHaveBeenCalledWith('base', 'docs', 'file', 'C:\\Docs\\sub\\new.txt', false)
  })

  test('deleting the watched folder removes that source only', async () => {
    start(docBase('base', [folder('docs', 'C:\\Docs'), folder('docs2', 'C:\\Docs2'), folder('nested', 'C:\\Docs\\Nested')]))
    emit('unlinkDir', 'C:\\Docs2')
    await settle()
    expect(removedSources()).toEqual(['docs2'])
  })

  test('deleting a sub directory of a watched folder removes no source', async () => {
    start(docBase('base', [folder('docs', 'C:\\Docs', ['old\\a.txt']), folder('docs2', 'C:\\Docs2')]))
    emit('unlinkDir', 'C:\\Docs\\old')
    await settle()
    expect(removedSources()).toEqual([])
  })

  test('deleting a directory removes the folder sources located inside it', async () => {
    start(docBase('base', [folder('docs', 'C:\\Docs'), folder('nested', 'C:\\Docs\\Projects\\Nested'), folder('other', 'C:\\Other')]))
    emit('unlinkDir', 'C:\\Docs\\Projects')
    await settle()
    expect(removedSources()).toEqual(['nested'])
  })

  test('fuzz: with every source on the same drive a file is attributed to exactly the folders that contain it', async () => {
    const rand = mulberry32(7)
    const origins = ['C:\\Data', 'C:\\Data\\Docs', 'C:\\Data\\Docs2', 'C:\\Data\\Docs\\Sub', 'C:\\Other\\Docs', 'C:\\Data-Backup']
    const sources = origins.map((origin, index) => folder(`folder${index}`, origin))
    start(docBase('one', sources.slice(0, 3)), docBase('two', sources.slice(3)))
    const segments = ['Docs', 'Docs2', 'Sub', 'Data', 'Other', 'x', 'Docs.bak']
    for (let i = 0; i < 200; i++) {
      let path = rand() < 0.8 ? 'C:\\Data' : rand() < 0.5 ? 'C:\\Other' : 'C:\\Data-Backup'
      const depth = 1 + Math.floor(rand() * 4)
      for (let j = 0; j < depth; j++) path += '\\' + segments[Math.floor(rand() * segments.length)]
      path += `\\file${i}.txt`
      docRepo.addChildDocumentSource.mockClear()
      emit('add', path)
      await settle()
      const expected = sources.filter(source => isUnder(source.origin, path)).map(source => source.uuid)
      expect(parentsOfAddedChildren(), path).toEqual(expected.sort())
    }
  })

})

describe('DocumentMonitor on Windows: several drives', () => {

  bug('deleting a sub directory on D: does not remove a folder source located on C:', async () => {
    // path.relative() across drives returns the absolute target, which passes the "does not start with .." test
    start(docBase('base', [folder('c-docs', 'C:\\Docs', ['a.txt', 'b.txt']), folder('d-notes', 'D:\\Notes', ['old\\x.txt'])]))
    emit('unlinkDir', 'D:\\Notes\\old')
    await settle()
    expect(removedSources()).toEqual([])
  })

  bug('deleting a sub directory on D: does not remove folder sources of other bases', async () => {
    // same defect: every folder source of every base that lives on another drive is "inside" the deleted directory
    start(
      docBase('work', [folder('c-work', 'C:\\Work')]),
      docBase('private', [folder('e-private', 'E:\\Private')]),
      docBase('notes', [folder('d-notes', 'D:\\Notes')]),
    )
    emit('unlinkDir', 'D:\\Notes\\archive\\2025')
    await settle()
    expect(removedSources()).toEqual([])
  })

  bug('a file created on D: is only indexed in the folder source that contains it', async () => {
    // the relative path from C:\Docs to D:\Notes\new.txt is "D:\Notes\new.txt", so C:\Docs is considered a parent
    start(docBase('base', [folder('c-docs', 'C:\\Docs'), folder('d-notes', 'D:\\Notes')]))
    emit('add', 'D:\\Notes\\new.txt')
    await settle()
    expect(parentsOfAddedChildren()).toEqual(['d-notes'])
  })

  bug('a file created on D: is not indexed into a base that only has sources on C:', async () => {
    // same defect, here it copies a document of one base (possibly of another workspace) into another one
    start(docBase('private', [folder('d-private', 'D:\\Private')]), docBase('shared', [folder('c-shared', 'C:\\Shared')]))
    emit('add', 'D:\\Private\\salary.txt')
    await settle()
    expect(docRepo.addChildDocumentSource.mock.calls.map(call => call[0])).toEqual(['private'])
  })

  bug('a file created on a network share is only indexed in the folder source that contains it', async () => {
    // UNC paths have no relative path to a drive letter path either
    start(docBase('base', [folder('c-docs', 'C:\\Docs'), folder('share', '\\\\server\\share\\notes')]))
    emit('add', '\\\\server\\share\\notes\\new.txt')
    await settle()
    expect(parentsOfAddedChildren()).toEqual(['share'])
  })

  bug('fuzz: with sources spread over several drives a file is attributed to exactly the folders that contain it', async () => {
    // fails for every file whose drive differs from the drive of at least one folder source
    const rand = mulberry32(20261127)
    const drives = ['C:', 'D:', 'E:', '\\\\nas\\media']
    const sources = drives.flatMap((drive, index) => [folder(`docs${index}`, `${drive}\\Docs`), folder(`work${index}`, `${drive}\\Work\\Current`)])
    start(docBase('one', sources.filter((_, index) => index % 2 === 0)), docBase('two', sources.filter((_, index) => index % 2 === 1)))
    const segments = ['Docs', 'Work', 'Current', 'Archive', 'x']
    const wrong: string[] = []
    for (let i = 0; i < 100; i++) {
      let path = drives[Math.floor(rand() * drives.length)]
      const depth = 1 + Math.floor(rand() * 3)
      for (let j = 0; j < depth; j++) path += '\\' + segments[Math.floor(rand() * segments.length)]
      path += `\\file${i}.txt`
      docRepo.addChildDocumentSource.mockClear()
      if (emit('add', path) === 0) continue
      await settle()
      const expected = sources.filter(source => isUnder(source.origin, path)).map(source => source.uuid).sort()
      const actual = parentsOfAddedChildren()
      if (JSON.stringify(actual) !== JSON.stringify(expected)) wrong.push(`${path} -> ${actual.join(',')} instead of ${expected.join(',')}`)
    }
    expect(wrong.slice(0, 3)).toEqual([])
  })

})
