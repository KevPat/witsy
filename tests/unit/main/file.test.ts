
import { vi, expect, test, describe, beforeEach, afterEach } from 'vitest'
import * as file from '@main/file'
import { app, dialog } from 'electron'
import * as childProcess from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const mocked = {
    ...actual,
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  }
  return { ...mocked, default: mocked }
})

vi.mock('electron', async() => {
  return {
    app: {
      getPath: vi.fn(() => os.tmpdir())
    },
    dialog: {
      showSaveDialogSync: vi.fn(),
      showOpenDialogSync: vi.fn((opts) => {
        if (opts.filters?.includes('error')) {
          throw new Error('Error')
        } else if (opts.properties.includes('openDirectory')) {
          return ['file://pickeddir']
        } else if (opts.properties.includes('multiSelections')) { 
          return ['file://picked1.txt', 'file://picked2.txt']
        } else {
          return ['file://picked.txt']
        }
      })
    },
    BrowserWindow: {
      getFocusedWindow: () => {
        return {
          webContents: {
            session: {
            }
          }
        }
      }
    }
  }
})

test('Find program', async () => {
  if (process.platform == 'win32') {
    expect(file.findProgram(app, 'notepad.exe')).toMatch(/^.*notepad.exe$/)
    expect(file.findProgram(app, 'textedit.exe')).toBeNull()
  } else {
    expect(file.findProgram(app, 'sh')).toMatch(/^.*\/sh$/)
    expect(file.findProgram(app, 'sh2')).toBeNull()
  }
})

test('Find program runs the lookup tool without a shell', async () => {
  vi.mocked(childProcess.execFileSync).mockClear()
  const program = process.platform == 'win32' ? 'cmd.exe' : 'sh'
  expect(file.findProgram(app, program)).toBeTruthy()
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
  const [tool, args, options] = vi.mocked(childProcess.execFileSync).mock.calls[0] as [string, string[], Record<string, unknown>]
  expect(tool).toBe(process.platform == 'win32' ? 'where' : 'which')
  expect(args).toStrictEqual([program])
  expect(options.shell).toBeFalsy()
  expect(options.timeout).toBeGreaterThan(0)
  expect(childProcess.execSync).not.toHaveBeenCalled()
  expect(childProcess.exec).not.toHaveBeenCalled()
})

test('Find program accepts usual program names', async () => {
  vi.mocked(childProcess.execFileSync).mockClear()
  vi.mocked(childProcess.execFileSync).mockImplementation(((tool: string, args: string[]) => `/usr/bin/${args[0]}\r\n/opt/bin/${args[0]}\n`) as any)
  try {
    for (const program of ['python3', 'python3.12', 'node', 'npx', 'uvx', 'g++', 'notepad.exe', 'docker-compose', 'x86_64-linux-gnu-gcc', '7z']) {
      expect(file.findProgram(app, program), program).toBe(`/usr/bin/${program}`)
    }
    vi.mocked(childProcess.execFileSync).mockImplementation((() => '\n') as any)
    expect(file.findProgram(app, 'python3')).toBeNull()
  } finally {
    const actual = await vi.importActual<typeof import('child_process')>('child_process')
    vi.mocked(childProcess.execFileSync).mockImplementation(actual.execFileSync as any)
  }
})

test('Find program refuses anything but a bare program name', async () => {
  const marker = path.join(os.tmpdir(), `witsy-find-program-${process.pid}`)
  fs.rmSync(marker, { force: true })
  for (const fn of [childProcess.exec, childProcess.execSync, childProcess.execFile, childProcess.execFileSync, childProcess.spawn, childProcess.spawnSync]) {
    vi.mocked(fn).mockClear()
  }
  const names: any[] = [
    `python3; touch ${marker}`,
    `sh; touch "${marker}"`,
    `sh && touch ${marker}`,
    `sh | touch ${marker}`,
    `sh > ${marker}`,
    '`id`',
    `\`touch ${marker}\``,
    '$(id)',
    `$(touch ${marker})`,
    'a b',
    ' sh',
    'sh ',
    'sh\t',
    '../x',
    '..',
    '.',
    './sh',
    '/bin/sh',
    'C:\\Windows\\System32\\cmd.exe',
    'bin\\sh',
    'python3\nrm',
    'python3\r\nrm',
    'sh\n',
    'sh\0',
    '"sh"',
    `'sh'`,
    'sh&',
    'sh*',
    'sh?',
    '$PATH',
    '$env:PATH:sh',
    '%COMSPEC%',
    '~',
    '-a',
    '--help',
    '/?',
    '',
    'a'.repeat(129),
    null,
    undefined,
    42,
    ['sh'],
    { toString: () => 'sh' },
  ]
  for (const name of names) {
    expect(file.findProgram(app, name), JSON.stringify(name)).toBeNull()
  }
  for (const fn of [childProcess.exec, childProcess.execSync, childProcess.execFile, childProcess.execFileSync, childProcess.spawn, childProcess.spawnSync]) {
    expect(fn).not.toHaveBeenCalled()
  }
  expect(fs.existsSync(marker)).toBe(false)
})

test('Get file contents', async () => {
  expect(file.getFileContents(app, './tests/fixtures/notfound.txt')).toBeNull()
  const contents = file.getFileContents(app, './tests/fixtures/sample.txt')
  const text = Buffer.from(contents!.contents, 'base64').toString()
  expect(contents).toStrictEqual({
    url: 'file://./tests/fixtures/sample.txt',
    mimeType: 'text/plain',
    contents: 'SGVsbG8gZnJvbSBURVhU',
  })
  expect(text).toBe('Hello from TEXT')
})

