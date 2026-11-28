//
// archiver (P-06 upgrade 7 -> 8): the zip files the app writes are the same with archiver 8.
// The same inputs go through archiver 7.0.1 (fetched into a temporary folder, never a dependency of
// the app) and archiver 8 (the app's), with the calls backup.ts makes: append of texts and buffers,
// file, directory with an entry filter, zlib level 9. For every entry the name, kind, size, CRC,
// compression method, date and mode are compared, then both zips are extracted and compared byte
// for byte, and checked by unzip -t when it is installed.
// The backup suite then checks a backup made by the packaged app with archiver 8.
//

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { commandExists, record, repoRoot, walkFiles } from './harness'

const suite = 'archiver'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-archiver-'))
const cacheV7 = path.join(os.tmpdir(), 'witsy-verify-archiver7')
const fixedDate = new Date('2026-01-02T03:04:06Z')
const summary: Record<string, any> = {}
const appRequire = createRequire(path.join(repoRoot, 'package.json'))

const loadV7 = () => {
  if (!fs.existsSync(path.join(cacheV7, 'node_modules', 'archiver', 'package.json'))) {
    fs.mkdirSync(cacheV7, { recursive: true })
    fs.writeFileSync(path.join(cacheV7, 'package.json'), '{"name":"archiver7-cache","private":true}')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const res = spawnSync(npm, ['install', 'archiver@7.0.1', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', cacheV7], { encoding: 'utf8', shell: process.platform === 'win32' })
    if (res.status !== 0) throw new Error(`cannot fetch archiver 7.0.1: ${res.stderr}`)
  }
  const req = createRequire(path.join(cacheV7, 'package.json'))
  expect(req('archiver/package.json').version).toBe('7.0.1')
  const archiver = req('archiver')
  return (opts: any) => archiver('zip', opts)
}

const loadV8 = async () => {
  const mod: any = await import('archiver')
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'archiver', 'package.json'), 'utf8')).version
  return { make: (opts: any) => new mod.ZipArchive(opts), version }
}

const prng = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

// a folder like the user data of the app, with the odd cases a zip writer can get wrong
const makeCorpus = (seed: number): string => {
  const rnd = prng(seed)
  const root = path.join(work, `corpus-${seed}`)
  const names = ['settings.json', 'résumé.txt', '日本語.md', 'emoji 😀.json', 'with space.txt', '.hidden', 'UPPER.TXT']
  const write = (rel: string, data: Buffer | string) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, data)
    fs.utimesSync(full, fixedDate, fixedDate)
  }
  write('settings.json', JSON.stringify({ general: { locale: 'fr' }, seed }, null, 2))
  write('empty.bin', Buffer.alloc(0))
  write('one.bin', Buffer.from([seed & 0xff]))
  write('hex-64k.txt', crypto.createHash('sha512').update(String(seed)).digest().toString('hex').repeat(512).slice(0, 65536))
  const big = Buffer.alloc(2 * 1024 * 1024)
  for (let i = 0; i < big.length; i++) big[i] = Math.floor(rnd() * 256)
  write('random-2mb.bin', big)
  write('text-5mb.txt', 'the same line again and again\n'.repeat(180000))
  for (let i = 0; i < 40; i++) {
    const depth = 1 + Math.floor(rnd() * 4)
    const parts = Array.from({ length: depth }, () => names[Math.floor(rnd() * names.length)].replace(/\./g, '_'))
    const size = Math.floor(rnd() * 20000)
    write(path.join('workspaces', ...parts, `${i}-${names[i % names.length]}`), Buffer.from(Array.from({ length: size }, () => 32 + Math.floor(rnd() * 90))))
  }
  fs.mkdirSync(path.join(root, 'workspaces', 'empty-folder'), { recursive: true })
  write(path.join('workspaces', 'w1', 'workspace.json'), '{"uuid":"w1","name":"left out by the filter"}')
  if (process.platform !== 'win32') {
    write('script.sh', '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(root, 'script.sh'), 0o755)
    fs.utimesSync(path.join(root, 'script.sh'), fixedDate, fixedDate)
  }
  return root
}

// the calls of backup.ts, on one archiver
const writeZip = async (make: (opts: any) => any, corpus: string, target: string) => {
  const output = fs.createWriteStream(target)
  const archive = make({ zlib: { level: 9 } })
  const closed = new Promise<void>((resolve, reject) => { output.on('close', () => resolve()); archive.on('error', reject); output.on('error', reject) })
  archive.pipe(output)
  archive.append(JSON.stringify({ stripped: true }, null, 2), { name: 'settings.json', date: fixedDate })
  archive.append(Buffer.from('buffer entry é'), { name: 'buffer.txt', date: fixedDate })
  archive.file(path.join(corpus, 'random-2mb.bin'), { name: 'engines/random-2mb.bin' })
  archive.file(path.join(corpus, 'empty.bin'), { name: 'engines/empty.bin' })
  archive.directory(path.join(corpus, 'workspaces'), 'workspaces', (entry: any) => /(^|\/)workspace\.json$/.test(String(entry.name).replace(/\\/g, '/')) ? false : entry)
  archive.directory(corpus, 'all')
  archive.append('{"kept":"by append"}', { name: 'workspaces/w1/workspace.json', date: fixedDate })
  await archive.finalize()
  await closed
  return archive.pointer()
}

