
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import CliPlugin from '@/main/cli_plugin'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { bug, isPosix } from './bug'

// true when child is base itself or sits below it
const isInside = (base: string, child: string): boolean => {
  const rel = path.relative(base, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

describe('CliPlugin path confinement', () => {

  let root: string
  let workDir: string
  let outside: string
  let plugin: CliPlugin

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-plugin-stress-'))
    workDir = path.join(root, 'proj')
    outside = path.join(root, 'proj-secrets')
    fs.mkdirSync(workDir)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET')
    plugin = new CliPlugin({ workDirPath: workDir, workDirAccess: 'rw' })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('fuzz: relative paths made of dot segments never resolve outside the working directory', () => {
    const rand = mulberry32(20261127)
    const segments = ['..', '.', 'a', 'b c', 'd.txt', '...', '..a', 'a..', 'é', '%2e%2e', '~', '-rf']
    for (let i = 0; i < 2000; i++) {
      const len = 1 + Math.floor(rand() * 8)
      const parts: string[] = []
      for (let j = 0; j < len; j++) parts.push(segments[Math.floor(rand() * segments.length)])
      const candidate = parts.join(rand() < 0.5 ? '/' : path.sep)
      const validated = plugin.validatePath(candidate)
      if (validated !== null) {
        expect(isInside(workDir, validated), `"${candidate}" resolved to ${validated}`).toBe(true)
      }
    }
  // 2,000 real path resolutions: over the default 5 seconds on Windows when the whole suite runs in parallel
  }, 60000)

  test('fuzz: absolute paths outside the root are rejected', () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 500; i++) {
      const depth = 1 + Math.floor(rand() * 5)
      const parts = Array.from({ length: depth }, () => Math.floor(rand() * 1e6).toString(36))
      const candidate = path.join(path.parse(workDir).root, ...parts)
      expect(plugin.validatePath(candidate)).toBeNull()
    }
  })

  test('sibling directory sharing the working directory prefix is rejected', () => {
    // workDir = <root>/proj, target = <root>/proj-secrets/secret.txt
    expect(plugin.validatePath(path.join(outside, 'secret.txt'))).toBeNull()
  })

  test('read_file cannot read a sibling directory through a relative path', async () => {
    const result = await plugin.execute({ model: 'test' }, { action: 'read_file', path: '../proj-secrets/secret.txt' })
    expect(result.success).toBe(false)
    expect(result.content || '').not.toContain('TOP SECRET')
  })

  test('write_file cannot create files in a sibling directory', async () => {
    await plugin.execute({ model: 'test' }, { action: 'write_file', path: '../proj-secrets/planted.txt', content: 'x' })
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false)
  })

  test('delete_file cannot delete a sibling directory', async () => {
    await plugin.execute({ model: 'test' }, { action: 'delete_file', path: '../proj-secrets' })
    expect(fs.existsSync(outside)).toBe(true)
  })

  bug('delete_file refuses to delete the working directory itself', async () => {
    fs.writeFileSync(path.join(workDir, 'keep.txt'), 'keep')
    const result = await plugin.execute({ model: 'test' }, { action: 'delete_file', path: '.' })
    expect(result.success).toBe(false)
    expect(fs.existsSync(path.join(workDir, 'keep.txt'))).toBe(true)
  })

  test('move_file cannot move the working directory into a sibling directory', async () => {
    fs.writeFileSync(path.join(workDir, 'keep.txt'), 'keep')
    await plugin.execute({ model: 'test' }, { action: 'move_file', path: '.', newPath: '../proj-secrets/stolen' })
    expect(fs.existsSync(path.join(workDir, 'keep.txt'))).toBe(true)
  })

  describe.runIf(isPosix)('symbolic links', () => {

    beforeEach(() => {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workDir, 'link.txt'))
      fs.symlinkSync(outside, path.join(workDir, 'linkdir'))
    })

    test('read_file does not follow a symlink that points outside the working directory', async () => {
      const result = await plugin.execute({ model: 'test' }, { action: 'read_file', path: 'link.txt' })
      expect(result.success).toBe(false)
      expect(result.content || '').not.toContain('TOP SECRET')
    })

    test('write_file does not write through a symlinked directory that points outside', async () => {
      await plugin.execute({ model: 'test' }, { action: 'write_file', path: 'linkdir/planted.txt', content: 'x' })
      expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false)
    })

    test('search does not return content from outside the working directory', async () => {
      const result = await plugin.execute({ model: 'test' }, { action: 'search', pattern: 'SECRET', path: 'link.txt' })
      expect(result.matchCount || 0).toBe(0)
    })

    test('delete_file on a symlinked directory removes the link, not the target contents', async () => {
      await plugin.execute({ model: 'test' }, { action: 'delete_file', path: 'linkdir' })
      expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
    })

  })

})