test('Delete file', async () => {
  expect(file.deleteFile('file://./tests/fixtures/notfound.txt')).toBeFalsy()
  const tempFile = path.join(os.tmpdir(), 'vitest')
  fs.writeFileSync(tempFile, 'Hello')
  expect(fs.existsSync(tempFile)).toBeTruthy()
  file.deleteFile(tempFile)
  expect(fs.existsSync(tempFile)).toBeFalsy()
})

test('Write file contents', async () => {
  const tempFile = path.join(os.tmpdir(), 'vitest')
  const fileURL = file.writeFileContents(app, {
    contents: 'SGVsbG8gZnJvbSBURVhU',
    properties: {
      filename: 'vitest',
      directory: 'temp',
    }
  })
  expect(fileURL).toBe(`file://${tempFile}`)
  expect(fs.existsSync(tempFile)).toBeTruthy()
  expect(fs.readFileSync(tempFile, 'utf8')).toBe('Hello from TEXT')
  file.deleteFile(`file://${tempFile}`)
  expect(fs.existsSync(tempFile)).toBeFalsy()
})

test('Download unfound file', async () => {
  const fileURL = await file.downloadFile(app, {
    url: 'file://./tests/fixtures/notfound.txt',
  })
  expect(fileURL).toBeNull()
})

test('Download local file', async () => {
  const tempFile = path.join(os.tmpdir(), 'vitest')
  const fileURL = await file.downloadFile(app, {
    url: 'file://./tests/fixtures/sample.txt',
    properties: {
      filename: 'vitest',
      directory: 'temp',
      prompt: false,
    }
  })
  expect(fileURL).toBe(`file://${tempFile}`)
  expect(fs.existsSync(tempFile)).toBeTruthy()
  expect(fs.readFileSync(tempFile, 'utf8')).toBe('Hello from TEXT')
  file.deleteFile(`file://${tempFile}`)
  expect(fs.existsSync(tempFile)).toBeFalsy()
})

test('Download remote file', async () => {
  const tempFile = path.join(os.tmpdir(), 'vitest')
  const fileURL = await file.downloadFile(app, {
    url: 'https://raw.githubusercontent.com/Kochava-Studios/witsy/main/tests/fixtures/sample.txt',
    properties: {
      filename: 'vitest',
      directory: 'temp',
      prompt: false,
    }
  })
  expect(fileURL).toBe(`file://${tempFile}`)
  expect(fs.existsSync(tempFile)).toBeTruthy()
  expect(fs.readFileSync(tempFile, 'utf8')).toBe('Hello from TEXT')
  file.deleteFile(`file://${tempFile}`)
  expect(fs.existsSync(tempFile)).toBeFalsy()
})

test('Pick file', async () => {
  expect(file.pickFile(app, { filters: [ { name: 'error', extensions: ['']} ] })).toBeNull()
  const fileURL = file.pickFile(app, { location: true })
  expect(dialog.showOpenDialogSync).toHaveBeenCalled()
  expect(fileURL).toBe('file://picked.txt')
})

test('Pick files', async () => {
  const fileURL = file.pickFile(app, { multiselection: true })
  expect(dialog.showOpenDialogSync).toHaveBeenCalled()
  expect(fileURL).toStrictEqual(['file://picked1.txt', 'file://picked2.txt'])
})

test('Pick directory', async () => {
  const fileURL = file.pickDirectory(app)
  expect(dialog.showOpenDialogSync).toHaveBeenCalled()
  expect(fileURL).toBe('file://pickeddir')
})