type Entry = { name: string, dir: boolean, size: number, crc: number, method: number, date: string, attrs: number, sha: string }

const readEntries = async (zip: string): Promise<Entry[]> => {
  // yauzl is what extract-zip, and so the restore of the app, reads zips with
  const yauzl = createRequire(appRequire.resolve('extract-zip'))('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(zip, { lazyEntries: true, decodeStrings: true }, (err: any, zipfile: any) => {
      if (err) return reject(err)
      const entries: Entry[] = []
      zipfile.on('entry', (e: any) => {
        const base = { name: e.fileName, dir: /\/$/.test(e.fileName), size: e.uncompressedSize, crc: e.crc32, method: e.compressionMethod, date: e.getLastModDate().toISOString(), attrs: e.externalFileAttributes >>> 16 }
        if (base.dir) { entries.push({ ...base, sha: '' }); zipfile.readEntry(); return }
        zipfile.openReadStream(e, (err2: any, stream: any) => {
          if (err2) return reject(err2)
          const hash = crypto.createHash('sha256')
          stream.on('data', (d: Buffer) => hash.update(d))
          stream.on('end', () => { entries.push({ ...base, sha: hash.digest('hex') }); zipfile.readEntry() })
          stream.on('error', reject)
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

const extractTree = async (zip: string, dest: string): Promise<Record<string, string>> => {
  const extractZip = appRequire('extract-zip')
  await extractZip(zip, { dir: dest })
  const tree: Record<string, string> = {}
  for (const f of walkFiles(dest)) tree[path.relative(dest, f).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  return tree
}

let v7: (opts: any) => any
let v8: { make: (opts: any) => any, version: string }

beforeAll(async () => {
  v7 = loadV7()
  v8 = await loadV8()
  summary.versions = { old: '7.0.1', new: v8.version }
}, 600000)

afterAll(() => {
  record(suite, summary)
  fs.rmSync(work, { recursive: true, force: true })
})

describe.each([1, 2, 3])('corpus %i', (seed) => {
  test('archiver 8 writes the same entries, contents and metadata as archiver 7', async () => {
    expect(v8.version.startsWith('8.')).toBe(true)
    const corpus = makeCorpus(seed)
    const zip7 = path.join(work, `v7-${seed}.zip`)
    const zip8 = path.join(work, `v8-${seed}.zip`)
    const bytes7 = await writeZip(v7, corpus, zip7)
    const bytes8 = await writeZip(v8.make, corpus, zip8)
    const [e7, e8] = [await readEntries(zip7), await readEntries(zip8)]
    const by7 = new Map(e7.map((e) => [e.name, e]))
    const differences: any[] = []
    for (const e of e8) {
      const o = by7.get(e.name)
      if (!o) { differences.push({ name: e.name, only: 'v8' }); continue }
      for (const field of ['dir', 'size', 'crc', 'method', 'date', 'attrs', 'sha'] as const) {
        if (o[field] !== e[field]) differences.push({ name: e.name, field, v7: o[field], v8: e[field] })
      }
    }
    for (const e of e7) if (!e8.find((x) => x.name === e.name)) differences.push({ name: e.name, only: 'v7' })
    const identicalBytes = fs.readFileSync(zip7).equals(fs.readFileSync(zip8))
    const sameOrder = e7.map((e) => e.name).join('\n') === e8.map((e) => e.name).join('\n')
    // both extract to the same files, byte for byte (extract-zip with the patch of the app)
    const t7 = await extractTree(zip7, path.join(work, `x7-${seed}`))
    const t8 = await extractTree(zip8, path.join(work, `x8-${seed}`))
    let unzipT: string | null = null
    if (commandExists('unzip')) {
      const a = spawnSync('unzip', ['-tq', zip7], { encoding: 'utf8' })
      const b = spawnSync('unzip', ['-tq', zip8], { encoding: 'utf8' })
      unzipT = `v7 exit ${a.status}, v8 exit ${b.status}`
      expect(a.status).toBe(0)
      expect(b.status).toBe(0)
    }
    summary[`corpus${seed}`] = { entries: e8.length, extractedFiles: Object.keys(t8).length, differences: differences.length, differenceSamples: differences.slice(0, 10), identicalBytes, sameOrder, zipBytes: { v7: bytes7, v8: bytes8 }, unzipT }
    expect(differences).toEqual([])
    expect(t8).toEqual(t7)
    expect(e8.length).toBeGreaterThan(80)
  }, 600000)
})

test('the app bundles archiver 8 into its main process (it is an ES module only)', () => {
  const config = fs.readFileSync(path.join(repoRoot, 'vite.main.config.ts'), 'utf8')
  expect(config).toMatch(/dependency !== 'archiver'/)
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'backup.ts'), 'utf8')
  expect(source).toMatch(/new ZipArchive\(/)
})
