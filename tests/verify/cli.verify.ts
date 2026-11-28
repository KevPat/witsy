//
// cli (Windows CLI launchers, fixall/security 1ffef6c7): bin\witsy.cmd and bin\witsy.ps1 against the
// packaged app, the way a user gets them:
// - zip install: the app folder anywhere (here behind a junction whose path has spaces, parentheses,
//   ! and %), the launcher in <app>\resources\cli\bin;
// - Squirrel install: the launchers next to app-X.Y.Z folders, the highest version (compared as
//   numbers: 1.10.0 over 1.9.0) wins, a folder that is not exactly app-<n>.<n>.<n> is never used;
// - the runtime of the build: the app binary (release), or the Node.js on the PATH (release-node),
//   with a clear error and exit 1 when there is none;
// - cmd.exe, Windows PowerShell 5.1 and PowerShell 7 (pwsh on the PATH, else a portable copy fetched
//   into the temporary folder; never installed).
// On macOS and Linux bin/witsy is checked by the package suite.
//

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFolder, record, resourcesPath } from './harness'

const suite = 'cli'
const win = process.platform === 'win32'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-cli-'))
const results: Record<string, any> = {}

// a PATH with the system only: no Node.js, no repository tools
const systemPath = () => [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
const nodeDir = path.dirname(process.execPath)

type Shell = 'cmd' | 'powershell' | 'pwsh'
let pwshExe: string | null = null

const run = (shell: Shell, launcherDir: string, args: string[], env: Record<string, string> = {}) => {
  const fullEnv = { ...process.env, PATH: systemPath(), Path: undefined, ...env } as any
  delete fullEnv.Path
  delete fullEnv.ELECTRON_RUN_AS_NODE
  let res
  if (shell === 'cmd') {
    const launcher = path.join(launcherDir, 'witsy.cmd')
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], { env: fullEnv, timeout: 60000, windowsVerbatimArguments: true, encoding: 'utf8' })
  } else {
    const exe = shell === 'pwsh' ? pwshExe! : 'powershell.exe'
    res = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(launcherDir, 'witsy.ps1'), ...args], { env: fullEnv, timeout: 60000, encoding: 'utf8' })
  }
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, error: res.error ? String(res.error) : null }
}

const junction = (target: string, link: string) => {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, 'junction')
}

const findPwsh = (): string | null => {
  const which = spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0]
  // a portable PowerShell 7 in the temporary folder (nothing is installed)
  const cache = path.join(os.tmpdir(), 'witsy-verify-pwsh')
  const exe = path.join(cache, 'pwsh.exe')
  if (fs.existsSync(exe)) return exe
  const version = '7.5.4'
  const zip = path.join(os.tmpdir(), `witsy-verify-pwsh-${version}.zip`)
  const url = `https://github.com/PowerShell/PowerShell/releases/download/v${version}/PowerShell-${version}-win-x64.zip`
  const dl = spawnSync('curl.exe', ['-sSLf', '-o', zip, url], { timeout: 300000 })
  if (dl.status !== 0) return null
  fs.mkdirSync(cache, { recursive: true })
  const ex = spawnSync('tar.exe', ['-xf', zip, '-C', cache], { timeout: 300000 })
  fs.rmSync(zip, { force: true })
  return ex.status === 0 && fs.existsSync(exe) ? exe : null
}

let zipRoot = ''
let squirrelRoot = ''
const shells: Shell[] = ['cmd', 'powershell']

beforeAll(() => {
  if (!win) return
  // zip install: the release build behind a path with odd characters
  zipRoot = path.join(work, 'Program Files (x86)', 'Witsy 100% ! & co')
  junction(buildFolder('release'), zipRoot)
  // Squirrel install: launchers next to app-* folders
  squirrelRoot = path.join(work, 'Squirrel Witsy')
  junction(buildFolder('release-node'), path.join(squirrelRoot, 'app-1.9.0'))
  junction(buildFolder('release'), path.join(squirrelRoot, 'app-1.10.0'))
  junction(buildFolder('release-node'), path.join(squirrelRoot, 'app-2.0.0-beta'))
  junction(buildFolder('release-node'), path.join(squirrelRoot, 'app-10.0'))
  for (const f of ['witsy.cmd', 'witsy.ps1']) fs.copyFileSync(path.join(resourcesPath('release'), 'cli', 'bin', f), path.join(squirrelRoot, f))
  pwshExe = findPwsh()
  if (pwshExe) shells.push('pwsh')
  results.pwsh = pwshExe ? spawnSync(pwshExe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).stdout.trim() : 'not available'
  results.windowsPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).stdout.trim()
}, 600000)

