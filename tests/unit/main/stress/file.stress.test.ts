
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as file from '@main/file'
import { bug, isPosix } from './bug'

let root: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn((name: string) => path.join(root, name)),
    },
    dialog: {
      showSaveDialogSync: vi.fn(),
      showOpenDialogSync: vi.fn(),
    },
  }
})

const base64 = (text: string) => Buffer.from(text).toString('base64')

const filesUnder = (dir: string): string[] => {
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(full))
    else result.push(full)
  }
  return result
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-stress-')))
  for (const dir of ['downloads', 'userData', 'documents']) fs.mkdirSync(path.join(root, dir))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('writeFileContents', () => {

  test('writes into the requested directory and returns a file url', () => {
    const url = file.writeFileContents(app, { contents: base64('hello'), properties: { filename: 'a.txt', directory: 'documents' } })
    expect(url).toBe(`file://${path.join(root, 'documents', 'a.txt')}`)
    expect(fs.readFileSync(path.join(root, 'documents', 'a.txt'), 'utf-8')).toBe('hello')
  })

  test('stress: 300 files with awkward names round trip', () => {
    const names = ['spaces in name.txt', 'ünïcödé.txt', 'emoji-✓.txt', 'dots...txt', 'UPPER.TXT', '#hash.txt', '100%.txt', 'semi;colon.txt', `quote'.txt`]
    for (let i = 0; i < 300; i++) {
      const filename = `${i}-${names[i % names.length]}`
      const url = file.writeFileContents(app, { contents: base64(`content ${i}`), properties: { filename, directory: 'documents' } })
      expect(fs.readFileSync(url.slice(7), 'utf-8')).toBe(`content ${i}`)
    }
    expect(fs.readdirSync(path.join(root, 'documents'))).toHaveLength(300)
  })

  bug.each([
    ['filename', { filename: path.join('..', 'outside.txt'), directory: 'downloads' }],
    ['subdir', { filename: 'outside.txt', directory: 'downloads', subdir: path.join('..', 'documents') }],
    ['workspace', { filename: 'outside.txt', directory: 'userData', workspace: path.join('..', '..', 'documents') }],
  ])('a %s with parent segments cannot write outside the target directory', (_, properties) => {
    // these values come from the renderer, which also renders remote and model generated content
    const url = file.writeFileContents(app, { contents: base64('x'), properties: properties as any })
    const target = path.join(root, properties.directory)
    const written = url ? path.resolve(url.slice(7)) : null
    expect(written === null || written.startsWith(target + path.sep)).toBe(true)
  })

  bug('a missing url and filename is reported as a failure instead of throwing', () => {
    expect(() => file.writeFileContents(app, { contents: base64('x'), properties: { directory: 'downloads' } })).not.toThrow()
  })

  bug('the default file name of an http url is its last path segment on every platform', () => {
    // the url is split on path.sep, which is a backslash on Windows
    const sep = path.sep
    let url: string
    try {
      Object.defineProperty(path, 'sep', { value: '\\', configurable: true, writable: true })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      url = file.writeFileContents(app, { contents: base64('x'), url: 'https://example.com/images/cat.png?size=large', properties: { directory: 'downloads' } })
    } finally {
      Object.defineProperty(path, 'sep', { value: sep, configurable: true, writable: true })
    }
    expect(url).toBe(`file://${path.join(root, 'downloads', 'cat.png')}`)
  })

})

describe('downloadFile', () => {

  test('saves the body of a successful response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('image-bytes', { status: 200 }))
    const url = await file.downloadFile(app, { url: 'https://example.com/a/cat.png?x=1', properties: { filename: 'cat.png', directory: 'downloads' } })
    expect(url).toBe(`file://${path.join(root, 'downloads', 'cat.png')}`)
    expect(fs.readFileSync(path.join(root, 'downloads', 'cat.png'), 'utf-8')).toBe('image-bytes')
  })

  test('a network error is reported as null and writes nothing', async () => {
    const url = await file.downloadFile(app, { url: 'https://example.com/cat.png', properties: { filename: 'cat.png', directory: 'downloads' } })
    expect(url).toBeNull()
    expect(filesUnder(root)).toEqual([])
  })

  bug.each([403, 404, 500, 503])('an HTTP %i error page is not saved as the downloaded file', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>error</html>', { status }))
    const url = await file.downloadFile(app, { url: 'https://example.com/cat.png', properties: { filename: 'cat.png', directory: 'downloads' } })
    expect(url).toBeNull()
    expect(filesUnder(root)).toEqual([])
  })

  bug('a local file can be copied without giving a file name', async () => {
    // url is reset to null before the name is derived from it
    const source = path.join(root, 'documents', 'source.png')
    fs.writeFileSync(source, 'image-bytes')
    const url = await file.downloadFile(app, { url: `file://${source}`, properties: { directory: 'downloads' } })
    expect(url).toBe(`file://${path.join(root, 'downloads', 'source.png')}`)
  })

})

describe('findProgram', () => {

  test('returns null for a program that does not exist', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(file.findProgram(app, 'witsy-no-such-program-xyz')).toBeNull()
  })

  bug.runIf(isPosix)('the program name is not interpreted by a shell', () => {
    // the name is interpolated into an execSync command line; the renderer passes what the user typed
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = path.join(root, 'injected')
    file.findProgram(app, `witsy-no-such-program-xyz; touch "${marker}"`)
    expect(fs.existsSync(marker)).toBe(false)
  })

})