test('List files recursively', async () => {
  expect(file.listFilesRecursively('./notfound')).toStrictEqual([])
  const files = file.listFilesRecursively('./.github')

  expect(files).toEqual(expect.arrayContaining([
    '.github/workflows/build-darwin-arm64.yml',
    '.github/workflows/build-darwin-x64.yml',
    '.github/workflows/build-darwin.yml',
    '.github/workflows/build-linux-x64.yml',
    '.github/workflows/build-win32-arm64.yml',
    '.github/workflows/build-win32-x64.yml',
    '.github/workflows/test.yml',
  ].map(f => process.platform == 'win32' ? f.replace(/\//g, '\\') : f))
)})

test('List files recursively with exclude patterns', async () => {

  // create a temp directory structure
  const tempDir = path.join(os.tmpdir(), `test-exclude-${Date.now()}`)
  fs.mkdirSync(path.join(tempDir, '.git', 'objects'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, '.obsidian'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'node_modules', 'package'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, '__pycache__'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'src', 'components'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true })

  // create files in each directory
  fs.writeFileSync(path.join(tempDir, '.git', 'config'), 'git config')
  fs.writeFileSync(path.join(tempDir, '.git', 'objects', 'abc123'), 'object')
  fs.writeFileSync(path.join(tempDir, '.obsidian', 'config.json'), '{}')
  fs.writeFileSync(path.join(tempDir, 'node_modules', 'package', 'index.js'), 'module.exports = {}')
  fs.writeFileSync(path.join(tempDir, '__pycache__', 'module.pyc'), 'bytecode')
  fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export {}')
  fs.writeFileSync(path.join(tempDir, 'src', 'components', 'App.vue'), '<template></template>')
  fs.writeFileSync(path.join(tempDir, 'docs', 'readme.md'), '# README')
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{}')

  try {
    // without exclude patterns - should find all files
    const allFiles = file.listFilesRecursively(tempDir)
    expect(allFiles.length).toBe(9)
    expect(allFiles.some(f => f.includes('.git'))).toBe(true)
    expect(allFiles.some(f => f.includes('.obsidian'))).toBe(true)
    expect(allFiles.some(f => f.includes('node_modules'))).toBe(true)

    // with .* pattern - should exclude hidden folders
    const noHidden = file.listFilesRecursively(tempDir, ['.*'])
    expect(noHidden.some(f => f.includes('.git'))).toBe(false)
    expect(noHidden.some(f => f.includes('.obsidian'))).toBe(false)
    expect(noHidden.some(f => f.includes('node_modules'))).toBe(true)
    expect(noHidden.some(f => f.includes('src'))).toBe(true)

    // with multiple patterns
    const filtered = file.listFilesRecursively(tempDir, ['.*', 'node_modules', '__pycache__'])
    expect(filtered.some(f => f.includes('.git'))).toBe(false)
    expect(filtered.some(f => f.includes('.obsidian'))).toBe(false)
    expect(filtered.some(f => f.includes('node_modules'))).toBe(false)
    expect(filtered.some(f => f.includes('__pycache__'))).toBe(false)
    expect(filtered.some(f => f.includes('src'))).toBe(true)
    expect(filtered.some(f => f.includes('docs'))).toBe(true)
    expect(filtered.some(f => f.endsWith('package.json'))).toBe(true)
    expect(filtered.length).toBe(4) // index.ts, App.vue, readme.md, package.json

  } finally {
    // cleanup
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Get icon contents', async () => {
  expect(file.getIconContents(app, './assets/icon.png')).toBeNull()
  const contents = file.getIconContents(app, './assets/icon.icns')
  expect(contents!.contents.length).toBeGreaterThan(0)
  expect(contents).toStrictEqual({
    url: 'file://./assets/icon.icns',
    mimeType: 'image/png',
    contents: expect.any(String),
  })
})

test('Get app info', async () => {
  if (process.platform == 'darwin') {
    expect(await file.getAppInfo(app, '/Terminal.app')).toBeNull()
    const info = await file.getAppInfo(app, '/System/Applications/Utilities/Terminal.app')
    expect(info).toStrictEqual({
      name: 'Terminal',
      identifier: 'com.apple.Terminal',
      icon: {
        url: 'file:///System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns',
        mimeType: 'image/png',
        contents: expect.any(String),
      }
    })
  }
})

test('List directory', async () => {
  const tempDir = os.tmpdir()
  const testDir = path.join(tempDir, 'test-dir')
  
  // Create test directory and files
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir)
  }
  fs.writeFileSync(path.join(testDir, 'test.txt'), 'test content')
  fs.writeFileSync(path.join(testDir, '.hidden'), 'hidden content')
  fs.mkdirSync(path.join(testDir, 'subdir'), { recursive: true })
  
  // Test without hidden files
  const items = file.listDirectory(app, testDir, false)
  expect(items).toEqual(expect.arrayContaining([
    { name: 'test.txt', fullPath: expect.any(String), isDirectory: false, size: expect.any(Number) },
    { name: 'subdir', fullPath: expect.any(String), isDirectory: true }
  ]))
  expect(items.find(item => item.name === '.hidden')).toBeUndefined()
  
  // Test with hidden files
  const itemsWithHidden = file.listDirectory(app, testDir, true)
  expect(itemsWithHidden).toEqual(expect.arrayContaining([
    { name: 'test.txt', fullPath: expect.any(String), isDirectory: false, size: expect.any(Number) },
    { name: '.hidden', fullPath: expect.any(String), isDirectory: false, size: expect.any(Number) },
    { name: 'subdir', fullPath: expect.any(String), isDirectory: true }
  ]))
  
  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true })
})

test('File exists', async () => {
  const tempDir = os.tmpdir()
  const testFile = path.join(tempDir, 'exists-test.txt')
  
  // File doesn't exist
  expect(file.fileExists(app, testFile)).toBe(false)
  
  // Create file
  fs.writeFileSync(testFile, 'test')
  expect(file.fileExists(app, testFile)).toBe(true)
  
  // Cleanup
  fs.unlinkSync(testFile)
})

test('Write file', async () => {
  
  const tempDir = os.tmpdir()
  const testFile = path.join(tempDir, 'test.txt')
  const content = 'test content'
  expect(() => file.writeFile(app, testFile, content)).not.toThrow()
  expect(fs.readFileSync(testFile, 'utf8')).toBe(content)
  fs.unlinkSync(testFile)
})

test('Write new file with directory creation', async () => {
  const tempDir = os.tmpdir()
  const testDir = path.join(tempDir, 'new-dir', 'nested')
  const testFile = path.join(testDir, 'nested-file.txt')
  const content = 'nested content'
  expect(() => file.writeFile(app, testFile, content)).not.toThrow()
  expect(fs.readFileSync(testFile, 'utf8')).toBe(content)
  fs.rmSync(path.join(tempDir, 'new-dir'), { recursive: true, force: true })
})

