
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isPathInside, isRealPathInside, resolveInside, resolveRealPath, safeBasename } from '@main/path_containment'

const isWindows = process.platform === 'win32'

let root: string
let base: string
let outside: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-containment-')))
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
