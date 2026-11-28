import { afterEach, beforeEach, expect, test } from 'vitest'
import archiver from 'archiver'
import extractZip from 'extract-zip'
import fs from 'fs'
import os from 'os'
import path from 'path'

// patches/extract-zip+2.0.1.patch (P-06): extract-zip 2.0.1 has no upstream fix for
// GHSA-jmr9-qjv8-65gv / GHSA-7pqw-9j4j-h8q3. Backups and skill archives must never
// create links, so a link entry cannot redirect a later entry outside the target.

let root: string

const makeZip = async (zipPath: string, build: (archive: archiver.Archiver) => void) => {
  const output = fs.createWriteStream(zipPath)
  const archive = archiver('zip')
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    archive.on('error', reject)
  })
  archive.pipe(output)
  build(archive)
  await archive.finalize()
  await done
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-unzip-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('extracts regular files and folders', async () => {
  const zip = path.join(root, 'ok.zip')
  await makeZip(zip, (archive) => {
    archive.append('hello', { name: 'skill/SKILL.md' })
    archive.append('world', { name: 'skill/docs/readme.txt' })
  })
  const dir = path.join(root, 'out')
  await extractZip(zip, { dir })
  expect(fs.readFileSync(path.join(dir, 'skill/SKILL.md'), 'utf8')).toBe('hello')
  expect(fs.readFileSync(path.join(dir, 'skill/docs/readme.txt'), 'utf8')).toBe('world')
})

test('does not create symlink entries and keeps later entries inside the target', async () => {
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  const zip = path.join(root, 'evil.zip')
  await makeZip(zip, (archive) => {
    archive.symlink('link', outside)
    archive.append('pwned', { name: 'link/evil.txt' })
    archive.append('fine', { name: 'normal.txt' })
  })
  const dir = path.join(root, 'out')
  await extractZip(zip, { dir })
  expect(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink()).toBe(false)
  expect(fs.readFileSync(path.join(dir, 'link/evil.txt'), 'utf8')).toBe('pwned')
  expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false)
  expect(fs.readFileSync(path.join(dir, 'normal.txt'), 'utf8')).toBe('fine')
})