test('Normalize path', async () => {
  const homeDir = os.homedir()

  // Test tilde expansion
  expect(file.normalizePath(app, '~/Documents')).toBe(path.resolve(homeDir, 'Documents'))
  expect(file.normalizePath(app, '~')).toBe(path.resolve(homeDir))

  // Test relative paths (should be relative to home)
  expect(file.normalizePath(app, 'Documents')).toBe(path.resolve(homeDir, 'Documents'))
  expect(file.normalizePath(app, 'Downloads/file.txt')).toBe(path.resolve(homeDir, 'Downloads/file.txt'))

  // Test absolute paths (should remain unchanged)
  const absolutePath = process.platform === 'win32' ? 'C:\\temp\\file.txt' : '/tmp/file.txt'
  expect(file.normalizePath(app, absolutePath)).toBe(path.resolve(absolutePath))

  // Test current directory
  expect(file.normalizePath(app, '.')).toBe(path.resolve(homeDir, '.'))
  expect(file.normalizePath(app, '..')).toBe(path.resolve(homeDir, '..'))
})

test('Find files', async () => {
  const tempDir = os.tmpdir()
  const testDir = path.join(tempDir, 'find-files-test')

  // Create test directory structure
  fs.mkdirSync(testDir, { recursive: true })
  fs.mkdirSync(path.join(testDir, 'subdir'), { recursive: true })
  fs.writeFileSync(path.join(testDir, 'file1.txt'), 'content1')
  fs.writeFileSync(path.join(testDir, 'file2.json'), '{}')
  fs.writeFileSync(path.join(testDir, 'subdir', 'file3.txt'), 'content3')

  // Test finding all files
  const allFiles = await file.findFiles(app, testDir, '*', 100)
  expect(allFiles.length).toBe(3)

  // Test finding with pattern
  const txtFiles = await file.findFiles(app, testDir, '*.txt', 100)
  expect(txtFiles.length).toBe(2)
  expect(txtFiles.every(f => f.endsWith('.txt'))).toBe(true)

  // Test max results limit
  const limitedFiles = await file.findFiles(app, testDir, '*', 1)
  expect(limitedFiles.length).toBe(1)

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true })
})

test('Find files in non-existent directory', async () => {
  // findFiles returns empty array for non-existent directory (doesn't throw)
  const result = await file.findFiles(app, '/nonexistent/path', '*')
  expect(result).toEqual([])
})

test('File stats', async () => {
  const tempDir = os.tmpdir()
  const testFile = path.join(tempDir, 'stats-test.txt')
  const testDir = path.join(tempDir, 'stats-test-dir')

  // Create test file
  fs.writeFileSync(testFile, 'test content')
  fs.mkdirSync(testDir, { recursive: true })

  // Test file stats
  const fileStats = file.fileStats(app, testFile)
  expect(fileStats).not.toBeNull()
  expect(fileStats!.isFile).toBe(true)
  expect(fileStats!.isDirectory).toBe(false)
  expect(fileStats!.size).toBe(12) // 'test content'.length
  expect(fileStats!.lastModified).toBeDefined()
  expect(fileStats!.createdAt).toBeDefined()

  // Test directory stats
  const dirStats = file.fileStats(app, testDir)
  expect(dirStats).not.toBeNull()
  expect(dirStats!.isFile).toBe(false)
  expect(dirStats!.isDirectory).toBe(true)

  // Test non-existent path
  const nullStats = file.fileStats(app, '/nonexistent/path')
  expect(nullStats).toBeNull()

  // Cleanup
  fs.unlinkSync(testFile)
  fs.rmdirSync(testDir)
})

test('Search content in file', async () => {
  const tempDir = os.tmpdir()
  const testFile = path.join(tempDir, 'search-test.txt')

  // Create test file with content
  fs.writeFileSync(testFile, 'line one\nline two with pattern\nline three\npattern again')

  // Test search in single file
  const result = file.searchContent(testFile, 'pattern')
  expect(result.filesSearched).toBe(1)
  expect(result.matches.length).toBe(2)
  expect(result.matches[0].line).toBe(2)
  expect(result.matches[0].content).toBe('line two with pattern')
  expect(result.matches[1].line).toBe(4)

  // Cleanup
  fs.unlinkSync(testFile)
})

test('Search content in directory', async () => {
  const tempDir = os.tmpdir()
  const testDir = path.join(tempDir, 'search-dir-test')

  // Create test directory with files
  fs.mkdirSync(testDir, { recursive: true })
  fs.writeFileSync(path.join(testDir, 'file1.txt'), 'hello world\nfoo bar')
  fs.writeFileSync(path.join(testDir, 'file2.txt'), 'no match here')
  fs.writeFileSync(path.join(testDir, 'file3.txt'), 'hello again')

  // Test search in directory
  const result = file.searchContent(testDir, 'hello')
  expect(result.filesSearched).toBe(3)
  expect(result.matches.length).toBe(2)

  // Test with glob filter
  const filteredResult = file.searchContent(testDir, 'hello', { glob: 'file1.txt' })
  expect(filteredResult.matches.length).toBe(1)

  // Test case insensitive
  const caseResult = file.searchContent(testDir, 'HELLO', { caseInsensitive: true })
  expect(caseResult.matches.length).toBe(2)

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true })
})

test('Search content with context lines', async () => {
  const tempDir = os.tmpdir()
  const testFile = path.join(tempDir, 'search-context-test.txt')

  // Create test file
  fs.writeFileSync(testFile, 'line 1\nline 2\nmatch here\nline 4\nline 5')

  const result = file.searchContent(testFile, 'match', { contextLines: 1 })
  expect(result.matches.length).toBe(3) // line before, match, line after
  expect(result.matches[0].content).toBe('line 2')
  expect(result.matches[0].isMatch).toBe(false)
  expect(result.matches[1].content).toBe('match here')
  expect(result.matches[1].isMatch).toBe(true)
  expect(result.matches[2].content).toBe('line 4')
  expect(result.matches[2].isMatch).toBe(false)

  // Cleanup
  fs.unlinkSync(testFile)
})

