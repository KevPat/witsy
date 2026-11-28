
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { backupCorruptFile, backupFile, writeFileAtomicSync } from '@main/atomic'
import fs from 'fs'
import os from 'os'
import path from 'path'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-atomic-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('creates the file when it does not exist', () => {
  const file = path.join(dir, 'new.json')
  writeFileAtomicSync(file, '{"a":1}')
  expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":1}')
  expect(fs.readdirSync(dir)).toEqual(['new.json'])
})

test('replaces the previous content and leaves no temporary file', () => {
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, 'old')
  writeFileAtomicSync(file, 'new')
  expect(fs.readFileSync(file, 'utf-8')).toBe('new')
  expect(fs.readdirSync(dir)).toEqual(['settings.json'])
})

test('writes binary data unchanged', () => {
  const file = path.join(dir, 'data.bin')
  const data = Buffer.from([0, 255, 10, 13, 128])
  writeFileAtomicSync(file, data)
  expect(fs.readFileSync(file).equals(data)).toBe(true)
})

test('keeps the previous content when the write fails half way', () => {
  const file = path.join(dir, 'history.json')
  fs.writeFileSync(file, 'previous')
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  })
  expect(() => writeFileAtomicSync(file, 'next')).toThrow(/ENOSPC/)
  expect(fs.readFileSync(file, 'utf-8')).toBe('previous')
  expect(fs.readdirSync(dir)).toEqual(['history.json'])
})

test('keeps the previous content when the rename fails', () => {
  const file = path.join(dir, 'history.json')
  fs.writeFileSync(file, 'previous')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
  })
  expect(() => writeFileAtomicSync(file, 'next')).toThrow(/EXDEV/)
  expect(fs.readFileSync(file, 'utf-8')).toBe('previous')
  expect(fs.readdirSync(dir)).toEqual(['history.json'])
})

test.skipIf(process.platform === 'win32')('keeps the permissions of the file it replaces', () => {
  const file = path.join(dir, 'keys.json')
  fs.writeFileSync(file, 'old', { mode: 0o600 })
  writeFileAtomicSync(file, 'new')
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
})

test.skipIf(process.platform === 'win32')('writes through a symlink instead of replacing it', () => {
  const real = path.join(dir, 'real.json')
  const link = path.join(dir, 'link.json')
  fs.writeFileSync(real, 'old')
  fs.symlinkSync(real, link)
  writeFileAtomicSync(link, 'new')
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  expect(fs.readFileSync(real, 'utf-8')).toBe('new')
})

test('many successive writes always leave a complete file', () => {
  const file = path.join(dir, 'burst.json')
  for (let i = 0; i < 200; i++) {
    writeFileAtomicSync(file, JSON.stringify({ i, pad: 'x'.repeat(i * 10) }))
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).i).toBe(i)
  }
  expect(fs.readdirSync(dir)).toEqual(['burst.json'])
})

test('backupFile copies the file next to itself', () => {
  const file = path.join(dir, 'commands.json')
  fs.writeFileSync(file, 'content')
  const backup = backupFile(file)
  expect(backup).toBe(path.join(dir, 'commands.bak.json'))
  expect(fs.readFileSync(backup!, 'utf-8')).toBe('content')
  expect(fs.readFileSync(file, 'utf-8')).toBe('content')
})

test('backupFile returns null when there is nothing to copy or the copy fails', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(backupFile(path.join(dir, 'missing.json'))).toBeNull()
  const file = path.join(dir, 'commands.json')
  fs.writeFileSync(file, 'content')
  vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('EACCES') })
  expect(backupFile(file)).toBeNull()
})

test('backupCorruptFile uses a distinct timestamped name', () => {
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{ truncated')
  const backup = backupCorruptFile(file)
  expect(path.basename(backup!)).toMatch(/^settings\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
  expect(fs.readFileSync(backup!, 'utf-8')).toBe('{ truncated')
})
