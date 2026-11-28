#!/usr/bin/env node
//
// Runs the verification suites of VERIFY.md and writes a machine-readable report.
//
//   node tools/verify.mjs [suite ...] [--rebuild] [--no-build]
//
// With no suite (or "all"), every suite runs. The packaged builds the suites need are made first
// (electron-forge package) when they are missing, or always with --rebuild. Results go to
// verify-report/<suite>.json (vitest), verify-report/<suite>.details.json (what the suite measured)
// and verify-report/summary.json (everything, one entry per suite). The exit code is 0 only when
// every suite passed.
//

import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportRoot = path.join(root, 'verify-report')
const outRoot = path.join(root, 'verify-builds')
const platformArch = `${process.platform}-${process.arch}`

// suite -> the builds it needs
export const suites = {
  package: ['test', 'release', 'release-node'],
  smoke: ['test'],
  security: ['test'],
  pdf: ['test'],
  crash: ['test'],
  watcher: ['test'],
  backup: ['test'],
  mcp: ['test'],
  clipboard: [],
  sandbox: [],
  archiver: [],
  rfc6902: [],
  cli: process.platform === 'win32' ? ['release', 'release-node'] : [],
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
let selected = args.filter((a) => !a.startsWith('--'))
if (selected.length === 0 || selected.includes('all')) selected = Object.keys(suites)
const onlyBuild = selected.length === 1 && selected[0] === 'build'
if (onlyBuild) selected = []
for (const name of selected) {
  if (!suites[name]) {
    console.error(`unknown suite: ${name} (known: ${Object.keys(suites).join(', ')})`)
    process.exit(2)
  }
}

// Electron needs a display: on a Linux without one, run again under a virtual one
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.VERIFY_NO_XVFB) {
  const which = spawnSync('sh', ['-c', 'command -v xvfb-run'])
  if (which.status !== 0) {
    console.error('No display and no xvfb-run: install xvfb (apt install xvfb) or set DISPLAY')
    process.exit(2)
  }
  const res = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, VERIFY_NO_XVFB: '1' } })
  process.exit(res.status ?? 1)
}

const buildFolder = (variant) => path.join(outRoot, variant, `Witsy-${platformArch}`)

const build = (variant) => {
  const target = buildFolder(variant)
  if (fs.existsSync(target) && !flags.has('--rebuild')) {
    console.log(`[verify] build ${variant}: ${target} (kept, use --rebuild to make it again)`)
    return
  }
  if (flags.has('--no-build')) {
    throw new Error(`build ${variant} is missing and --no-build was given`)
  }
  const env = { ...process.env }
  delete env.TEST
  delete env.WITSY_CLI_RUNTIME
  if (variant === 'test') env.TEST = '1'
  if (variant === 'release-node') env.WITSY_CLI_RUNTIME = 'node'
  // no Developer ID here: package without signing and notarization (forge.config.ts)
  if (process.platform === 'darwin' && !env.IDENTIFY_DARWIN_CODE) env.WITSY_UNSIGNED = '1'
  console.log(`[verify] electron-forge package (${variant})`)
  const produced = path.join(root, 'out', `Witsy-${platformArch}`)
  fs.rmSync(produced, { recursive: true, force: true })
  execSync('npx electron-forge package', { cwd: root, env, stdio: 'inherit' })
  if (!fs.existsSync(produced)) {
    const outDir = path.join(root, 'out')
    const found = fs.existsSync(outDir) ? fs.readdirSync(outDir).join(', ') : 'no out folder'
    throw new Error(`electron-forge package ended without ${path.relative(root, produced)} (out/: ${found})`)
  }
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(produced, target)
}

const started = new Date()
const summary = {
  startedAt: started.toISOString(),
  platform: platformArch,
  os: `${process.platform} ${(await import('node:os')).release()}`,
  node: process.version,
  commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: root }).toString().trim() } catch { return null } })(),
  builds: {},
  suites: {},
}

fs.mkdirSync(reportRoot, { recursive: true })

const variants = onlyBuild ? ['test', 'release', 'release-node'] : [...new Set(selected.flatMap((s) => suites[s]))]
for (const variant of variants) {
  const t0 = Date.now()
  try {
    build(variant)
    summary.builds[variant] = { ok: true, folder: path.relative(root, buildFolder(variant)), durationMs: Date.now() - t0 }
  } catch (error) {
    summary.builds[variant] = { ok: false, error: String(error?.message || error) }
  }
}

for (const name of selected) {
  const missing = suites[name].filter((v) => !summary.builds[v]?.ok)
  const jsonFile = path.join(reportRoot, `${name}.json`)
  fs.rmSync(jsonFile, { force: true })
  fs.rmSync(path.join(reportRoot, `${name}.details.json`), { force: true })
  if (missing.length) {
    summary.suites[name] = { status: 'error', error: `build failed: ${missing.join(', ')}` }
    continue
  }
  const t0 = Date.now()
  console.log(`\n[verify] suite ${name}`)
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'vitest', 'run', '--config', 'vitest.config.verify.mjs', `tests/verify/${name}.verify.ts`,
    '--reporter=default', '--reporter=json', `--outputFile.json=${path.relative(root, jsonFile)}`,
  ], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  const entry = { status: res.status === 0 ? 'passed' : 'failed', exitCode: res.status, durationMs: Date.now() - t0 }
  try {
    const result = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    entry.tests = { total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests, skipped: result.numPendingTests + (result.numTodoTests || 0) }
    entry.failures = result.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => ({ test: a.fullName, message: (a.failureMessages || []).join('\n').split('\n')[0] })))
    entry.skippedTests = result.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'pending' || a.status === 'skipped').map((a) => a.fullName))
  } catch { /* no json: the run did not start */ }
  try { entry.details = JSON.parse(fs.readFileSync(path.join(reportRoot, `${name}.details.json`), 'utf8')) } catch { /* no details */ }
  summary.suites[name] = entry
}

summary.finishedAt = new Date().toISOString()
summary.ok = Object.values(summary.builds).every((b) => b.ok) && Object.values(summary.suites).every((s) => s.status === 'passed')
const summaryFile = path.join(reportRoot, selected.length === Object.keys(suites).length ? 'summary.json' : `summary-${onlyBuild ? 'build' : selected.join('-')}.json`)
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2))

console.log('\n[verify] results')
for (const [name, b] of Object.entries(summary.builds)) console.log(`  build ${name.padEnd(13)} ${b.ok ? 'ok' : 'FAILED ' + b.error}`)
for (const [name, s] of Object.entries(summary.suites)) {
  console.log(`  ${name.padEnd(19)} ${s.status.toUpperCase()}${s.tests ? ` (${s.tests.passed}/${s.tests.total} passed, ${s.tests.skipped} skipped)` : ''}${s.error ? ' ' + s.error : ''}`)
}
console.log(`[verify] report: ${path.relative(root, summaryFile)}`)
process.exit(summary.ok ? 0 : 1)