test('Search content with invalid regex', async () => {
  const result = file.searchContent('.', '[invalid')
  expect(result.matches).toEqual([])
  expect(result.filesSearched).toBe(0)
})

test('Search content max results', async () => {
  const tempDir = os.tmpdir()
  const testFile = path.join(tempDir, 'search-max-test.txt')

  // Create file with many matches
  fs.writeFileSync(testFile, 'match\nmatch\nmatch\nmatch\nmatch')

  const result = file.searchContent(testFile, 'match', { maxResults: 2 })
  expect(result.matches.length).toBe(2)
  expect(result.truncated).toBe(true)

  // Cleanup
  fs.unlinkSync(testFile)
})

test('Write file contents with subdir', async () => {
  const tempDir = os.tmpdir()
  const subdir = 'write-test-subdir'

  const fileURL = file.writeFileContents(app, {
    contents: 'SGVsbG8=', // 'Hello' in base64
    url: 'test.txt',
    properties: {
      filename: 'test.txt',
      directory: 'temp',
      subdir: subdir,
    }
  })

  expect(fileURL).toBe(`file://${path.join(tempDir, subdir, 'test.txt')}`)
  expect(fs.existsSync(path.join(tempDir, subdir, 'test.txt'))).toBe(true)

  // Cleanup
  fs.rmSync(path.join(tempDir, subdir), { recursive: true, force: true })
})

test('List directory throws on error', async () => {
  expect(() => file.listDirectory(app, '/nonexistent/path')).toThrow()
})

