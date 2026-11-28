import { expect, test, describe, beforeEach, afterEach } from 'vitest'
import CliPlugin, { MAX_FILE_SNAPSHOTS, fileSnapshotCount } from '@/main/cli_plugin'
import fs from 'fs'
import os from 'os'
import path from 'path'

describe('CliPlugin', () => {

  let tempDir: string
  let plugin: CliPlugin

  beforeEach(() => {
    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-plugin-test-'))
    plugin = new CliPlugin({
      workDirPath: tempDir,
      workDirAccess: 'rw'
    })
  })

  afterEach(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
  })

  describe('isEnabled', () => {
    test('returns true for rw access', () => {
      expect(plugin.isEnabled()).toBe(true)
    })

    test('returns true for ro access', () => {
      const roPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'ro' })
      expect(roPlugin.isEnabled()).toBe(true)
    })

    test('returns false for none access', () => {
      const noPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'none' })
      expect(noPlugin.isEnabled()).toBe(false)
    })

    test('returns false for empty path', () => {
      const noPathPlugin = new CliPlugin({ workDirPath: '', workDirAccess: 'rw' })
      expect(noPathPlugin.isEnabled()).toBe(false)
    })
  })

  describe('getName', () => {
    test('returns cli', () => {
      expect(plugin.getName()).toBe('cli')
    })
  })

  describe('getDescription', () => {
    test('includes read and write for rw access', () => {
      expect(plugin.getDescription()).toContain('read and write')
    })

    test('includes only read for ro access', () => {
      const roPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'ro' })
      expect(roPlugin.getDescription()).toContain('read')
      expect(roPlugin.getDescription()).not.toContain('read and write')
    })
  })

  describe('getParameters', () => {
    test('includes write actions for rw access', () => {
      const params = plugin.getParameters()
      const actionParam = params.find(p => p.name === 'action')
      expect(actionParam?.enum).toContain('read_file')
      expect(actionParam?.enum).toContain('write_file')
      expect(actionParam?.enum).toContain('edit_file')
      expect(actionParam?.enum).toContain('create_directory')
      expect(actionParam?.enum).toContain('delete_file')
      expect(actionParam?.enum).toContain('move_file')
    })

    test('excludes write actions for ro access', () => {
      const roPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'ro' })
      const params = roPlugin.getParameters()
      const actionParam = params.find(p => p.name === 'action')
      expect(actionParam?.enum).toContain('read_file')
      expect(actionParam?.enum).not.toContain('write_file')
      expect(actionParam?.enum).not.toContain('edit_file')
    })
  })

  describe('validatePath', () => {
    test('accepts absolute path within workDir', () => {
      const filePath = path.join(tempDir, 'test.txt')
      expect(plugin.validatePath(filePath)).toBe(filePath)
    })

    test('accepts relative path', () => {
      const result = plugin.validatePath('test.txt')
      expect(result).toBe(path.join(tempDir, 'test.txt'))
    })

    test('rejects path outside workDir', () => {
      expect(plugin.validatePath('/etc/passwd')).toBeNull()
    })

    test('rejects path traversal', () => {
      expect(plugin.validatePath('../../../etc/passwd')).toBeNull()
    })
  })

  describe('read_file', () => {
    test('reads full file', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'line1\nline2\nline3')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'test.txt'
      })

      expect(result.success).toBe(true)
      expect(result.content).toContain('line1')
      expect(result.content).toContain('line2')
      expect(result.content).toContain('line3')
      expect(result.totalLines).toBe(3)
      expect(result.linesRead).toBe(3)
      expect(result.lastModified).toBeDefined()
    })

    test('reads line range', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'test.txt',
        start: 2,
        end: 4
      })

      expect(result.success).toBe(true)
      expect(result.content).toContain('line2')
      expect(result.content).toContain('line3')
      expect(result.content).toContain('line4')
      expect(result.content).not.toContain('line1')
      expect(result.content).not.toContain('line5')
      expect(result.linesRead).toBe(3)
      expect(result.totalLines).toBe(5)
    })

    test('returns error for missing file', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'notfound.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    test('returns error for path outside workDir', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: '/etc/passwd'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not allowed')
    })

    test('formats output with line numbers', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'hello\nworld')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'test.txt'
      })

      expect(result.success).toBe(true)
      expect(result.content).toMatch(/^\s+1→hello/)
      expect(result.content).toMatch(/\s+2→world/)
    })
  })

  describe('write_file', () => {
    test('writes new file', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'new.txt',
        content: 'hello world'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'new.txt'))).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'new.txt'), 'utf-8')).toBe('hello world')
    })

    test('overwrites existing file', async () => {
      const filePath = path.join(tempDir, 'existing.txt')
      fs.writeFileSync(filePath, 'old content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'existing.txt',
        content: 'new content'
      })

      expect(result.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content')
    })

    test('validates lastModified', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'content')
      const stats = fs.statSync(filePath)

      // Modify file
      fs.writeFileSync(filePath, 'modified')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'test.txt',
        content: 'new content',
        lastModified: stats.mtimeMs
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('modified')
    })

    test('fails with ro access', async () => {
      const roPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'ro' })

      const result = await roPlugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'test.txt',
        content: 'content'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Write access not granted')
    })
  })

  describe('list_files', () => {
    test('lists files and directories with separator', async () => {
      // Create test structure
      fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'content')
      fs.writeFileSync(path.join(tempDir, 'file2.json'), 'content')
      fs.mkdirSync(path.join(tempDir, 'subdir'))

      const result = await plugin.execute({ model: 'test' }, {
        action: 'list_files',
        path: '.'
      })

      expect(result.success).toBe(true)
      expect(result.fileCount).toBe(3)
      // Directories should have trailing separator
      expect(result.content).toContain('subdir' + path.sep)
      // Files should not
      expect(result.content).toContain('file1.txt')
      expect(result.content).toContain('file2.json')
    })

    test('shows only first 3 items with summary', async () => {
      // Create 5 files
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), 'content')
      }

      const result = await plugin.execute({ model: 'test' }, {
        action: 'list_files',
        path: '.'
      })

      expect(result.success).toBe(true)
      expect(result.fileCount).toBe(5)
      // Should show first 3 items
      expect(result.content).toContain('file1.txt')
      expect(result.content).toContain('file2.txt')
      expect(result.content).toContain('file3.txt')
      // Should NOT show items 4 and 5
      expect(result.content).not.toContain('file4.txt')
      expect(result.content).not.toContain('file5.txt')
      // Should have summary line
      expect(result.content).toContain('... +2 more items')
    })

    test('shows all items when 3 or fewer', async () => {
      fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'content')
      fs.writeFileSync(path.join(tempDir, 'file2.txt'), 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'list_files',
        path: '.'
      })

      expect(result.success).toBe(true)
      expect(result.fileCount).toBe(2)
      expect(result.content).toContain('file1.txt')
      expect(result.content).toContain('file2.txt')
      // Should NOT have summary line
      expect(result.content).not.toContain('more items')
    })

    test('sorts directories first', async () => {
      fs.writeFileSync(path.join(tempDir, 'aaa.txt'), 'content')
      fs.mkdirSync(path.join(tempDir, 'zzz'))

      const result = await plugin.execute({ model: 'test' }, {
        action: 'list_files',
        path: '.'
      })

      expect(result.success).toBe(true)
      const lines = result.content?.split('\n') || []
      // Directory should come first despite alphabetical order
      expect(lines[0]).toContain('zzz' + path.sep)
      expect(lines[1]).toContain('aaa.txt')
    })

    test('fails on non-directory', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'list_files',
        path: 'test.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not a directory')
    })
  })

  describe('search', () => {
    test('reports a result that was cut short', async () => {
      fs.writeFileSync(path.join(tempDir, 'a.txt'), 'needle\nneedle\nneedle')

      const cut = await plugin.execute({ model: 'test' }, {
        action: 'search',
        path: '.',
        pattern: 'needle',
        maxResults: 2
      })
      expect(cut.success).toBe(true)
      expect(cut.matchCount).toBe(2)
      expect(cut.truncated).toBe(true)

      const complete = await plugin.execute({ model: 'test' }, {
        action: 'search',
        path: '.',
        pattern: 'needle'
      })
      expect(complete.matchCount).toBe(3)
      expect(complete.truncated).toBeUndefined()
    })

    test('finds pattern in files', async () => {
      fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'hello world\nfoo bar')
      fs.writeFileSync(path.join(tempDir, 'file2.txt'), 'goodbye world')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'world'
      })

      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(2)
      expect(result.content).toContain('file1.txt:1:hello world')
      expect(result.content).toContain('file2.txt:1:goodbye world')
    })

    test('searches in specific path', async () => {
      fs.mkdirSync(path.join(tempDir, 'subdir'))
      fs.writeFileSync(path.join(tempDir, 'root.txt'), 'hello')
      fs.writeFileSync(path.join(tempDir, 'subdir', 'nested.txt'), 'hello')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'hello',
        path: 'subdir'
      })

      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(1)
      expect(result.content).toContain('nested.txt')
      expect(result.content).not.toContain('root.txt')
    })

    test('filters by glob pattern', async () => {
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'test content')
      fs.writeFileSync(path.join(tempDir, 'file.js'), 'test content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'test',
        glob: '*.txt'
      })

      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(1)
      expect(result.content).toContain('file.txt')
      expect(result.content).not.toContain('file.js')
    })

    test('case insensitive search', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Hello World\nHELLO world')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'hello',
        caseInsensitive: true
      })

      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(2)
    })

    test('case sensitive search by default', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Hello World\nhello world')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'hello'
      })

      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(1)
      expect(result.content).toContain('hello world')
      expect(result.content).not.toContain('Hello')
    })

    test('respects maxResults limit', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'match\nmatch\nmatch\nmatch\nmatch')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'match',
        maxResults: 2
      })

      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(2)
    })

    test('includes context lines', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'line1\nline2\nmatch\nline4\nline5')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'match',
        contextLines: 1
      })

      expect(result.success).toBe(true)
      expect(result.content).toContain('line2')
      expect(result.content).toContain('match')
      expect(result.content).toContain('line4')
    })

    test('fails on invalid regex', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: '[invalid'
      })

      // Returns empty result rather than error for invalid regex
      expect(result.success).toBe(true)
      expect(result.matchCount).toBe(0)
    })

    test('fails on path outside workDir', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'test',
        path: '/etc'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not allowed')
    })

    test('fails on non-existent path', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'search',
        pattern: 'test',
        path: 'nonexistent'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    test('requires pattern parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'search'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing pattern')
    })
  })

  describe('write_file', () => {
    test('creates new file', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'new.txt',
        content: 'hello'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'new.txt'))).toBe(true)
    })

    test('creates parent directories when creating new file', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'subdir/nested/file.txt',
        content: 'content'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'subdir/nested/file.txt'))).toBe(true)
    })

    test('overwrites existing file', async () => {
      const filePath = path.join(tempDir, 'existing.txt')
      fs.writeFileSync(filePath, 'old content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        path: 'existing.txt',
        content: 'new content'
      })

      expect(result.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content')
    })
  })

  describe('create_directory', () => {
    test('creates directory', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'create_directory',
        path: 'newdir'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'newdir'))).toBe(true)
      expect(fs.statSync(path.join(tempDir, 'newdir')).isDirectory()).toBe(true)
    })

    test('creates nested directories', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'create_directory',
        path: 'a/b/c'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'a/b/c'))).toBe(true)
    })

    test('fails if directory exists', async () => {
      fs.mkdirSync(path.join(tempDir, 'existing'))

      const result = await plugin.execute({ model: 'test' }, {
        action: 'create_directory',
        path: 'existing'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('already exists')
    })
  })

  describe('edit_file', () => {
    test('replaces line range', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file',
        path: 'test.txt',
        start: 2,
        end: 4,
        content: 'new2\nnew3'
      })

      expect(result.success).toBe(true)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toBe('line1\nnew2\nnew3\nline5')
    })

    test('deletes lines with empty content', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'line1\nline2\nline3')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file',
        path: 'test.txt',
        start: 2,
        end: 2,
        content: ''
      })

      expect(result.success).toBe(true)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toBe('line1\nline3')
    })

    test('validates lastModified', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'line1\nline2')
      const stats = fs.statSync(filePath)

      // Modify file
      fs.writeFileSync(filePath, 'modified')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file',
        path: 'test.txt',
        start: 1,
        end: 1,
        content: 'new',
        lastModified: stats.mtimeMs
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('modified')
    })

    test('keeps CRLF line endings on the lines it writes', async () => {
      const filePath = path.join(tempDir, 'crlf.txt')
      fs.writeFileSync(filePath, 'one\r\ntwo\r\nthree\r\n')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 2, end: 2, content: 'TWO\nTWO-B'
      })

      expect(result.success).toBe(true)
      expect(result.totalLines).toBe(5)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('one\r\nTWO\r\nTWO-B\r\nthree\r\n')
    })

    test('does not double the carriage return when the new content already uses CRLF', async () => {
      const filePath = path.join(tempDir, 'crlf.txt')
      fs.writeFileSync(filePath, 'one\r\ntwo\r\nthree\r\n')

      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 1, end: 2, content: 'ONE\r\nTWO'
      })

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('ONE\r\nTWO\r\nthree\r\n')
    })

    test('keeps a CRLF file without a final line break as it is', async () => {
      const filePath = path.join(tempDir, 'crlf.txt')
      fs.writeFileSync(filePath, 'one\r\ntwo\r\nthree')

      // replace the last line: no line break may appear after it
      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 3, end: 3, content: 'THREE\nFOUR'
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('one\r\ntwo\r\nTHREE\r\nFOUR')

      // delete the last lines: the line that becomes the last one loses its line break
      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 3, end: 4, content: ''
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('one\r\ntwo')

      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 1, end: 2, content: ''
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('')
    })

    test('deletes lines of a CRLF file without touching the others', async () => {
      const filePath = path.join(tempDir, 'crlf.txt')
      fs.writeFileSync(filePath, 'one\r\ntwo\r\nthree\r\n')

      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 2, end: 2, content: ''
      })

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('one\r\nthree\r\n')
    })

    test('uses the dominant line ending of a mixed file and converts nothing else', async () => {
      const filePath = path.join(tempDir, 'mixed.txt')

      fs.writeFileSync(filePath, 'a\r\nb\nc\r\nd\r\ne')
      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'mixed.txt', start: 3, end: 3, content: 'C1\nC2'
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('a\r\nb\nC1\r\nC2\r\nd\r\ne')

      fs.writeFileSync(filePath, 'a\nb\r\nc\nd\ne')
      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'mixed.txt', start: 3, end: 3, content: 'C1\nC2'
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('a\nb\r\nC1\nC2\nd\ne')
    })

    test('writes LF in files that have no line break or as many LF as CRLF', async () => {
      const filePath = path.join(tempDir, 'single.txt')

      fs.writeFileSync(filePath, 'only')
      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'single.txt', start: 1, end: 1, content: 'first\nsecond'
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('first\nsecond')

      fs.writeFileSync(filePath, 'a\r\nb\nc')
      await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'single.txt', start: 3, end: 3, content: 'C1\nC2'
      })
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('a\r\nb\nC1\nC2')
    })

    test('read_file and edit_file agree on the line numbers of a CRLF file', async () => {
      const filePath = path.join(tempDir, 'crlf.txt')
      fs.writeFileSync(filePath, 'one\r\ntwo\r\nthree\r\n')

      const before = await plugin.execute({ model: 'test' }, { action: 'read_file', path: 'crlf.txt' })
      expect(before.totalLines).toBe(4)

      const edit = await plugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'crlf.txt', start: 3, end: 3, content: 'THREE\nFOUR'
      })
      expect(edit.totalLines).toBe(5)

      const after = await plugin.execute({ model: 'test' }, { action: 'read_file', path: 'crlf.txt', start: 3, end: 4 })
      expect(after.totalLines).toBe(5)
      expect(after.content).toBe('   3→THREE\r\n   4→FOUR\r')
    })
  })

  describe('delete_file', () => {
    test('deletes file', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      fs.writeFileSync(filePath, 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'delete_file',
        path: 'test.txt'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    test('deletes directory', async () => {
      const dirPath = path.join(tempDir, 'subdir')
      fs.mkdirSync(dirPath)
      fs.writeFileSync(path.join(dirPath, 'file.txt'), 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'delete_file',
        path: 'subdir'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(dirPath)).toBe(false)
    })

    test('fails for missing file', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'delete_file',
        path: 'notfound.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    test('refuses to delete the working directory itself', async () => {
      fs.mkdirSync(path.join(tempDir, 'sub'))
      fs.writeFileSync(path.join(tempDir, 'keep.txt'), 'keep')

      for (const target of ['.', './', 'sub/..', './sub/../.', tempDir, tempDir + path.sep, path.join(tempDir, 'sub', '..')]) {
        const result = await plugin.execute({ model: 'test' }, {
          action: 'delete_file',
          path: target
        })
        expect(result.success, target).toBe(false)
        expect(result.error, target).toContain('working directory')
        expect(fs.readFileSync(path.join(tempDir, 'keep.txt'), 'utf-8')).toBe('keep')
        expect(fs.existsSync(path.join(tempDir, 'sub'))).toBe(true)
      }
    })

    test('still deletes what is inside the working directory', async () => {
      fs.mkdirSync(path.join(tempDir, 'sub', 'deep'), { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'sub', 'deep', 'file.txt'), 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'delete_file',
        path: './sub/deep/..'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'sub'))).toBe(false)
      expect(fs.existsSync(tempDir)).toBe(true)
    })
  })

  describe('move_file', () => {
    test('moves file', async () => {
      const srcPath = path.join(tempDir, 'src.txt')
      fs.writeFileSync(srcPath, 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'src.txt',
        newPath: 'dst.txt'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(srcPath)).toBe(false)
      expect(fs.existsSync(path.join(tempDir, 'dst.txt'))).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'dst.txt'), 'utf-8')).toBe('content')
    })

    test('creates parent directories for destination', async () => {
      const srcPath = path.join(tempDir, 'src.txt')
      fs.writeFileSync(srcPath, 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'src.txt',
        newPath: 'subdir/dst.txt'
      })

      expect(result.success).toBe(true)
      expect(fs.existsSync(path.join(tempDir, 'subdir/dst.txt'))).toBe(true)
    })

    test('fails if destination exists', async () => {
      fs.writeFileSync(path.join(tempDir, 'src.txt'), 'content')
      fs.writeFileSync(path.join(tempDir, 'dst.txt'), 'existing')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'src.txt',
        newPath: 'dst.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('already exists')
    })

    test('fails if source not found', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'notfound.txt',
        newPath: 'dst.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    test('refuses to move the working directory itself', async () => {
      fs.mkdirSync(path.join(tempDir, 'sub'))
      fs.writeFileSync(path.join(tempDir, 'keep.txt'), 'keep')

      for (const source of ['.', './', 'sub/..', tempDir, tempDir + path.sep]) {
        const result = await plugin.execute({ model: 'test' }, {
          action: 'move_file',
          path: source,
          newPath: 'sub/moved'
        })
        expect(result.success, source).toBe(false)
        expect(result.error, source).toContain('working directory')
        expect(fs.readFileSync(path.join(tempDir, 'keep.txt'), 'utf-8')).toBe('keep')
        expect(fs.readdirSync(path.join(tempDir, 'sub'))).toEqual([])
      }
    })

    test('refuses to move a directory into itself', async () => {
      fs.mkdirSync(path.join(tempDir, 'dir'))
      fs.writeFileSync(path.join(tempDir, 'dir', 'file.txt'), 'content')

      for (const destination of ['dir/inner', 'dir/a/b/dir', './dir/../dir/inner']) {
        const result = await plugin.execute({ model: 'test' }, {
          action: 'move_file',
          path: 'dir',
          newPath: destination
        })
        expect(result.success, destination).toBe(false)
        expect(result.error, destination).toContain('into itself')
        // nothing was moved and no destination directory was created
        expect(fs.readdirSync(path.join(tempDir, 'dir'))).toEqual(['file.txt'])
      }
    })

    test('refuses to move a file below itself', async () => {
      fs.writeFileSync(path.join(tempDir, 'src.txt'), 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'src.txt',
        newPath: 'src.txt/copy.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('into itself')
      expect(fs.readFileSync(path.join(tempDir, 'src.txt'), 'utf-8')).toBe('content')
    })

    test('moves a directory next to a name that only shares its prefix', async () => {
      fs.mkdirSync(path.join(tempDir, 'dir'))
      fs.writeFileSync(path.join(tempDir, 'dir', 'file.txt'), 'content')

      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'dir',
        newPath: 'dir-2/..dir'
      })

      expect(result.success).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'dir-2', '..dir', 'file.txt'), 'utf-8')).toBe('content')
    })
  })

  describe('run_command', () => {
    test('executes simple command', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'echo hello'
      })

      expect(result.success).toBe(true)
      expect(result.stdout).toContain('hello')
      expect(result.exitCode).toBe(0)
    })

    test('returns stderr on command error', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'ls /nonexistent_path_12345'
      })

      expect(result.success).toBe(false)
      expect(result.exitCode).not.toBe(0)
    })

    test('blocks rm command', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'rm test.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('blocked')
    })

    test('blocks mv command', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'mv a.txt b.txt'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('blocked')
    })

    test('allows command chaining with &&', async () => {
      // COMMENTED OUT: Command chaining is now allowed
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'echo a && echo b'
      })

      expect(result.success).toBe(true)
    })

    test('allows command chaining with ||', async () => {
      // COMMENTED OUT: Command chaining is now allowed
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'echo a || echo b'
      })

      expect(result.success).toBe(true)
    })

    test('allows command chaining with ;', async () => {
      // COMMENTED OUT: Command chaining is now allowed
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'echo a; echo b'
      })

      expect(result.success).toBe(true)
    })

    test('allows pipes', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'echo hello | cat'
      })

      expect(result.success).toBe(true)
      expect(result.stdout).toContain('hello')
    })

    test('validates cwd within workDir', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'pwd',
        cwd: '/etc'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid working directory')
    })

    test('uses custom cwd within workDir', async () => {
      const subdir = path.join(tempDir, 'subdir')
      fs.mkdirSync(subdir)

      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command',
        command: 'pwd',
        cwd: 'subdir'
      })

      expect(result.success).toBe(true)
      expect(result.stdout).toContain('subdir')
    })
  })

  describe('description methods', () => {
    test('getRunningDescription returns appropriate messages', () => {
      expect(plugin.getRunningDescription('', { action: 'read_file', path: 'test.txt' })).toBe('Read(test.txt)')
      expect(plugin.getRunningDescription('', { action: 'write_file', path: 'test.txt' })).toBe('Write(test.txt)')
      expect(plugin.getRunningDescription('', { action: 'delete_file', path: 'test.txt' })).toBe('Delete(test.txt)')
      expect(plugin.getRunningDescription('', { action: 'run_command', command: 'echo hi' })).toBe('Bash(echo hi)')
      expect(plugin.getRunningDescription('', { action: 'list_files', path: 'dir' })).toBe('List(dir)')
      expect(plugin.getRunningDescription('', { action: 'search', pattern: 'test', glob: '*.ts' })).toBe('Search(test, *.ts)')
      expect(plugin.getRunningDescription('', { action: 'search', pattern: 'test' })).toBe('Search(test)')
      expect(plugin.getRunningDescription('', { action: 'edit_file', path: 'test.txt' })).toBe('Edit(test.txt)')
      expect(plugin.getRunningDescription('', { action: 'create_directory', path: 'newdir' })).toBe('CreateDir(newdir)')
      expect(plugin.getRunningDescription('', { action: 'move_file', path: 'a.txt', newPath: 'b.txt' })).toContain('Move')
      // @ts-expect-error testing unknown action
      expect(plugin.getRunningDescription('', { action: 'unknown' })).toBe('Working...')
    })

    test('getRunningDescription truncates long commands', () => {
      const longCommand = 'a'.repeat(100)
      const result = plugin.getRunningDescription('', { action: 'run_command', command: longCommand })
      expect(result).toContain('...')
      expect(result.length).toBeLessThan(70)
    })

    test('getCompletedDescription returns success messages', () => {
      const successResult = { success: true, linesRead: 10, totalLines: 10 }
      expect(plugin.getCompletedDescription('', { action: 'read_file', path: 'test.txt' }, successResult)).toContain('Read')
    })

    test('getCompletedDescription returns failure messages', () => {
      const errorResult = { success: false, error: 'File not found' }
      expect(plugin.getCompletedDescription('', { action: 'read_file', path: 'test.txt' }, errorResult)).toContain('Failed')
    })

    test('getCompletedDescription for list_files success', () => {
      const result = plugin.getCompletedDescription('', { action: 'list_files', path: '.' }, {
        success: true,
        content: 'file1.txt\nfile2.txt',
        fileCount: 2
      })
      expect(result).toContain('List')
      expect(result).toContain('file1.txt')
    })

    test('getCompletedDescription for list_files failure', () => {
      const result = plugin.getCompletedDescription('', { action: 'list_files', path: '.' }, {
        success: false,
        error: 'Not a directory'
      })
      expect(result).toContain('Failed to list')
    })

    test('getCompletedDescription for search success with matches', () => {
      const result = plugin.getCompletedDescription('', { action: 'search', pattern: 'test' }, {
        success: true,
        content: 'file1.txt:1:test\nfile2.txt:5:test\nfile3.txt:10:test\nfile4.txt:15:test',
        matchCount: 4
      })
      expect(result).toContain('Search')
      expect(result).toContain('file1.txt')
      expect(result).toContain('+1 more')
    })

    test('getCompletedDescription for search success no matches', () => {
      const result = plugin.getCompletedDescription('', { action: 'search', pattern: 'test' }, {
        success: true,
        content: '',
        matchCount: 0
      })
      expect(result).toContain('No matches found')
    })

    test('getCompletedDescription for search failure', () => {
      const result = plugin.getCompletedDescription('', { action: 'search', pattern: 'test' }, {
        success: false,
        error: 'Invalid pattern'
      })
      expect(result).toContain('Search failed')
    })

    test('getCompletedDescription for edit_file', () => {
      expect(plugin.getCompletedDescription('', { action: 'edit_file', path: 'test.txt' }, {
        success: true,
        linesModified: 5
      })).toContain('Edited 5 lines')

      expect(plugin.getCompletedDescription('', { action: 'edit_file', path: 'test.txt' }, {
        success: false,
        error: 'Error'
      })).toContain('Failed to edit')
    })

    test('getCompletedDescription for write_file', () => {
      expect(plugin.getCompletedDescription('', { action: 'write_file', path: 'test.txt' }, {
        success: true,
        totalLines: 10
      })).toContain('Wrote 10 lines')

      expect(plugin.getCompletedDescription('', { action: 'write_file', path: 'test.txt' }, {
        success: false,
        error: 'Error'
      })).toContain('Failed to write')
    })

    test('getCompletedDescription for create_directory', () => {
      expect(plugin.getCompletedDescription('', { action: 'create_directory', path: 'dir' }, {
        success: true
      })).toContain('Directory created')

      expect(plugin.getCompletedDescription('', { action: 'create_directory', path: 'dir' }, {
        success: false,
        error: 'Error'
      })).toContain('Failed to create')
    })

    test('getCompletedDescription for delete_file', () => {
      expect(plugin.getCompletedDescription('', { action: 'delete_file', path: 'test.txt' }, {
        success: true
      })).toContain('File deleted')

      expect(plugin.getCompletedDescription('', { action: 'delete_file', path: 'test.txt' }, {
        success: false,
        error: 'Error'
      })).toContain('Failed to delete')
    })

    test('getCompletedDescription for move_file', () => {
      expect(plugin.getCompletedDescription('', { action: 'move_file', path: 'a.txt', newPath: 'b.txt' }, {
        success: true
      })).toContain('File moved')

      expect(plugin.getCompletedDescription('', { action: 'move_file', path: 'a.txt', newPath: 'b.txt' }, {
        success: false,
        error: 'Error'
      })).toContain('Failed to move')
    })

    test('getCompletedDescription for run_command success with output', () => {
      const result = plugin.getCompletedDescription('', { action: 'run_command', command: 'echo hi' }, {
        success: true,
        stdout: 'hello\nworld\nfoo\nbar\nbaz',
        exitCode: 0
      })
      expect(result).toContain('Bash')
      expect(result).toContain('hello')
      expect(result).toContain('more lines')
    })

    test('getCompletedDescription for run_command success no output', () => {
      const result = plugin.getCompletedDescription('', { action: 'run_command', command: 'true' }, {
        success: true,
        stdout: '',
        exitCode: 0
      })
      expect(result).toContain('Command completed (no output)')
    })

    test('getCompletedDescription for run_command failure', () => {
      const result = plugin.getCompletedDescription('', { action: 'run_command', command: 'false' }, {
        success: false,
        stderr: 'error message',
        exitCode: 1
      })
      expect(result).toContain('failed with exit code 1')
    })

    test('getCompletedDescription for run_command timeout', () => {
      const result = plugin.getCompletedDescription('', { action: 'run_command', command: 'sleep 100' }, {
        success: false,
        stderr: '',
        exitCode: 124
      })
      expect(result).toContain('timed out')
    })

    test('getCompletedDescription for unknown action', () => {
      // @ts-expect-error testing unknown action
      expect(plugin.getCompletedDescription('', { action: 'unknown' }, { success: true })).toContain('Operation completed')
      // @ts-expect-error testing unknown action
      expect(plugin.getCompletedDescription('', { action: 'unknown' }, { success: false })).toContain('Operation failed')
    })

    test('getPreparationDescription', () => {
      expect(plugin.getPreparationDescription()).toBe('Accessing filesystem...')
    })
  })

  describe('lastModified', () => {

    // A whole-second timestamp survives utimesSync unchanged, so a test can put the mtime of a
    // file back to exactly the value the plugin handed out: this is what two writes within one
    // clock tick look like, whatever the resolution of the clock
    const FIXED_TIME = new Date('2024-01-02T03:04:05.000Z')

    const run = (parameters: Record<string, unknown>) => plugin.execute({ model: 'test' }, parameters as any)

    const writeAt = (name: string, content: string, time: Date = FIXED_TIME): string => {
      const filePath = path.join(tempDir, name)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content)
      fs.utimesSync(filePath, time, time)
      return filePath
    }

    test('edit_file refuses a same-size external change that left the mtime unchanged', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'test.txt' })
      expect(read.lastModified).toBe(FIXED_TIME.getTime())

      writeAt('test.txt', 'LINE1\nLINE2')
      expect(fs.statSync(filePath).mtimeMs).toBe(read.lastModified)

      const result = await run({ action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
      expect(result.success).toBe(false)
      expect(result.error).toContain('modified')
      expect(result.error).toContain('Read the file again')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('LINE1\nLINE2')
    })

    test('write_file refuses a same-size external change that left the mtime unchanged', async () => {
      const filePath = writeAt('test.txt', 'content')
      const read = await run({ action: 'read_file', path: 'test.txt' })

      writeAt('test.txt', 'CONTENT')
      expect(fs.statSync(filePath).mtimeMs).toBe(read.lastModified)

      const result = await run({ action: 'write_file', path: 'test.txt', content: 'new content', lastModified: read.lastModified })
      expect(result.success).toBe(false)
      expect(result.error).toContain('modified')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('CONTENT')
    })

    test('refuses an external change of another size that left the mtime unchanged', async () => {
      const filePath = writeAt('test.txt', 'content')
      const read = await run({ action: 'read_file', path: 'test.txt' })

      writeAt('test.txt', 'longer content')

      for (const action of ['edit_file', 'write_file']) {
        const result = await run({ action, path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
        expect(result.success, action).toBe(false)
        expect(result.error, action).toContain('modified')
      }
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('longer content')
    })

    test('refuses when only the mtime changed', async () => {
      const filePath = writeAt('test.txt', 'content')
      const read = await run({ action: 'read_file', path: 'test.txt' })

      writeAt('test.txt', 'content', new Date(FIXED_TIME.getTime() + 1000))

      for (const action of ['edit_file', 'write_file']) {
        const result = await run({ action, path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
        expect(result.success, action).toBe(false)
        expect(result.error, action).toContain('modified')
        expect(result.error, action).toContain('2024-01-02T03:04:06.000Z')
      }
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('content')
    })

    test('accepts the value from read_file when the file is unchanged', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')

      const read = await run({ action: 'read_file', path: 'test.txt' })
      const edit = await run({ action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new\nline2')

      const again = await run({ action: 'read_file', path: 'test.txt' })
      const write = await run({ action: 'write_file', path: 'test.txt', content: 'all new', lastModified: again.lastModified })
      expect(write.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('all new')
    })

    test('accepts the value from a partial read', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2\nline3\nline4')

      const read = await run({ action: 'read_file', path: 'test.txt', start: 2, end: 3 })
      expect(read.linesRead).toBe(2)

      const edit = await run({ action: 'edit_file', path: 'test.txt', start: 4, end: 4, content: 'new4', lastModified: read.lastModified })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('line1\nline2\nline3\nnew4')
    })

    test('chains edits and writes with the value each one returns', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2\nline3')

      let { lastModified } = await run({ action: 'read_file', path: 'test.txt' })
      for (let i = 1; i <= 3; i++) {
        const edit = await run({ action: 'edit_file', path: 'test.txt', start: i, end: i, content: `edit${i}`, lastModified })
        expect(edit.success, `edit ${i}`).toBe(true)
        expect(edit.lastModified).toBe(fs.statSync(filePath).mtimeMs)
        lastModified = edit.lastModified
      }
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('edit1\nedit2\nedit3')

      const write = await run({ action: 'write_file', path: 'test.txt', content: 'written\nline', lastModified })
      expect(write.success).toBe(true)

      const edit = await run({ action: 'edit_file', path: 'test.txt', start: 2, end: 2, content: 'last', lastModified: write.lastModified })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('written\nlast')
    })

    test('refuses an external change made after its own edit', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'test.txt' })
      const edit = await run({ action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'edit1', lastModified: read.lastModified })
      expect(edit.success).toBe(true)

      // right after the edit: on most systems this write gets the very same mtime
      fs.writeFileSync(filePath, 'EDIT1\nLINE2')

      const result = await run({ action: 'edit_file', path: 'test.txt', start: 2, end: 2, content: 'edit2', lastModified: edit.lastModified })
      expect(result.success).toBe(false)
      expect(result.error).toContain('modified')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('EDIT1\nLINE2')
    })

    test('a new plugin instance accepts the value handed out by a previous one', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'test.txt' })

      const nextPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'rw' })
      const edit = await nextPlugin.execute({ model: 'test' }, {
        action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified
      })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new\nline2')

      // and so does one that names the same file differently
      const lastPlugin = new CliPlugin({ workDirPath: tempDir, workDirAccess: 'rw' })
      const write = await lastPlugin.execute({ model: 'test' }, {
        action: 'write_file', path: path.join(tempDir, '.', 'test.txt'), content: 'newer', lastModified: edit.lastModified
      })
      expect(write.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('newer')
    })

    test('refuses the mtime of a file the plugin never read', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      const lastModified = fs.statSync(filePath).mtimeMs

      for (const action of ['edit_file', 'write_file']) {
        const result = await run({ action, path: 'test.txt', start: 1, end: 1, content: 'new', lastModified })
        expect(result.success, action).toBe(false)
        expect(result.error, action).toContain('modified')
        expect(result.error, action).toContain('Read the file again')
      }
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('line1\nline2')
    })

    test('a read that fails hands out nothing to edit with', async () => {
      const filePath = writeAt('big.txt', 'x'.repeat(50000))

      const read = await run({ action: 'read_file', path: 'big.txt' })
      expect(read.success).toBe(false)
      expect(read.lastModified).toBeUndefined()

      const result = await run({ action: 'write_file', path: 'big.txt', content: 'new', lastModified: fs.statSync(filePath).mtimeMs })
      expect(result.success).toBe(false)
      expect(fs.readFileSync(filePath, 'utf-8')).toHaveLength(50000)
    })

    test('write_file still creates a missing file when given a lastModified', async () => {
      const result = await run({ action: 'write_file', path: 'missing.txt', content: 'created', lastModified: 1234567890 })

      expect(result.success).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'missing.txt'), 'utf-8')).toBe('created')

      const edit = await run({ action: 'edit_file', path: 'missing.txt', start: 1, end: 1, content: 'edited', lastModified: result.lastModified })
      expect(edit.success).toBe(true)
    })

    test('edit_file still reports a missing file when given a lastModified', async () => {
      const result = await run({ action: 'edit_file', path: 'missing.txt', start: 1, end: 1, content: 'new', lastModified: 1234567890 })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    test('works without lastModified as before', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')

      const edit = await run({ action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'new' })
      expect(edit.success).toBe(true)

      const write = await run({ action: 'write_file', path: 'test.txt', content: 'all new' })
      expect(write.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('all new')
    })

    test('refuses values that are not a timestamp with a readable error', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      await run({ action: 'read_file', path: 'test.txt' })

      for (const lastModified of [NaN, Infinity, -1, 0, 8.64e15 + 1, 'yesterday', '', null, {}]) {
        for (const action of ['edit_file', 'write_file']) {
          const result = await run({ action, path: 'test.txt', start: 1, end: 1, content: 'new', lastModified })
          expect(result.success, `${action} ${lastModified}`).toBe(false)
          expect(result.error, `${action} ${lastModified}`).toContain('modified since last read')
        }
      }
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('line1\nline2')
    })

    test('accepts the value as a numeric string', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'test.txt' })

      const edit = await run({ action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: String(read.lastModified) })
      expect(edit.success).toBe(true)

      const write = await run({ action: 'write_file', path: 'test.txt', content: 'all new', lastModified: String(edit.lastModified) })
      expect(write.success).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('all new')
    })

    test('a deleted file takes its lastModified with it', async () => {
      const filePath = writeAt('test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'test.txt' })

      expect((await run({ action: 'delete_file', path: 'test.txt' })).success).toBe(true)

      // something else puts an identical file back
      writeAt('test.txt', 'line1\nline2')
      expect(fs.statSync(filePath).mtimeMs).toBe(read.lastModified)

      const result = await run({ action: 'edit_file', path: 'test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
      expect(result.success).toBe(false)
      expect(result.error).toContain('modified')
    })

    test('a deleted directory takes the lastModified of its files with it', async () => {
      const filePath = writeAt('dir/sub/test.txt', 'line1\nline2')
      const other = writeAt('dir-other/test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'dir/sub/test.txt' })
      const readOther = await run({ action: 'read_file', path: 'dir-other/test.txt' })

      expect((await run({ action: 'delete_file', path: 'dir' })).success).toBe(true)
      writeAt('dir/sub/test.txt', 'line1\nline2')
      expect(fs.statSync(filePath).mtimeMs).toBe(read.lastModified)

      const result = await run({ action: 'edit_file', path: 'dir/sub/test.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
      expect(result.success).toBe(false)

      // a directory that only shares the name prefix is not concerned
      const edit = await run({ action: 'edit_file', path: 'dir-other/test.txt', start: 1, end: 1, content: 'new', lastModified: readOther.lastModified })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(other, 'utf-8')).toBe('new\nline2')
    })

    test('a moved file keeps its lastModified at the new path only', async () => {
      writeAt('old.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'old.txt' })

      expect((await run({ action: 'move_file', path: 'old.txt', newPath: 'sub/new.txt' })).success).toBe(true)

      // something else puts an identical file back at the old path
      writeAt('old.txt', 'line1\nline2')
      const stale = await run({ action: 'edit_file', path: 'old.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
      expect(stale.success).toBe(false)
      expect(stale.error).toContain('modified')

      const edit = await run({ action: 'edit_file', path: 'sub/new.txt', start: 1, end: 1, content: 'new', lastModified: read.lastModified })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'sub', 'new.txt'), 'utf-8')).toBe('new\nline2')
    })

    test('the files of a moved directory keep their lastModified', async () => {
      writeAt('dir/sub/test.txt', 'line1\nline2')
      const read = await run({ action: 'read_file', path: 'dir/sub/test.txt' })

      expect((await run({ action: 'move_file', path: 'dir', newPath: 'renamed' })).success).toBe(true)

      const edit = await run({ action: 'edit_file', path: 'renamed/sub/test.txt', start: 2, end: 2, content: 'new', lastModified: read.lastModified })
      expect(edit.success).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'renamed', 'sub', 'test.txt'), 'utf-8')).toBe('line1\nnew')
    })

    test('remembers a bounded number of files and forgets the oldest first', async () => {
      const count = MAX_FILE_SNAPSHOTS + 5
      const tokens: number[] = []
      for (let i = 0; i < count; i++) {
        writeAt(`file${i}.txt`, `content ${i}`)
        const read = await run({ action: 'read_file', path: `file${i}.txt` })
        tokens.push(read.lastModified!)
        expect(fileSnapshotCount()).toBeLessThanOrEqual(MAX_FILE_SNAPSHOTS)
      }
      expect(fileSnapshotCount()).toBe(MAX_FILE_SNAPSHOTS)

      // reading a file again does not add an entry
      await run({ action: 'read_file', path: `file${count - 1}.txt` })
      expect(fileSnapshotCount()).toBe(MAX_FILE_SNAPSHOTS)

      // the first files were dropped: their value is refused until they are read again
      const dropped = await run({ action: 'edit_file', path: 'file0.txt', start: 1, end: 1, content: 'new', lastModified: tokens[0] })
      expect(dropped.success).toBe(false)
      expect(dropped.error).toContain('Read the file again')
      const reread = await run({ action: 'read_file', path: 'file0.txt' })
      const retried = await run({ action: 'edit_file', path: 'file0.txt', start: 1, end: 1, content: 'new', lastModified: reread.lastModified })
      expect(retried.success).toBe(true)

      const kept = await run({ action: 'edit_file', path: `file${count - 1}.txt`, start: 1, end: 1, content: 'new', lastModified: tokens[count - 1] })
      expect(kept.success).toBe(true)
      expect(fileSnapshotCount()).toBe(MAX_FILE_SNAPSHOTS)
    })
  })

  describe('edge cases', () => {
    test('read_file requires path parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing path')
    })

    test('list_files requires path parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'list_files'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing path')
    })

    test('read_file fails on directory', async () => {
      fs.mkdirSync(path.join(tempDir, 'subdir'))
      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'subdir'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('directory')
    })

    test('read_file fails on invalid start line', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'line1\nline2')
      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'test.txt',
        start: 100
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid line number')
    })

    test('read_file rejects file too large', async () => {
      // Create a file larger than MAX_READ_FILE_CHARACTERS (40000)
      const largeContent = 'x'.repeat(50000)
      fs.writeFileSync(path.join(tempDir, 'large.txt'), largeContent)
      const result = await plugin.execute({ model: 'test' }, {
        action: 'read_file',
        path: 'large.txt'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('too large')
    })

    test('edit_file requires start and end', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'line1')
      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file',
        path: 'test.txt',
        content: 'new'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing start/end')
    })

    test('edit_file fails on invalid end line', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'line1\nline2')
      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file',
        path: 'test.txt',
        start: 1,
        end: 100,
        content: 'new'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid line number')
    })

    test('edit_file fails on missing file', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'edit_file',
        path: 'notfound.txt',
        start: 1,
        end: 1,
        content: 'new'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    test('write_file requires path parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'write_file',
        content: 'content'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing path')
    })

    test('create_directory requires path parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'create_directory'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing path')
    })

    test('create_directory fails if file exists at path', async () => {
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content')
      const result = await plugin.execute({ model: 'test' }, {
        action: 'create_directory',
        path: 'file.txt'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('File exists')
    })

    test('delete_file requires path parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'delete_file'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing path')
    })

    test('move_file requires both path and newPath', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'test.txt'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing path or newPath')
    })

    test('move_file rejects invalid newPath', async () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'content')
      const result = await plugin.execute({ model: 'test' }, {
        action: 'move_file',
        path: 'test.txt',
        newPath: '/etc/passwd'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not allowed')
    })

    test('run_command requires command parameter', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        action: 'run_command'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Missing command')
    })

    test('unknown action returns error', async () => {
      const result = await plugin.execute({ model: 'test' }, {
        // @ts-expect-error testing unknown action
        action: 'invalid_action'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown action')
    })

    test('execute catches thrown errors', async () => {
      // Simulate an error by passing an invalid path that triggers an exception
      const badPlugin = new CliPlugin({
        workDirPath: '/nonexistent/path/that/should/cause/issues',
        workDirAccess: 'rw'
      })
      const result = await badPlugin.execute({ model: 'test' }, {
        action: 'list_files',
        path: '.'
      })
      expect(result.success).toBe(false)
    })
  })
})
