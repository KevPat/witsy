//
// rfc6902 (P-06 upgrade 3.1.1 -> 5.x, through an override under @manuscripts/prosemirror-recreate-steps).
// The note editor (TiptapEditor.vue) calls recreateTransform(oldDoc, newDoc, true, true) when the markdown
// changes outside the editor, and recreateTransform diffs the two documents with rfc6902.
// recreate-steps is bundled twice, exactly like the renderer bundles it (its `module` entry, src/), once with
// rfc6902 3.1.1 and once with the version the app installs. Both run on the same corpus of edits made to
// markdown documents with the schema of the editor (StarterKit, tables, task lists, highlight, text align),
// and must give the same steps, and steps that turn the old document into the new one.
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { record, repoRoot } from './harness'

const suite = 'rfc6902'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-rfc6902-'))
const cacheV3 = path.join(os.tmpdir(), 'witsy-verify-rfc6902-v3')
const appRequire = createRequire(path.join(repoRoot, 'package.json'))
const summary: Record<string, any> = {}

const entrySource = `
import { recreateTransform } from '@manuscripts/prosemirror-recreate-steps'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import { applyPatch } from 'rfc6902'

const extensions = [
  StarterKit.configure({ link: { autolink: false } }),
  Highlight, TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TaskList, TaskItem.configure({ nested: true }),
  Table, TableRow, TableHeader, TableCell,
]
const schema = getSchema(extensions)
const markdown = new MarkdownManager({ extensions })

export const toDoc = (md) => schema.nodeFromJSON(markdown.parse(md))

export const run = (oldMd, newMd) => {
  const oldDoc = toDoc(oldMd)
  const newDoc = toDoc(newMd)
  try {
    const tr = recreateTransform(oldDoc, newDoc, true, true)
    // what the editor does: apply each step on its own transaction
    let doc = oldDoc
    for (const step of tr.steps) {
      const res = step.apply(doc)
      if (res.failed) return { steps: tr.steps.map((s) => s.toJSON()), applies: false, reaches: false, error: res.failed }
      doc = res.doc
    }
    return { steps: tr.steps.map((s) => s.toJSON()), applies: true, reaches: doc.eq(newDoc), error: null }
  } catch (e) {
    return { steps: null, applies: false, reaches: false, error: String(e && e.message || e) }
  }
}

export const pollute = () => {
  // the documents never hold such keys, this is the library on its own
  const target = {}
  let error = null
  try { applyPatch(target, [{ op: 'add', path: '/__proto__/polluted', value: 'yes' }]) } catch (e) { error = String(e.message || e) }
  try { applyPatch(target, [{ op: 'add', path: '/constructor/prototype/polluted2', value: 'yes' }]) } catch (e) { error = String(e.message || e) }
  const polluted = ({}).polluted === 'yes' || ({}).polluted2 === 'yes'
  delete Object.prototype.polluted
  delete Object.prototype.polluted2
  return { polluted, error }
}
`

const bundle = async (name: string, rfc6902Dir: string): Promise<string> => {
  const esbuild = appRequire('esbuild')
  const entry = path.join(repoRoot, 'tests', 'verify', `.rfc6902-entry-${process.pid}.mjs`)
  fs.writeFileSync(entry, entrySource)
  const outfile = path.join(work, `${name}.cjs`)
  try {
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
      // the renderer build (vite) takes the `module` entry of recreate-steps: src/, which imports rfc6902
      mainFields: ['module', 'main'],
      alias: { rfc6902: rfc6902Dir },
    })
  } finally {
    fs.rmSync(entry, { force: true })
  }
  return outfile
}

// seeded edits, like the ones the markdown of a note gets from outside the editor
const prng = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const words = ['alpha', 'beta', 'gamma', 'delta', 'witsy', 'note', 'agent', 'quick', 'brown', 'fox', 'été', 'naïve', '日本', 'emoji😀', 'x', 'lorem', 'ipsum']
const makeBlocks = (rnd: () => number): string[] => {
  const w = (n: number) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ')
  const kinds = [
    () => `# ${w(3)}`, () => `## ${w(2)}`, () => `### ${w(4)}`,
    () => w(12), () => `${w(3)} **${w(2)}** ${w(2)} *${w(1)}* \`${w(1)}\` ${w(3)}`,
    () => `${w(2)} [${w(2)}](https://example.com/${Math.floor(rnd() * 99)}) ${w(2)} ==${w(1)}==`,
    () => `- ${w(3)}\n- ${w(2)}\n  - ${w(2)}\n- ${w(4)}`,
    () => `1. ${w(3)}\n2. ${w(2)}\n3. ${w(1)}`,
    () => `- [ ] ${w(3)}\n- [x] ${w(2)}`,
    () => `> ${w(8)}`,
    () => '```js\nconst ' + words[Math.floor(rnd() * 5)] + ' = ' + Math.floor(rnd() * 100) + '\n```',
    () => `| ${w(1)} | ${w(1)} |\n| --- | --- |\n| ${w(2)} | ${w(1)} |\n| ${w(1)} | ${w(2)} |`,
    () => '---',
  ]
  return Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => kinds[Math.floor(rnd() * kinds.length)]())
}

