
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isPathInside, isRealPathInside, resolveAllowedPath, resolveInside, resolveRealPath, safeBasename } from '@main/path_containment'

const isWindows = process.platform === 'win32'

let root: string
let base: string
let outside: string

beforeEach(() => {
  // the native version, like the code under test: on Windows the temp folder can be an 8.3 short
  // name (C:\Users\LONGNA~1\...) that only the native version expands
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-containment-')))
  base = path.join(root, 'work')
  outside = path.join(root, 'work-secret')
  fs.mkdirSync(base)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(base, 'inside.txt'), 'inside')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('isPathInside', () => {

  test('accepts the base and its children', () => {
    expect(isPathInside('/work', '/work', path.posix)).toBe(true)
    expect(isPathInside('/work/', '/work', path.posix)).toBe(true)
    expect(isPathInside('/work/a/b.txt', '/work', path.posix)).toBe(true)
    expect(isPathInside('/work/a/../b.txt', '/work/', path.posix)).toBe(true)
    expect(isPathInside('/work/..data', '/work', path.posix)).toBe(true)
  })

  test('rejects siblings that share a prefix', () => {
    expect(isPathInside('/work-secret', '/work', path.posix)).toBe(false)
    expect(isPathInside('/work-secret/file', '/work', path.posix)).toBe(false)
    expect(isPathInside('/workspace', '/work', path.posix)).toBe(false)
  })

  test('rejects parents and dot-dot escapes', () => {
    expect(isPathInside('/', '/work', path.posix)).toBe(false)
    expect(isPathInside('/work/..', '/work', path.posix)).toBe(false)
    expect(isPathInside('/work/../etc/passwd', '/work', path.posix)).toBe(false)
    expect(isPathInside('/work/a/../../etc', '/work', path.posix)).toBe(false)
  })

  test('rejects empty and NUL inputs', () => {
    expect(isPathInside('', '/work', path.posix)).toBe(false)
    expect(isPathInside('/work', '', path.posix)).toBe(false)
    expect(isPathInside('/work/a\0b', '/work', path.posix)).toBe(false)
    expect(isPathInside(undefined as unknown as string, '/work', path.posix)).toBe(false)
  })

  test('win32: rejects another drive and UNC shares', () => {
    expect(isPathInside('D:\\data\\file.txt', 'C:\\data', path.win32)).toBe(false)
    expect(isPathInside('\\\\server\\share\\file.txt', 'C:\\data', path.win32)).toBe(false)
    expect(isPathInside('C:\\data-evil\\file.txt', 'C:\\data', path.win32)).toBe(false)
    expect(isPathInside('C:\\data\\..\\Windows', 'C:\\data', path.win32)).toBe(false)
  })

  test('win32: accepts children whatever the case or separator', () => {
    expect(isPathInside('C:\\data\\file.txt', 'C:\\data', path.win32)).toBe(true)
    expect(isPathInside('c:\\DATA\\sub\\file.txt', 'C:\\data', path.win32)).toBe(true)
    expect(isPathInside('C:/data/sub/file.txt', 'C:\\data\\', path.win32)).toBe(true)
  })

})

describe('resolveRealPath', () => {

  test('resolves existing paths', () => {
    expect(resolveRealPath(path.join(base, 'inside.txt'))).toBe(path.join(base, 'inside.txt'))
  })

  test('resolves paths that do not exist yet', () => {
    expect(resolveRealPath(path.join(base, 'new', 'deep', 'file.txt'))).toBe(path.join(base, 'new', 'deep', 'file.txt'))
  })

  test.skipIf(isWindows)('follows a symlinked parent of a missing file', () => {
    fs.symlinkSync(outside, path.join(base, 'link'))
    expect(resolveRealPath(path.join(base, 'link', 'new.txt'))).toBe(path.join(outside, 'new.txt'))
  })

  test.skipIf(isWindows)('follows a dangling symlink to its target', () => {
    fs.symlinkSync(path.join(outside, 'not-yet'), path.join(base, 'dangling'))
    expect(resolveRealPath(path.join(base, 'dangling'))).toBe(path.join(outside, 'not-yet'))
  })

  test.skipIf(isWindows)('gives up on a symlink loop', () => {
    fs.symlinkSync(path.join(base, 'b'), path.join(base, 'a'))
    fs.symlinkSync(path.join(base, 'a'), path.join(base, 'b'))
    expect(() => resolveRealPath(path.join(base, 'a'))).toThrow()
  })

})

describe('isRealPathInside', () => {

  test('accepts real children', () => {
    expect(isRealPathInside(path.join(base, 'inside.txt'), base)).toBe(true)
    expect(isRealPathInside(base, base)).toBe(true)
  })

  test('rejects prefix siblings', () => {
    expect(isRealPathInside(path.join(outside, 'secret.txt'), base)).toBe(false)
  })

  test.skipIf(isWindows)('rejects a symlink that leaves the base', () => {
    fs.symlinkSync(outside, path.join(base, 'link'))
    expect(isRealPathInside(path.join(base, 'link', 'secret.txt'), base)).toBe(false)
  })

  test.skipIf(isWindows)('accepts a symlinked base', () => {
    const alias = path.join(root, 'alias')
    fs.symlinkSync(base, alias)
    expect(isRealPathInside(path.join(alias, 'inside.txt'), base)).toBe(true)
    expect(isRealPathInside(path.join(base, 'inside.txt'), alias)).toBe(true)
  })

})

describe('resolveInside', () => {

  test('resolves relative and absolute children', () => {
    expect(resolveInside(base, 'inside.txt')).toBe(path.join(base, 'inside.txt'))
    expect(resolveInside(base, path.join(base, 'inside.txt'))).toBe(path.join(base, 'inside.txt'))
    expect(resolveInside(base, 'sub/../inside.txt')).toBe(path.join(base, 'inside.txt'))
    expect(resolveInside(base, 'new/file.txt')).toBe(path.join(base, 'new', 'file.txt'))
    expect(resolveInside(base, '.')).toBe(base)
    expect(resolveInside(base + path.sep, '')).toBe(base)
  })

  test('rejects escapes', () => {
    expect(resolveInside(base, '..')).toBeNull()
    expect(resolveInside(base, '../work-secret/secret.txt')).toBeNull()
    expect(resolveInside(base, path.join(outside, 'secret.txt'))).toBeNull()
    expect(resolveInside(base, 'a/../../work-secret')).toBeNull()
    expect(resolveInside(base, isWindows ? 'C:\\Windows' : '/etc/passwd')).toBeNull()
    expect(resolveInside(base, 'a\0b')).toBeNull()
    expect(resolveInside('', 'a')).toBeNull()
  })

  test('excludeBase refuses the base itself', () => {
    expect(resolveInside(base, '.', { excludeBase: true })).toBeNull()
    expect(resolveInside(base, '', { excludeBase: true })).toBeNull()
    expect(resolveInside(base, 'sub/..', { excludeBase: true })).toBeNull()
    expect(resolveInside(base, 'inside.txt', { excludeBase: true })).toBe(path.join(base, 'inside.txt'))
  })

  test.skipIf(isWindows)('rejects symlinks that leave the base, for reads and for new files', () => {
    fs.symlinkSync(outside, path.join(base, 'link'))
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(base, 'file-link'))
    fs.symlinkSync(path.join(outside, 'created-later.txt'), path.join(base, 'dangling'))
    expect(resolveInside(base, 'link')).toBeNull()
    expect(resolveInside(base, 'link/secret.txt')).toBeNull()
    expect(resolveInside(base, 'link/new.txt')).toBeNull()
    expect(resolveInside(base, 'file-link')).toBeNull()
    expect(resolveInside(base, 'dangling')).toBeNull()
  })

  test.skipIf(isWindows)('accepts symlinks that stay inside the base', () => {
    fs.mkdirSync(path.join(base, 'real'))
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'))
    expect(resolveInside(base, 'alias/file.txt')).toBe(path.join(base, 'alias', 'file.txt'))
  })

  test.skipIf(isWindows)('excludeBase refuses a symlink back to the base', () => {
    fs.symlinkSync(base, path.join(base, 'self'))
    expect(resolveInside(base, 'self', { excludeBase: true })).toBeNull()
  })

  test.skipIf(isWindows)('lexicalOnly skips the symlink check', () => {
    fs.symlinkSync(outside, path.join(base, 'link'))
    expect(resolveInside(base, 'link/secret.txt', { lexicalOnly: true })).toBe(path.join(base, 'link', 'secret.txt'))
  })

})

