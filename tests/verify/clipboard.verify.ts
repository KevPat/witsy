//
// clipboard (D-22): what an automation (Prompt Anywhere, AI commands, dictation) does to the clipboard
// is undone: text, HTML and the files copied in a file manager come back.
// - tools/clipboard_files_probe.cjs in a real Electron (on Windows: copy and cut with the verbs of the
//   shell and paste with the paste verb of Explorer);
// - on Linux, the files are put on the clipboard by ANOTHER program (xclip, as a file manager does)
//   and read back by another program after the restore (what a paste in the file manager does).
//

import { describe, expect, test } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandExists, record, repoRoot, sleep } from './harness'
import { runProbe } from './probes'

const suite = 'clipboard'

test('the clipboard probe passes in a real Electron', () => {
  const res = runProbe(suite, 'clipboard_files_probe.cjs', 300000)
  record(suite, { probe: { status: res.status, passed: res.passed, failed: res.failed, log: res.log } })
  expect(res.failed).toEqual([])
  expect(res.status).toBe(0)
  expect(res.passed).toBeGreaterThan(5)
})

describe.runIf(process.platform === 'linux' && commandExists('xclip'))('Linux: another program owns and reads the clipboard', () => {

  const run = async (target: string, content: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-clip-'))
    const bundle = path.join(dir, 'clipboard_snapshot.cjs')
    const esbuild = require(path.join(repoRoot, 'node_modules', 'esbuild'))
    esbuild.buildSync({ entryPoints: [path.join(repoRoot, 'src', 'main', 'automations', 'clipboard_snapshot.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle, logLevel: 'error' })
    const main = path.join(dir, 'main.cjs')
    fs.writeFileSync(main, `
const { app, clipboard } = require('electron')
const { execFile } = require('child_process')
const { saveClipboard, restoreClipboard } = require(${JSON.stringify(bundle)})
const read = (t) => new Promise((resolve) => execFile('xclip', ['-selection', 'clipboard', '-o', '-t', t], { timeout: 5000 }, (e, out) => resolve(e ? null : out)))
app.whenReady().then(async () => {
  const result = {}
  result.before = await read(${JSON.stringify(target)})
  const snapshot = saveClipboard()
  clipboard.writeText('automation wrote this')
  result.during = await read(${JSON.stringify(target)})
  restoreClipboard(snapshot)
  result.after = await read(${JSON.stringify(target)})
  result.targets = await read('TARGETS')
  process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n')
  app.quit()
})
`)
    // another program owns the clipboard, as a file manager does after a copy
    const owner = spawn('xclip', ['-selection', 'clipboard', '-t', target, '-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
    owner.stdin.end(content)
    // wait until it serves the content (the pipe is written asynchronously: no sync call before)
    await sleep(200)
    for (let i = 0; i < 50; i++) {
      const probe = spawnSync('xclip', ['-selection', 'clipboard', '-o', '-t', target], { encoding: 'utf8', timeout: 2000 })
      if (probe.status === 0 && probe.stdout === content) break
      await sleep(100)
    }
    const electron = require(path.join(repoRoot, 'node_modules', 'electron')) as unknown as string
    const res = spawnSync(electron, [main], { encoding: 'utf8', timeout: 60000 })
    try { owner.kill() } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true })
    const line = (res.stdout || '').split('\n').find((l) => l.startsWith('RESULT '))
    if (!line) throw new Error(`no result: ${res.stdout}\n${res.stderr}`)
    return JSON.parse(line.slice(7))
  }

  test('files copied in a GNOME-style file manager come back after an automation', async () => {
    const content = 'copy\nfile:///tmp/verify-a.txt\nfile:///tmp/verify-b.txt'
    const r = await run('x-special/gnome-copied-files', content)
    record(suite, { linuxGnomeCopiedFiles: r })
    expect(r.before).toBe(content)
    expect(r.during).toBeNull()
    expect(r.after).toBe(content)
  })

  test('files copied as text/uri-list (KDE, Xfce) come back after an automation', async () => {
    const content = 'file:///tmp/verify-a.txt\r\nfile:///tmp/verify-b.txt\r\n'
    const r = await run('text/uri-list', content)
    record(suite, { linuxUriList: r })
    expect(r.before).toBe(content)
    expect(r.after?.replace(/\r?\n$/, '')).toBe(content.replace(/\r?\n$/, ''))
  })

  test('HTML copied in another program comes back after an automation', async () => {
    const content = '<b>VERIFY-HTML</b>'
    const r = await run('text/html', content)
    record(suite, { linuxHtml: r })
    expect(r.after).toContain('VERIFY-HTML')
  })
})