const edit = (blocks: string[], rnd: () => number): { kind: string, blocks: string[] } => {
  const b = [...blocks]
  // an edit of an empty document starts by typing a paragraph
  if (b.length === 0) b.push(words.slice(0, 3).join(' '))
  const i = Math.floor(rnd() * b.length)
  const pick = () => words[Math.floor(rnd() * words.length)]
  const ops: Record<string, () => void> = {
    'insert word': () => { const parts = b[i].split(' '); parts.splice(1 + Math.floor(rnd() * Math.max(1, parts.length - 1)), 0, pick()); b[i] = parts.join(' ') },
    'delete word': () => { const parts = b[i].split(' '); if (parts.length > 2) parts.splice(1 + Math.floor(rnd() * (parts.length - 1)), 1); b[i] = parts.join(' ') },
    'replace word': () => { const parts = b[i].split(' '); parts[parts.length - 1] = pick(); b[i] = parts.join(' ') },
    'type characters': () => { b[i] = b[i] + pick().slice(0, 2) },
    'bold a word': () => { b[i] = b[i].replace(/(\s)([^\s*`|#>-]+)(\s|$)/, '$1**$2**$3') },
    'unbold': () => { b[i] = b[i].replace(/\*\*/g, '') },
    'insert block': () => { b.splice(i, 0, makeBlocks(rnd)[0]) },
    'delete block': () => { if (b.length > 1) b.splice(i, 1) },
    'move block': () => { if (b.length > 1) { const [x] = b.splice(i, 1); b.splice(Math.floor(rnd() * b.length), 0, x) } },
    'split paragraph': () => { const parts = b[i].split(' '); if (parts.length > 3) { const k = Math.floor(parts.length / 2); b.splice(i, 1, parts.slice(0, k).join(' '), parts.slice(k).join(' ')) } },
    'join blocks': () => { if (i + 1 < b.length) b.splice(i, 2, `${b[i]} ${b[i + 1]}`) },
    'heading level': () => { b[i] = b[i].startsWith('#') ? b[i].replace(/^#+/, (h) => h.length < 3 ? h + '#' : '#') : `## ${b[i].replace(/^[-*>\d. ]+/, '')}` },
    'list item': () => { b[i] = b[i] + `\n- ${pick()} ${pick()}` },
    'toggle task': () => { b[i] = b[i].includes('[ ]') ? b[i].replace('[ ]', '[x]') : b[i].replace('[x]', '[ ]') },
    'table cell': () => { b[i] = b[i].includes('|') ? b[i].replace(/\| ([^|-]+) \|$/m, `| ${pick()} |`) : b[i] },
    'replace all': () => { b.splice(0, b.length, ...makeBlocks(rnd)) },
    'empty document': () => { b.splice(0, b.length) },
    'several edits': () => { for (let k = 0; k < 3; k++) { const r = edit(b, rnd); b.splice(0, b.length, ...r.blocks) } },
  }
  const kinds = Object.keys(ops)
  const kind = kinds[Math.floor(rnd() * kinds.length)]
  ops[kind]()
  return { kind, blocks: b }
}

let oldLib: any
let newLib: any
let newVersion = ''

beforeAll(async () => {
  if (!fs.existsSync(path.join(cacheV3, 'node_modules', 'rfc6902', 'package.json'))) {
    fs.mkdirSync(cacheV3, { recursive: true })
    fs.writeFileSync(path.join(cacheV3, 'package.json'), '{"name":"rfc6902-v3-cache","private":true}')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const res = spawnSync(npm, ['install', 'rfc6902@3.1.1', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', cacheV3], { encoding: 'utf8', shell: process.platform === 'win32' })
    if (res.status !== 0) throw new Error(`cannot fetch rfc6902 3.1.1: ${res.stderr}`)
  }
  const v3Dir = path.join(cacheV3, 'node_modules', 'rfc6902')
  expect(JSON.parse(fs.readFileSync(path.join(v3Dir, 'package.json'), 'utf8')).version).toBe('3.1.1')
  // the copy recreate-steps gets in the app, after the override
  const recreateRequire = createRequire(appRequire.resolve('@manuscripts/prosemirror-recreate-steps/package.json'))
  const newDir = path.dirname(recreateRequire.resolve('rfc6902/package.json'))
  newVersion = JSON.parse(fs.readFileSync(path.join(newDir, 'package.json'), 'utf8')).version
  const req = createRequire(import.meta.url)
  oldLib = req(await bundle('with-rfc6902-3', v3Dir))
  newLib = req(await bundle('with-rfc6902-new', newDir))
  summary.versions = { old: '3.1.1', new: newVersion }
}, 600000)

afterAll(() => {
  record(suite, summary)
  fs.rmSync(work, { recursive: true, force: true })
})

test('the app installs rfc6902 5 for recreate-steps', () => {
  expect(newVersion.startsWith('5.')).toBe(true)
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  expect(pkg.overrides['@manuscripts/prosemirror-recreate-steps'].rfc6902).toMatch(/^\^5\./)
})

test('recreateTransform gives the same steps with rfc6902 3 and 5 on a corpus of edits', () => {
  const pairs = 600
  const stats = { pairs: 0, identicalSteps: 0, differentSteps: 0, totalSteps: 0, newReaches: 0, oldReaches: 0, newThrows: 0, oldThrows: 0, sameOutcome: 0, byKind: {} as Record<string, number> }
  const differences: any[] = []
  const errors: Record<string, number> = {}
  const unreached: any[] = []
  for (let seed = 1; seed <= pairs; seed++) {
    const rnd = prng(seed)
    const before = makeBlocks(rnd)
    const { kind, blocks } = edit(before, rnd)
    const oldMd = before.join('\n\n')
    const newMd = blocks.join('\n\n')
    const a = oldLib.run(oldMd, newMd)
    const b = newLib.run(oldMd, newMd)
    stats.pairs++
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1
    if (a.reaches) stats.oldReaches++
    if (b.reaches) stats.newReaches++
    if (a.steps === null) stats.oldThrows++
    if (b.steps === null) stats.newThrows++
    stats.totalSteps += b.steps?.length ?? 0
    const same = JSON.stringify(a.steps) === JSON.stringify(b.steps)
    if (same) stats.identicalSteps++
    else {
      stats.differentSteps++
      if (differences.length < 10) differences.push({ seed, kind, old: a, new: b, oldMd, newMd })
    }
    if (same && a.reaches === b.reaches && a.error === b.error) stats.sameOutcome++
    // the editor falls back to setContent on a throw: same for both, but worth reading
    if (b.error) errors[b.error] = (errors[b.error] || 0) + 1
    else if (!b.reaches) { errors['steps do not reach the new document'] = (errors['steps do not reach the new document'] || 0) + 1; if (unreached.length < 5) unreached.push({ seed, kind, oldMd, newMd }) }
  }
  summary.corpus = stats
  summary.differenceSamples = differences
  summary.newLibraryFailures = errors
  summary.unreachedSamples = unreached
  expect(stats.differentSteps).toBe(0)
  expect(stats.sameOutcome).toBe(pairs)
  // the new library is not worse at its job: every edit the old one handled is handled
  expect(stats.newReaches).toBeGreaterThanOrEqual(stats.oldReaches)
}, 600000)

test('rfc6902 5 does not let a patch reach Object.prototype (3.1.1 does)', () => {
  // in a child process each, so this process is not polluted by the old library
  const probe = (lib: string) => {
    const res = spawnSync(process.execPath, ['-e', `const r = require(${JSON.stringify(lib)}).pollute(); console.log(JSON.stringify(r))`], { encoding: 'utf8' })
    return JSON.parse(res.stdout.trim().split('\n').pop() || '{}')
  }
  const oldProbe = probe(path.join(work, 'with-rfc6902-3.cjs'))
  const newProbe = probe(path.join(work, 'with-rfc6902-new.cjs'))
  summary.prototypePollution = { old: oldProbe, new: newProbe }
  expect(newProbe.polluted).toBe(false)
})