afterAll(() => {
  record(suite, results)
  // junctions only: removing them never touches the builds
  if (win) {
    for (const link of [zipRoot, ...['app-1.9.0', 'app-1.10.0', 'app-2.0.0-beta', 'app-10.0'].map((d) => path.join(squirrelRoot, d))]) {
      try { if (link) fs.rmdirSync(link) } catch { /* not made */ }
    }
  }
  fs.rmSync(work, { recursive: true, force: true })
})

describe.runIf(win)('Windows launchers on the packaged app', () => {

  test('the launchers in the app are the ones of the repository (CRLF kept for witsy.cmd)', () => {
    for (const f of ['witsy.cmd', 'witsy.ps1']) {
      const packaged = fs.readFileSync(path.join(resourcesPath('release'), 'cli', 'bin', f))
      expect(packaged.length).toBeGreaterThan(1000)
      if (f === 'witsy.cmd') expect(packaged.includes(Buffer.from('\r\n'))).toBe(true)
    }
  })

  test.each(['cmd', 'powershell', 'pwsh'] as Shell[])('zip install, %s: --help runs on the app binary, with no Node.js on the PATH', (shell) => {
    if (!shells.includes(shell)) return
    const r = run(shell, path.join(zipRoot, 'resources', 'cli', 'bin'), ['--help'])
    results[`zip-${shell}`] = { status: r.status, out: r.out.slice(0, 300) }
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/help/i)
  })

  test.each(['cmd', 'powershell', 'pwsh'] as Shell[])('Squirrel install, %s: the highest app-X.Y.Z (1.10.0, numbers) is the one run', (shell) => {
    if (!shells.includes(shell)) return
    // app-1.9.0, app-2.0.0-beta and app-10.0 are the Node.js runtime build: with no Node.js on the
    // PATH they would fail, so a success means app-1.10.0 (the app binary runtime) was chosen
    const r = run(shell, squirrelRoot, ['--help'])
    results[`squirrel-${shell}`] = { status: r.status, out: r.out.slice(0, 300) }
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/help/i)
  })

  test.each(['cmd', 'powershell', 'pwsh'] as Shell[])('WITSY_CLI_RUNTIME=node build, %s: runs on the Node.js of the PATH, exit 1 and a message without', (shell) => {
    if (!shells.includes(shell)) return
    const bin = path.join(buildFolder('release-node'), 'resources', 'cli', 'bin')
    const withNode = run(shell, bin, ['--help'], { PATH: `${nodeDir};${systemPath()}` })
    const without = run(shell, bin, ['--help'])
    results[`node-${shell}`] = { withNode: { status: withNode.status, out: withNode.out.slice(0, 200) }, without: { status: without.status, out: without.out.slice(0, 300) } }
    expect(withNode.status, withNode.out).toBe(0)
    expect(withNode.out).toMatch(/help/i)
    expect(without.status).toBe(1)
    expect(without.out).toMatch(/node/i)
  })

  test.each(['cmd', 'powershell', 'pwsh'] as Shell[])('%s: the exit code of the CLI comes back', (shell) => {
    if (!shells.includes(shell)) return
    const r = run(shell, path.join(zipRoot, 'resources', 'cli', 'bin'), ['--no-such-option-for-witsy'])
    results[`exit-${shell}`] = { status: r.status, out: r.out.slice(0, 200) }
    expect(r.status).not.toBe(0)
    expect(r.status).not.toBe(null)
  })

  test('nothing is run from the current folder', () => {
    // a fake cli.js and Witsy.exe in the current folder must be ignored
    const cwd = path.join(work, 'cwd')
    fs.mkdirSync(path.join(cwd, 'resources', 'cli'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'cli.js'), 'console.log("FROM-CWD"); process.exit(42)')
    fs.writeFileSync(path.join(cwd, 'resources', 'cli', 'cli.js'), 'console.log("FROM-CWD"); process.exit(42)')
    const launcher = path.join(zipRoot, 'resources', 'cli', 'bin', 'witsy.cmd')
    const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" --help"`], { cwd, env: { ...process.env, PATH: systemPath() } as any, timeout: 60000, windowsVerbatimArguments: true, encoding: 'utf8' })
    const out = `${res.stdout}${res.stderr}`
    expect(out).not.toMatch(/FROM-CWD/)
    expect(res.status).toBe(0)
  })
})

test.runIf(!win)('the Windows launchers are checked on Windows (bin/witsy is in the package suite)', () => {
  expect(win).toBe(false)
})