describe.runIf(isPosix)('listFilesRecursively', () => {

  test('stress: lists every file of a 3 level tree once', () => {
    let expected = 0
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
      const dir = path.join(root, 'documents', `a${a}`, `b${b}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let c = 0; c < 6; c++) {
        fs.writeFileSync(path.join(dir, `f${c}.txt`), '')
        expected++
      }
    }
    const files = file.listFilesRecursively(path.join(root, 'documents'))
    expect(files).toHaveLength(expected)
    expect(new Set(files).size).toBe(expected)
  })

  bug('a symbolic link to a parent directory does not make files appear more than once', () => {
    // statSync follows links and nothing remembers visited directories: recursion only ends at ELOOP
    const docs = path.join(root, 'documents')
    fs.writeFileSync(path.join(docs, 'a.txt'), '')
    fs.mkdirSync(path.join(docs, 'sub'))
    fs.writeFileSync(path.join(docs, 'sub', 'b.txt'), '')
    fs.symlinkSync(docs, path.join(docs, 'sub', 'loop'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const files = file.listFilesRecursively(docs)
    expect(files).toHaveLength(2)
  })

  bug('a broken symbolic link does not hide the other files of its directory', () => {
    // the statSync error aborts the loop over the directory
    const docs = path.join(root, 'documents')
    fs.symlinkSync(path.join(docs, 'missing'), path.join(docs, 'a-broken-link'))
    fs.writeFileSync(path.join(docs, 'b.txt'), '')
    fs.writeFileSync(path.join(docs, 'c.txt'), '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const files = file.listFilesRecursively(docs).map(f => path.basename(f))
    expect(files).toEqual(expect.arrayContaining(['b.txt', 'c.txt']))
  })

})

describe('searchContent', () => {

  const makeTree = () => {
    const docs = path.join(root, 'documents')
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(docs, `file${i}.txt`), Array.from({ length: 50 }, (_, l) => l % 5 === 0 ? `needle ${i} ${l}` : `hay ${l}`).join('\n'))
    }
    return docs
  }

  test('fuzz: invalid or odd patterns never throw', () => {
    const docs = makeTree()
    for (const pattern of ['(', '[', '*', '\\', '(?<', 'a{2,1}', '', '.', '^$', '\u0000', 'needle|', '(?i)needle']) {
      const result = file.searchContent(docs, pattern, { maxResults: 5 })
      expect(Array.isArray(result.matches)).toBe(true)
    }
  })

  test('maxResults caps the number of matches without context', () => {
    const docs = makeTree()
    for (const maxResults of [1, 3, 10, 50]) {
      const result = file.searchContent(docs, 'needle', { maxResults })
      expect(result.matches).toHaveLength(maxResults)
      expect(result.truncated).toBe(true)
    }
  })

  bug('maxResults caps the number of matching lines when context lines are requested', () => {
    // context lines are counted as results
    const docs = makeTree()
    const result = file.searchContent(docs, 'needle', { maxResults: 10, contextLines: 2 })
    expect(result.matches.filter(m => m.isMatch)).toHaveLength(10)
  })

  bug('a search path that does not exist returns no matches instead of throwing', () => {
    expect(() => file.searchContent(path.join(root, 'missing'), 'needle')).not.toThrow()
  })

  bug('more than 1000 files are searched, or the result says it is incomplete', () => {
    const docs = path.join(root, 'documents')
    for (let i = 0; i < 1010; i++) fs.writeFileSync(path.join(docs, `f${i}.txt`), 'needle')
    const result = file.searchContent(docs, 'needle', { maxResults: 5000 })
    expect(result.matches.length === 1010 || result.truncated).toBe(true)
  })

})

describe('findFiles', () => {

  test('fuzz: never returns more than maxResults and never returns hidden files', async () => {
    const docs = path.join(root, 'documents')
    for (let a = 0; a < 5; a++) {
      fs.mkdirSync(path.join(docs, `d${a}`, '.hidden'), { recursive: true })
      fs.mkdirSync(path.join(docs, `d${a}`, 'node_modules'), { recursive: true })
      for (let f = 0; f < 10; f++) {
        fs.writeFileSync(path.join(docs, `d${a}`, `f${f}.md`), '')
        fs.writeFileSync(path.join(docs, `d${a}`, '.hidden', `h${f}.md`), '')
        fs.writeFileSync(path.join(docs, `d${a}`, 'node_modules', `n${f}.md`), '')
      }
    }
    for (const maxResults of [1, 2, 7, 49, 50, 51, 1000]) {
      const results = await file.findFiles(app, docs, '*.md', maxResults)
      expect(results).toHaveLength(Math.min(maxResults, 50))
      expect(results.some(r => r.includes('.hidden') || r.includes('node_modules'))).toBe(false)
    }
  })

  test('garbage patterns do not throw', async () => {
    const docs = path.join(root, 'documents')
    fs.writeFileSync(path.join(docs, 'a.md'), '')
    for (const pattern of ['', '[', '{', '**/**/**', '!(*.md)', '\\', '*'.repeat(50)]) {
      await expect(file.findFiles(app, docs, pattern)).resolves.toBeInstanceOf(Array)
    }
  })

})

describe('normalizePath', () => {

  test('always returns an absolute path', () => {
    for (const input of ['~', '~/a', 'a', './a', '../a', 'a/../../b', '/abs/path', '', ' ', 'a b/c', '~user/a']) {
      expect(path.isAbsolute(file.normalizePath(app, input)), input).toBe(true)
    }
  })

})