describe('CliPlugin read-only mode', () => {

  let workDir: string
  let plugin: CliPlugin

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-plugin-ro-'))
    fs.writeFileSync(path.join(workDir, 'data.txt'), 'original')
    plugin = new CliPlugin({ workDirPath: workDir, workDirAccess: 'ro' })
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  test('file write actions are refused', async () => {
    for (const action of ['write_file', 'edit_file', 'create_directory', 'delete_file', 'move_file'] as const) {
      const result = await plugin.execute({ model: 'test' }, {
        action, path: 'data.txt', newPath: 'moved.txt', content: 'changed', start: 1, end: 1,
      })
      expect(result.success, action).toBe(false)
    }
    expect(fs.readFileSync(path.join(workDir, 'data.txt'), 'utf-8')).toBe('original')
    expect(fs.readdirSync(workDir)).toEqual(['data.txt'])
  })

  test.runIf(isPosix)('run_command cannot modify files when access is read-only', async () => {
    await plugin.execute({ model: 'test' }, { action: 'run_command', command: 'echo changed > data.txt' })
    expect(fs.readFileSync(path.join(workDir, 'data.txt'), 'utf-8')).toBe('original')
  })

  test.runIf(isPosix)('run_command cannot delete files when access is read-only', async () => {
    // "rm" is on the deny list, "find -delete" is not
    await plugin.execute({ model: 'test' }, { action: 'run_command', command: 'find . -name data.txt -delete' })
    expect(fs.existsSync(path.join(workDir, 'data.txt'))).toBe(true)
  })

})

describe('CliPlugin edits', () => {

  let workDir: string
  let plugin: CliPlugin

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-plugin-edit-'))
    plugin = new CliPlugin({ workDirPath: workDir, workDirAccess: 'rw' })
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  test('fuzz: edit_file with arbitrary ranges never corrupts lines outside the range', async () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 300; i++) {
      const total = 1 + Math.floor(rand() * 30)
      const lines = Array.from({ length: total }, (_, n) => `line ${n + 1}`)
      const file = path.join(workDir, 'fuzz.txt')
      fs.writeFileSync(file, lines.join('\n'))
      const start = Math.floor(rand() * (total + 4)) - 1
      const end = Math.floor(rand() * (total + 4)) - 1
      const result = await plugin.execute({ model: 'test' }, { action: 'edit_file', path: 'fuzz.txt', start, end, content: 'X\nY' })
      const after = fs.readFileSync(file, 'utf-8').split('\n')
      const valid = start >= 1 && start <= total && end >= start && end <= total
      expect(result.success, `start=${start} end=${end} total=${total}`).toBe(valid)
      if (valid) {
        expect(after).toEqual([...lines.slice(0, start - 1), 'X', 'Y', ...lines.slice(end)])
      } else {
        expect(after).toEqual(lines)
      }
    }
  // 300 files written, edited and read back: over the default 5 seconds on Windows when the whole suite runs in parallel
  }, 60000)

  test('read_file tolerates out-of-range and non-integer bounds', async () => {
    fs.writeFileSync(path.join(workDir, 'a.txt'), 'one\ntwo\nthree')
    for (const [start, end] of [[0, 2], [-5, 1], [2, 1], [2, 9999], [1.5, 2.5], [Number.MAX_SAFE_INTEGER, 1]]) {
      const result = await plugin.execute({ model: 'test' }, { action: 'read_file', path: 'a.txt', start, end })
      expect(typeof result.success).toBe('boolean')
      expect(result.linesRead ?? 0).toBeLessThanOrEqual(3)
    }
  })

  bug('edit_file keeps CRLF line endings consistent', async () => {
    // files created on Windows: the edited lines come back with LF only
    fs.writeFileSync(path.join(workDir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n')
    await plugin.execute({ model: 'test' }, { action: 'edit_file', path: 'crlf.txt', start: 2, end: 2, content: 'TWO\nTWO-B' })
    const after = fs.readFileSync(path.join(workDir, 'crlf.txt'), 'utf-8')
    expect(after).toBe('one\r\nTWO\r\nTWO-B\r\nthree\r\n')
  })

  test('stress: 200 interleaved writes, edits and reads keep the file consistent', async () => {
    const expected: string[] = ['seed']
    fs.writeFileSync(path.join(workDir, 's.txt'), expected.join('\n'))
    const rand = mulberry32(99)
    for (let i = 0; i < 200; i++) {
      const line = 1 + Math.floor(rand() * expected.length)
      if (rand() < 0.5) {
        const result = await plugin.execute({ model: 'test' }, { action: 'edit_file', path: 's.txt', start: line, end: line, content: `v${i}\nw${i}` })
        expect(result.success).toBe(true)
        expected.splice(line - 1, 1, `v${i}`, `w${i}`)
      } else {
        const result = await plugin.execute({ model: 'test' }, { action: 'read_file', path: 's.txt', start: line, end: line })
        expect(result.content).toBe(`${line.toString().padStart(4, ' ')}→${expected[line - 1]}`)
      }
    }
    expect(fs.readFileSync(path.join(workDir, 's.txt'), 'utf-8')).toBe(expected.join('\n'))
  })

})