describe('Save and download containment', () => {

  const isPosix = process.platform !== 'win32'
  const base64 = (text: string) => Buffer.from(text).toString('base64')

  let root: string

  const filesUnder = (dir: string): string[] => {
    const result: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) result.push(...filesUnder(full))
      else result.push(path.relative(root, full))
    }
    return result.sort()
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-containment-')))
    for (const dir of ['downloads', 'userData', 'documents', 'temp', 'outside']) fs.mkdirSync(path.join(root, dir))
    vi.mocked(app.getPath).mockImplementation(((name: string) => path.join(root, name)) as any)
    vi.mocked(dialog.showSaveDialogSync).mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(console.error).mockRestore()
    vi.mocked(app.getPath).mockImplementation(() => os.tmpdir())
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('saves in the requested, sub and workspace directories', () => {
    expect(file.writeFileContents(app, { contents: base64('1'), properties: { filename: 'a.txt', directory: 'userData' } }))
      .toBe(`file://${path.join(root, 'userData', 'a.txt')}`)
    expect(file.writeFileContents(app, { contents: base64('2'), properties: { filename: 'b.txt', directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'b.txt')}`)
    expect(file.writeFileContents(app, { contents: base64('3'), properties: { filename: 'c.png', directory: 'userData', subdir: 'images' } }))
      .toBe(`file://${path.join(root, 'userData', 'images', 'c.png')}`)
    expect(file.writeFileContents(app, { contents: base64('4'), properties: { filename: 'd.png', directory: 'userData', subdir: path.join('images', '2026') } }))
      .toBe(`file://${path.join(root, 'userData', 'images', '2026', 'd.png')}`)
    expect(file.writeFileContents(app, { contents: base64('5'), properties: { filename: 'e.png', directory: 'userData', subdir: 'images', workspace: '123e4567-e89b-12d3-a456-426614174000' } }))
      .toBe(`file://${path.join(root, 'userData', 'workspaces', '123e4567-e89b-12d3-a456-426614174000', 'images', 'e.png')}`)
    expect(file.writeFileContents(app, { contents: base64('6'), url: 'https://example.com/media/f.png?size=large', properties: { directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'f.png')}`)
    expect(filesUnder(root)).toStrictEqual([
      path.join('temp', 'b.txt'),
      path.join('temp', 'f.png'),
      path.join('userData', 'a.txt'),
      path.join('userData', 'images', '2026', 'd.png'),
      path.join('userData', 'images', 'c.png'),
      path.join('userData', 'workspaces', '123e4567-e89b-12d3-a456-426614174000', 'images', 'e.png'),
    ])
    expect(fs.readFileSync(path.join(root, 'userData', 'images', '2026', 'd.png'), 'utf8')).toBe('4')
  })

  test.each([
    ['../../outside.txt', 'outside.txt'],
    ['../outside/evil.txt', 'evil.txt'],
    ['..\\..\\outside.txt', 'outside.txt'],
    ['..\\outside\\evil.txt', 'evil.txt'],
    ['sub/dir/nested.txt', 'nested.txt'],
    ['/etc/witsy-evil.txt', 'witsy-evil.txt'],
    ['C:\\Windows\\evil.txt', 'evil.txt'],
    ['ABSOLUTE', 'evil.txt'],
  ])('a file name of %s is reduced to its last segment', (filename, expected) => {
    if (filename === 'ABSOLUTE') filename = path.join(root, 'outside', 'evil.txt')
    const url = file.writeFileContents(app, { contents: base64('x'), properties: { filename, directory: 'temp' } })
    expect(url).toBe(`file://${path.join(root, 'temp', expected)}`)
    expect(filesUnder(root)).toStrictEqual([path.join('temp', expected)])
  })

  test.each([
    ['..'], ['.'], ['../..'], ['dir/'], ['dir/..'], ['..\\..'], ['a\0b.txt'], [42], [{ name: 'a.txt' }], [['a.txt']],
  ])('a file name of %j is refused', (filename) => {
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: filename as any, directory: 'temp' } })).toBeNull()
    expect(filesUnder(root)).toStrictEqual([])
  })

  test('a save without any file name is refused', () => {
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { directory: 'temp' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), url: 'https://example.com/media/', properties: { directory: 'temp' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), url: 42 as any, properties: { directory: 'temp' } })).toBeNull()
    expect(filesUnder(root)).toStrictEqual([])
  })

  test.each([
    ['../..'],
    ['..'],
    ['../outside'],
    ['../documents'],
    ['images/../../outside'],
    ['ABSOLUTE'],
    [true],
    [{ dir: 'images' }],
  ])('a sub-directory of %j is refused and nothing is created', (subdir) => {
    if (subdir === 'ABSOLUTE') subdir = path.join(root, 'outside')
    for (const directory of ['temp', 'userData'] as const) {
      for (const workspace of [undefined, 'ws1']) {
        expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory, subdir: subdir as any, workspace } })).toBeNull()
      }
    }
    expect(filesUnder(root)).toStrictEqual([])
    expect(fs.readdirSync(path.join(root, 'userData'))).toStrictEqual([])
    expect(fs.readdirSync(path.join(root, 'temp'))).toStrictEqual([])
  })

  test.runIf(isPosix)('a sub-directory name with backslashes stays inside the target directory', () => {
    const url = file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'x.txt', directory: 'temp', subdir: '..\\..\\outside' } })
    expect(url).toBe(`file://${path.join(root, 'temp', '..\\..\\outside', 'x.txt')}`)
    expect(filesUnder(root)).toStrictEqual([path.join('temp', '..\\..\\outside', 'x.txt')])
  })

  test.each([
    ['../../documents'],
    ['..'],
    ['../outside'],
    ['a/b'],
    ['a\\b'],
    ['ABSOLUTE'],
    [42],
    [{ id: 'ws1' }],
  ])('a workspace of %j is refused and nothing is created', (workspace) => {
    if (workspace === 'ABSOLUTE') workspace = path.join(root, 'outside')
    for (const subdir of [undefined, 'images']) {
      expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory: 'userData', subdir, workspace: workspace as any } })).toBeNull()
    }
    expect(filesUnder(root)).toStrictEqual([])
    expect(fs.readdirSync(path.join(root, 'userData'))).toStrictEqual([])
  })

  test.runIf(isPosix)('a symlinked sub-directory or workspace pointing outside is not followed', () => {
    const outside = path.join(root, 'outside')
    fs.symlinkSync(outside, path.join(root, 'userData', 'images'))
    fs.mkdirSync(path.join(root, 'userData', 'workspaces'))
    fs.symlinkSync(outside, path.join(root, 'userData', 'workspaces', 'ws-link'))
    fs.mkdirSync(path.join(root, 'userData', 'workspaces', 'ws1'))
    fs.symlinkSync(outside, path.join(root, 'userData', 'workspaces', 'ws1', 'images'))
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory: 'userData', subdir: 'images' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory: 'userData', subdir: 'images/deeper' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory: 'userData', workspace: 'ws-link' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory: 'userData', workspace: 'ws-link', subdir: 'images' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'evil.txt', directory: 'userData', workspace: 'ws1', subdir: 'images' } })).toBeNull()
    expect(fs.readdirSync(outside)).toStrictEqual([])
    expect(filesUnder(root)).toStrictEqual([
      path.join('userData', 'images'),
      path.join('userData', 'workspaces', 'ws-link'),
      path.join('userData', 'workspaces', 'ws1', 'images'),
    ])
  })

  test.runIf(isPosix)('a destination that is a symlink to a file outside is not written through', () => {
    const victim = path.join(root, 'outside', 'victim.txt')
    fs.writeFileSync(victim, 'original')
    fs.symlinkSync(victim, path.join(root, 'temp', 'report.txt'))
    fs.symlinkSync(path.join(root, 'outside', 'created.txt'), path.join(root, 'temp', 'dangling.txt'))
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'report.txt', directory: 'temp' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'dangling.txt', directory: 'temp' } })).toBeNull()
    expect(fs.readFileSync(victim, 'utf8')).toBe('original')
    expect(fs.readdirSync(path.join(root, 'outside'))).toStrictEqual(['victim.txt'])
  })

  test.runIf(isPosix)('a symlinked sub-directory that stays inside the target directory still works', () => {
    fs.mkdirSync(path.join(root, 'userData', 'media'))
    fs.symlinkSync(path.join(root, 'userData', 'media'), path.join(root, 'userData', 'images'))
    const url = file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'a.png', directory: 'userData', subdir: 'images' } })
    expect(url).toBe(`file://${path.join(root, 'userData', 'images', 'a.png')}`)
    expect(fs.readFileSync(path.join(root, 'userData', 'media', 'a.png'), 'utf8')).toBe('x')
  })

  test('an unknown directory is refused', () => {
    vi.mocked(app.getPath).mockClear()
    for (const directory of ['exe', 'desktop', '../outside', '', null, 42, { name: 'downloads' }]) {
      expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'a.txt', directory: directory as any } })).toBeNull()
    }
    expect(app.getPath).not.toHaveBeenCalled()
    expect(filesUnder(root)).toStrictEqual([])
  })

  test('a file url only gives the default name and is never the destination', () => {
    const victim = path.join(root, 'outside', 'victim.txt')
    fs.writeFileSync(victim, 'original')
    expect(file.writeFileContents(app, { contents: base64('x'), url: `file://${victim}`, properties: { directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'victim.txt')}`)
    expect(file.writeFileContents(app, { contents: base64('x'), url: `file://${victim}`, properties: { filename: 'named.txt', directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'named.txt')}`)
    expect(fs.readFileSync(victim, 'utf8')).toBe('original')
    expect(filesUnder(root)).toStrictEqual([
      path.join('outside', 'victim.txt'),
      path.join('temp', 'named.txt'),
      path.join('temp', 'victim.txt'),
    ])
  })

  test('a prompted save suggests a sanitised name and writes where the user picked', () => {
    const picked = path.join(root, 'outside', 'picked by user.md')
    vi.mocked(dialog.showSaveDialogSync).mockReturnValue(picked)
    const url = file.writeFileContents(app, { contents: base64('export'), url: '../../My chat.md', properties: { directory: 'documents', prompt: true } })
    expect(dialog.showSaveDialogSync).toHaveBeenLastCalledWith({ defaultPath: path.join(root, 'documents', 'My chat.md') })
    expect(url).toBe(`file://${picked}`)
    expect(fs.readFileSync(picked, 'utf8')).toBe('export')
    expect(filesUnder(root)).toStrictEqual([path.join('outside', 'picked by user.md')])
  })

  test('a prompted save never suggests a path outside the target directory', () => {
    const victim = path.join(root, 'outside', 'victim.txt')
    fs.writeFileSync(victim, 'original')
    vi.mocked(dialog.showSaveDialogSync).mockReturnValue(undefined)
    expect(file.writeFileContents(app, { contents: base64('x'), url: `file://${victim}`, properties: { prompt: true } })).toBeNull()
    expect(dialog.showSaveDialogSync).toHaveBeenLastCalledWith({ defaultPath: path.join(root, 'downloads', 'victim.txt') })
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { prompt: true, filename: '../../outside/agent.json' } })).toBeNull()
    expect(dialog.showSaveDialogSync).toHaveBeenLastCalledWith({ defaultPath: path.join(root, 'downloads', 'agent.json') })
    expect(dialog.showSaveDialogSync).toHaveBeenCalledTimes(2)
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { prompt: true, filename: 'a.txt', subdir: '../outside' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { prompt: true, filename: '..' } })).toBeNull()
    expect(dialog.showSaveDialogSync).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(victim, 'utf8')).toBe('original')
    expect(filesUnder(root)).toStrictEqual([path.join('outside', 'victim.txt')])
  })

  test('a local file download is confined to the target directory', async () => {
    const source = path.join(root, 'documents', 'source.png')
    fs.writeFileSync(source, 'image-bytes')
    const victim = path.join(root, 'outside', 'victim.txt')
    fs.writeFileSync(victim, 'original')

    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: 'copy.png', directory: 'userData', subdir: 'images', workspace: 'ws1' } }))
      .toBe(`file://${path.join(root, 'userData', 'workspaces', 'ws1', 'images', 'copy.png')}`)
    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: '../../outside/victim.txt', directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'victim.txt')}`)
    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: victim, directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'victim.txt')}`)
    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: 'victim.txt', directory: 'temp', subdir: '../outside' } })).toBeNull()
    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: 'victim.txt', directory: 'userData', workspace: '../../outside' } })).toBeNull()

    expect(fs.readFileSync(victim, 'utf8')).toBe('original')
    expect(fs.readFileSync(source, 'utf8')).toBe('image-bytes')
    expect(filesUnder(root)).toStrictEqual([
      path.join('documents', 'source.png'),
      path.join('outside', 'victim.txt'),
      path.join('temp', 'victim.txt'),
      path.join('userData', 'workspaces', 'ws1', 'images', 'copy.png'),
    ])
  })

  test('a remote file download is confined to the target directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('image-bytes', { status: 200 })))
    expect(await file.downloadFile(app, { url: 'https://example.com/a/cat.png?x=1', properties: { filename: '../../outside/cat.png', directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'cat.png')}`)
    expect(await file.downloadFile(app, { url: 'https://example.com/a/dog.png?x=1', properties: { directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'dog.png')}`)
    expect(await file.downloadFile(app, { url: 'https://example.com/a/cat.png', properties: { filename: 'cat.png', directory: 'temp', subdir: '../outside' } })).toBeNull()
    expect(await file.downloadFile(app, { url: 'https://example.com/a/..', properties: { directory: 'temp', subdir: 'images' } })).toBeNull()
    expect(filesUnder(root)).toStrictEqual([path.join('temp', 'cat.png'), path.join('temp', 'dog.png')])
  })

  test.each([
    ['home'], ['appData'], ['sessionData'], ['documents'], ['downloads'],
  ] as const)('a save without a dialog in %s is refused and nothing is written', async (directory) => {
    // the renderer names the directory: without this, `home` and a sub-directory reach ~/.ssh/authorized_keys
    fs.mkdirSync(path.join(root, directory), { recursive: true })
    const source = path.join(root, 'outside', 'source.txt')
    fs.writeFileSync(source, 'source')
    const fetchMock = vi.fn(async () => new Response('remote', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(app.getPath).mockClear()

    for (const prompt of [undefined, false, null, 0, '']) {
      for (const properties of [{ filename: 'authorized_keys', subdir: '.ssh' }, { filename: 'a.txt' }]) {
        expect(file.writeFileContents(app, { contents: base64('x'), properties: { ...properties, directory, prompt: prompt as any } })).toBeNull()
        expect(await file.downloadFile(app, { url: `file://${source}`, properties: { ...properties, directory, prompt: prompt as any } })).toBeNull()
        expect(await file.downloadFile(app, { url: 'https://example.com/a.txt', properties: { ...properties, directory, prompt: prompt as any } })).toBeNull()
      }
    }

    expect(filesUnder(root)).toStrictEqual([path.join('outside', 'source.txt')])
    expect(fs.readdirSync(path.join(root, directory))).toStrictEqual([])
    expect(app.getPath).not.toHaveBeenCalled()
    expect(dialog.showSaveDialogSync).not.toHaveBeenCalled()
    // nothing is requested for a download that cannot be saved
    expect(fetchMock).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('Refusing to save file without a save dialog in directory', directory)
  })

  test('a save or a download without directory and without dialog is refused', async () => {
    // the default directory is downloads and the default is not to ask
    const fetchMock = vi.fn(async () => new Response('remote', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'a.txt' } })).toBeNull()
    expect(file.writeFileContents(app, { contents: base64('x'), url: 'https://example.com/a.txt' })).toBeNull()
    expect(await file.downloadFile(app, { url: 'https://example.com/a.txt' })).toBeNull()
    expect(await file.downloadFile(app, { url: 'https://example.com/a.txt', properties: { filename: 'a.txt' } })).toBeNull()
    expect(filesUnder(root)).toStrictEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a save without a dialog still works in the folders of the app', async () => {
    const source = path.join(root, 'outside', 'source.txt')
    fs.writeFileSync(source, 'source')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('remote', { status: 200 })))

    // generated media and attachments
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'a.png', directory: 'userData', subdir: 'images', workspace: 'ws1', prompt: false } }))
      .toBe(`file://${path.join(root, 'userData', 'workspaces', 'ws1', 'images', 'a.png')}`)
    expect(await file.downloadFile(app, { url: 'https://example.com/b.png', properties: { filename: 'b.png', directory: 'userData', subdir: 'images', workspace: 'ws1', prompt: false } }))
      .toBe(`file://${path.join(root, 'userData', 'workspaces', 'ws1', 'images', 'b.png')}`)
    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: 'c.png', directory: 'userData', subdir: 'images' } }))
      .toBe(`file://${path.join(root, 'userData', 'images', 'c.png')}`)

    // drawings of the design studio
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'drawing-1764201600000.png', directory: 'temp' } }))
      .toBe(`file://${path.join(root, 'temp', 'drawing-1764201600000.png')}`)

    expect(dialog.showSaveDialogSync).not.toHaveBeenCalled()
    expect(filesUnder(root)).toStrictEqual([
      path.join('outside', 'source.txt'),
      path.join('temp', 'drawing-1764201600000.png'),
      path.join('userData', 'images', 'c.png'),
      path.join('userData', 'workspaces', 'ws1', 'images', 'a.png'),
      path.join('userData', 'workspaces', 'ws1', 'images', 'b.png'),
    ])
  })

  test.each([
    ['home'], ['appData'], ['userData'], ['sessionData'], ['temp'], ['documents'], ['downloads'],
  ] as const)('a save with a dialog opens in %s and writes where the user picked', async (directory) => {
    const source = path.join(root, 'outside', 'source.txt')
    fs.writeFileSync(source, 'source')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('remote', { status: 200 })))

    const picked = path.join(root, 'outside', 'picked.txt')
    vi.mocked(dialog.showSaveDialogSync).mockReturnValue(picked)
    expect(file.writeFileContents(app, { contents: base64('saved'), properties: { filename: 'a.txt', directory, prompt: true } })).toBe(`file://${picked}`)
    expect(dialog.showSaveDialogSync).toHaveBeenLastCalledWith({ defaultPath: path.join(root, directory, 'a.txt') })
    expect(fs.readFileSync(picked, 'utf8')).toBe('saved')

    expect(await file.downloadFile(app, { url: `file://${source}`, properties: { filename: 'b.txt', directory, prompt: true } })).toBe(`file://${picked}`)
    expect(dialog.showSaveDialogSync).toHaveBeenLastCalledWith({ defaultPath: path.join(root, directory, 'b.txt') })
    expect(fs.readFileSync(picked, 'utf8')).toBe('source')

    expect(await file.downloadFile(app, { url: 'https://example.com/c.txt', properties: { filename: 'c.txt', directory, prompt: true } })).toBe(`file://${picked}`)
    expect(fs.readFileSync(picked, 'utf8')).toBe('remote')

    // a cancelled dialog writes nothing
    vi.mocked(dialog.showSaveDialogSync).mockReturnValue(undefined)
    expect(file.writeFileContents(app, { contents: base64('x'), properties: { filename: 'd.txt', directory, prompt: true } })).toBeNull()
    expect(dialog.showSaveDialogSync).toHaveBeenCalledTimes(4)
    expect(filesUnder(root)).toStrictEqual([path.join('outside', 'picked.txt'), path.join('outside', 'source.txt')])
  })

})