describe('safeBasename', () => {

  test('keeps plain names', () => {
    expect(safeBasename('report.pdf')).toBe('report.pdf')
    expect(safeBasename('..hidden')).toBe('..hidden')
  })

  test('drops directory parts with either separator', () => {
    expect(safeBasename('../../outside.txt')).toBe('outside.txt')
    expect(safeBasename('..\\..\\outside.txt')).toBe('outside.txt')
    expect(safeBasename('/etc/passwd')).toBe('passwd')
    expect(safeBasename('C:\\Windows\\system.ini')).toBe('system.ini')
  })

  test('refuses names that are not a file name', () => {
    expect(safeBasename('')).toBeNull()
    expect(safeBasename('.')).toBeNull()
    expect(safeBasename('..')).toBeNull()
    expect(safeBasename('a/..')).toBeNull()
    expect(safeBasename('dir/')).toBeNull()
    expect(safeBasename('a\0b')).toBeNull()
    expect(safeBasename(null as unknown as string)).toBeNull()
  })

})

describe('resolveAllowedPath', () => {

  let home: string

  beforeEach(() => {
    home = path.join(root, 'home')
    fs.mkdirSync(path.join(base, 'sub'))
    fs.writeFileSync(path.join(base, 'sub', 'deep.txt'), 'deep')
    fs.mkdirSync(home)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const resolve = (target: string, allowed: string[] = [base]) => resolveAllowedPath(target, allowed, { home })

  test('accepts absolute paths inside an allowed folder, existing or not', () => {
    expect(resolve(base)).toBe(base)
    expect(resolve(base + path.sep)).toBe(base)
    expect(resolve(path.join(base, 'inside.txt'))).toBe(path.join(base, 'inside.txt'))
    expect(resolve(path.join(base, 'new', 'file.txt'))).toBe(path.join(base, 'new', 'file.txt'))
    expect(resolve(path.join(base, 'inside.txt'), [base + path.sep])).toBe(path.join(base, 'inside.txt'))
  })

  test('returns a path without dot segments', () => {
    expect(resolve(`${base}/sub/../inside.txt`)).toBe(path.join(base, 'inside.txt'))
    expect(resolve(`${base}/./sub/./deep.txt`)).toBe(path.join(base, 'sub', 'deep.txt'))
    expect(resolve('./sub/../inside.txt')).toBe(path.join(base, 'inside.txt'))
  })

  test('refuses a sibling folder that shares the prefix of an allowed folder', () => {
    expect(resolve(outside)).toBeNull()
    expect(resolve(path.join(outside, 'secret.txt'))).toBeNull()
    expect(resolve(path.join(outside, 'new.txt'))).toBeNull()
    expect(resolve('../work-secret/secret.txt')).toBeNull()
    expect(resolve(path.join(outside, 'secret.txt'), [base + path.sep])).toBeNull()
  })

  test('refuses dot-dot escapes in every spelling', () => {
    expect(resolve(`${base}/../work-secret/secret.txt`)).toBeNull()
    expect(resolve(`${base}/sub/../../work-secret/secret.txt`)).toBeNull()
    expect(resolve('../work-secret/secret.txt')).toBeNull()
    expect(resolve('work/../work-secret/secret.txt')).toBeNull()
    expect(resolve('./work/../work-secret/secret.txt')).toBeNull()
    expect(resolve('work/sub/../../work-secret/secret.txt')).toBeNull()
    expect(resolve(root)).toBeNull()
  })

  test('maps a path relative to an allowed folder when it exists', () => {
    expect(resolve('inside.txt')).toBe(path.join(base, 'inside.txt'))
    expect(resolve('sub/deep.txt')).toBe(path.join(base, 'sub', 'deep.txt'))
    expect(resolve('/sub/deep.txt')).toBe(path.join(base, 'sub', 'deep.txt'))
    expect(resolve('.')).toBe(base)
    expect(resolve('missing.txt')).toBeNull()
    expect(resolve('sub/missing.txt')).toBeNull()
  })

  test('maps a path that starts with the name of an allowed folder when it exists', () => {
    expect(resolve('work/inside.txt')).toBe(path.join(base, 'inside.txt'))
    expect(resolve('./work/sub/deep.txt')).toBe(path.join(base, 'sub', 'deep.txt'))
    expect(resolve('work')).toBe(base)
    expect(resolve('work/missing.txt')).toBeNull()
    expect(resolve('work-secret/secret.txt')).toBeNull()
  })

  test('understands both separators in a path that starts with the name of an allowed folder', () => {
    expect(resolve('work\\inside.txt')).toBe(path.join(base, 'inside.txt'))
    expect(resolve('.\\work\\sub\\deep.txt')).toBe(path.join(base, 'sub', 'deep.txt'))
    expect(resolve('work\\sub/deep.txt')).toBe(path.join(base, 'sub', 'deep.txt'))
    expect(resolve('work\\..\\work-secret\\secret.txt')).toBeNull()
  })

  test('starts relative and tilde paths at the home folder', () => {
    fs.mkdirSync(path.join(home, 'Documents'))
    fs.writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'notes')
    fs.writeFileSync(path.join(home, 'private.txt'), 'private')
    const documents = path.join(home, 'Documents')
    expect(resolve('~/Documents/notes.txt', ['~/Documents'])).toBe(path.join(documents, 'notes.txt'))
    expect(resolve('Documents/new.txt', ['~/Documents'])).toBe(path.join(documents, 'new.txt'))
    expect(resolve('Documents', [documents])).toBe(documents)
    expect(resolve('~', ['~/Documents'])).toBeNull()
    expect(resolve('~/private.txt', ['~/Documents'])).toBeNull()
    expect(resolve('private.txt', ['~/Documents'])).toBeNull()
    expect(resolve('~/Documents/../private.txt', ['~/Documents'])).toBeNull()
    expect(resolve('Documents/../private.txt', ['~/Documents'])).toBeNull()
    expect(resolve('~', ['~'])).toBe(home)
  })

  test('uses HOME when no home folder is given', () => {
    vi.stubEnv('HOME', home)
    fs.mkdirSync(path.join(home, 'Documents'))
    expect(resolveAllowedPath('~/Documents/a.txt', ['~/Documents'])).toBe(path.join(home, 'Documents', 'a.txt'))
    expect(resolveAllowedPath('Documents', ['~/Documents'])).toBe(path.join(home, 'Documents'))
    expect(resolveAllowedPath('~/other/a.txt', ['~/Documents'])).toBeNull()
    vi.unstubAllEnvs()
  })

  test('tries every allowed folder', () => {
    const second = path.join(root, 'second')
    fs.mkdirSync(second)
    fs.writeFileSync(path.join(second, 'two.txt'), 'two')
    expect(resolve(path.join(second, 'two.txt'), [base, second])).toBe(path.join(second, 'two.txt'))
    expect(resolve('two.txt', [base, second])).toBe(path.join(second, 'two.txt'))
    expect(resolve('second/two.txt', [base, second])).toBe(path.join(second, 'two.txt'))
    expect(resolve(path.join(outside, 'secret.txt'), [base, second])).toBeNull()
  })

  test('refuses everything without a usable allowed folder', () => {
    expect(resolve(path.join(base, 'inside.txt'), [])).toBeNull()
    expect(resolve(path.join(base, 'inside.txt'), [''])).toBeNull()
    expect(resolve(path.join(base, 'inside.txt'), [null as unknown as string])).toBeNull()
    expect(resolveAllowedPath(path.join(base, 'inside.txt'), undefined as unknown as string[])).toBeNull()
    expect(resolveAllowedPath(path.join(base, 'inside.txt'), base as unknown as string[])).toBeNull()
  })

  test('refuses targets that are not a path', () => {
    expect(resolve(undefined as unknown as string)).toBeNull()
    expect(resolve(null as unknown as string)).toBeNull()
    expect(resolve(42 as unknown as string)).toBeNull()
    expect(resolve(`${base}/inside.txt\0.png`)).toBeNull()
    expect(resolve('inside.txt\0')).toBeNull()
  })

  test.skipIf(isWindows)('refuses a symlink inside an allowed folder that leaves it', () => {
    fs.symlinkSync(outside, path.join(base, 'link'))
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(base, 'link.txt'))
    expect(resolve(path.join(base, 'link'))).toBeNull()
    expect(resolve(path.join(base, 'link', 'secret.txt'))).toBeNull()
    expect(resolve(path.join(base, 'link', 'new.txt'))).toBeNull()
    expect(resolve(path.join(base, 'link.txt'))).toBeNull()
    expect(resolve('link/secret.txt')).toBeNull()
    expect(resolve('link.txt')).toBeNull()
    expect(resolve('work/link/secret.txt')).toBeNull()
    expect(resolve('work/link.txt')).toBeNull()
  })

  test.skipIf(isWindows)('refuses a dangling symlink that would create a file outside', () => {
    fs.symlinkSync(path.join(outside, 'created.txt'), path.join(base, 'dangling.txt'))
    expect(resolve(path.join(base, 'dangling.txt'))).toBeNull()
  })

  test.skipIf(isWindows)('accepts a symlink that stays inside the allowed folder', () => {
    fs.symlinkSync(path.join(base, 'sub'), path.join(base, 'alias'))
    expect(resolve(path.join(base, 'alias', 'deep.txt'))).toBe(path.join(base, 'alias', 'deep.txt'))
    expect(resolve('alias/deep.txt')).toBe(path.join(base, 'alias', 'deep.txt'))
  })

  test.skipIf(isWindows)('accepts children of an allowed folder that is itself a symlink', () => {
    const alias = path.join(root, 'alias')
    fs.symlinkSync(base, alias)
    expect(resolve(path.join(alias, 'inside.txt'), [alias])).toBe(path.join(alias, 'inside.txt'))
    expect(resolve(path.join(alias, '..', 'work-secret', 'secret.txt'), [alias])).toBeNull()
  })

  test.skipIf(isWindows)('returns the real path for a link that leads into an allowed folder', () => {
    fs.symlinkSync(base, path.join(root, 'shortcut'))
    expect(resolve(path.join(root, 'shortcut', 'inside.txt'))).toBe(path.join(base, 'inside.txt'))
    expect(resolve(path.join(root, 'shortcut', '..', 'work-secret', 'secret.txt'))).toBeNull()
  })

  test('agrees with resolveInside for absolute paths', () => {
    if (!isWindows) fs.symlinkSync(outside, path.join(base, 'link'))
    const targets = [
      base, path.join(base, 'inside.txt'), path.join(base, 'new.txt'), `${base}/sub/../inside.txt`,
      outside, path.join(outside, 'secret.txt'), `${base}/../work-secret/secret.txt`, root,
      path.join(base, 'link'), path.join(base, 'link', 'secret.txt'),
    ]
    for (const target of targets) {
      expect(resolve(target), target).toBe(resolveInside(base, target))
    }
  })

  describe('case-insensitive volumes', () => {

    // what realpath does on such a volume: each segment comes back as it is spelled on disk
    const onDiskCase = (target: string): string => {
      const { root: volume } = path.parse(target)
      let current = volume
      for (const segment of target.slice(volume.length).split(path.sep).filter(Boolean)) {
        let entries: string[] = []
        try {
          entries = fs.readdirSync(current)
        } catch {
          entries = []
        }
        current = path.join(current, entries.find((entry) => entry.toLowerCase() === segment.toLowerCase()) ?? segment)
      }
      return current
    }

    beforeEach(() => {
      const lstatSync = fs.lstatSync
      const existsSync = fs.existsSync
      const native = fs.realpathSync.native
      vi.spyOn(fs, 'lstatSync').mockImplementation(((target: string) => lstatSync(onDiskCase(target))) as typeof fs.lstatSync)
      vi.spyOn(fs, 'existsSync').mockImplementation((target) => existsSync(onDiskCase(target as string)))
      vi.spyOn(fs.realpathSync, 'native').mockImplementation(((target: string) => native(onDiskCase(target))) as typeof fs.realpathSync.native)
    })

    test.skipIf(isWindows)('accepts a child spelled in another case and returns the on-disk spelling', () => {
      const shouted = path.join(root.toUpperCase(), 'WORK')
      expect(resolve(path.join(shouted, 'INSIDE.TXT'))).toBe(path.join(base, 'inside.txt'))
      expect(resolve(path.join(shouted, 'Sub', 'Deep.txt'))).toBe(path.join(base, 'sub', 'deep.txt'))
      expect(resolve(path.join(shouted, 'New', 'File.txt'))).toBe(path.join(base, 'New', 'File.txt'))
      expect(resolve(path.join(base, 'SUB', 'DEEP.TXT'))).toBe(path.join(base, 'SUB', 'DEEP.TXT'))
      expect(resolve(path.join(base, 'inside.txt'), [shouted])).toBe(path.join(base, 'inside.txt'))
    })

    test.skipIf(isWindows)('accepts relative spellings in another case', () => {
      expect(resolve('SUB/DEEP.TXT')).toBe(path.join(base, 'SUB', 'DEEP.TXT'))
      expect(resolve('Work/Sub/deep.txt')).toBe(path.join(base, 'sub', 'deep.txt'))
      expect(resolve('WORK\\INSIDE.TXT')).toBe(path.join(base, 'inside.txt'))
    })

    test.skipIf(isWindows)('still refuses what is outside', () => {
      const shouted = path.join(root.toUpperCase(), 'WORK')
      expect(resolve(path.join(root.toUpperCase(), 'WORK-SECRET', 'SECRET.TXT'))).toBeNull()
      expect(resolve(path.join(shouted, '..', 'WORK-SECRET', 'secret.txt'))).toBeNull()
      expect(resolve('WORK/../WORK-SECRET/secret.txt')).toBeNull()
      expect(resolve(root.toUpperCase())).toBeNull()
    })

  })

  test.skipIf(isWindows)('a case-sensitive volume does not treat another case as the same folder', () => {
    fs.mkdirSync(path.join(root, 'WORK'))
    fs.writeFileSync(path.join(root, 'WORK', 'inside.txt'), 'another folder')
    // skipped where the temp folder is case-insensitive: both names are then the same folder
    if (fs.readdirSync(root).includes('WORK')) {
      expect(resolve(path.join(root, 'WORK', 'inside.txt'))).toBeNull()
      expect(resolve('WORK/inside.txt')).toBeNull()
    }
  })

  describe('with Windows paths', () => {

    const kFiles = [
      'C:\\Users\\user\\Documents\\notes.txt',
      'C:\\Users\\user\\Documents\\folder\\test.txt',
      'C:\\Users\\user\\Documents-private\\tax.txt',
      'C:\\Users\\user\\.ssh\\id_rsa',
      'D:\\Documents\\notes.txt',
    ]

    const env = {
      pathImpl: path.win32,
      home: 'C:\\Users\\other',
      exists: (target: string) => kFiles.some((file) => `${file.toLowerCase()}\\`.startsWith(`${target.toLowerCase()}\\`)),
      realPath: (target: string) => target,
    }

    const allowed = ['C:\\Users\\user\\Documents']
    const win = (target: string, folders: string[] = allowed) => resolveAllowedPath(target, folders, env)

    test('accepts children whatever the separator or the case', () => {
      expect(win('C:\\Users\\user\\Documents\\notes.txt')).toBe('C:\\Users\\user\\Documents\\notes.txt')
      expect(win('C:/Users/user/Documents/notes.txt')).toBe('C:\\Users\\user\\Documents\\notes.txt')
      expect(win('c:\\users\\USER\\documents\\notes.txt')).toBe('c:\\users\\USER\\documents\\notes.txt')
      expect(win('C:\\Users\\user\\Documents\\new\\file.txt')).toBe('C:\\Users\\user\\Documents\\new\\file.txt')
      expect(win('C:\\Users\\user\\Documents\\notes.txt', ['C:/Users/user/Documents/'])).toBe('C:\\Users\\user\\Documents\\notes.txt')
    })

    test('refuses siblings, parents, other drives and shares', () => {
      expect(win('C:\\Users\\user\\Documents-private\\tax.txt')).toBeNull()
      expect(win('C:\\Users\\user\\Documents\\..\\.ssh\\id_rsa')).toBeNull()
      expect(win('C:\\Users\\user')).toBeNull()
      expect(win('C:\\')).toBeNull()
      expect(win('D:\\Documents\\notes.txt')).toBeNull()
      expect(win('\\\\server\\share\\Documents\\notes.txt')).toBeNull()
      expect(win('\\\\?\\C:\\Users\\user\\.ssh\\id_rsa')).toBeNull()
    })

    test('maps a path that starts with the name of the allowed folder with either separator', () => {
      const mapped = 'C:\\Users\\user\\Documents\\folder\\test.txt'
      expect(win('Documents\\folder\\test.txt')).toBe(mapped)
      expect(win('.\\Documents\\folder\\test.txt')).toBe(mapped)
      expect(win('Documents/folder/test.txt')).toBe(mapped)
      expect(win('./Documents/folder/test.txt')).toBe(mapped)
      expect(win('documents/folder\\test.txt')).toBe('C:\\Users\\user\\documents\\folder\\test.txt')
      expect(win('folder/test.txt')).toBe(mapped)
      expect(win('folder\\test.txt')).toBe(mapped)
    })

    test('does not let that mapping leave the allowed folder', () => {
      expect(win('Documents\\..\\.ssh\\id_rsa')).toBeNull()
      expect(win('Documents/../.ssh/id_rsa')).toBeNull()
      expect(win('./Documents/../Documents-private/tax.txt')).toBeNull()
      expect(win('Documents\\folder\\..\\..\\.ssh\\id_rsa')).toBeNull()
      expect(win('..\\Documents-private\\tax.txt')).toBeNull()
      expect(win('Documents-private\\tax.txt')).toBeNull()
    })

    test('starts tilde paths at the home folder with either separator', () => {
      expect(win('~\\Documents\\notes.txt', ['~\\Documents'])).toBe('C:\\Users\\other\\Documents\\notes.txt')
      expect(win('~/Documents/notes.txt', ['~\\Documents'])).toBe('C:\\Users\\other\\Documents\\notes.txt')
      expect(win('~\\.ssh\\id_rsa', ['~\\Documents'])).toBeNull()
    })

  })

})
