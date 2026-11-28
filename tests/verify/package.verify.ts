//
// package (S-15, L-08 and the packaging fixes): what electron-forge package produces.
// - the fuses written in the binary of a release build, a WITSY_CLI_RUNTIME=node build and the e2e build;
// - what they do: ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect on the real binaries;
// - the release build starts and answers on its local API;
// - app.asar holds every runtime dependency the main process loads (the bundle keeps them external),
//   no development dependency and no key file;
// - the CLI launcher runs on the app binary.
//

import { describe, expect, test } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BuildVariant, executablePath, makeHome, record, repoRoot, resourcesPath, sleep, waitFor } from './harness'

const suite = 'package'
const ENABLE = 49 // '1'
const DISABLE = 48 // '0'

const fuses = async (variant: BuildVariant) => {
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses')
  const wire: any = await getCurrentFuseWire(executablePath(variant))
  const named: Record<string, string> = {}
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index === 'number') named[name] = wire[index] === ENABLE ? 'on' : wire[index] === DISABLE ? 'off' : String(wire[index])
  }
  return named
}

// runs a binary for a while in an isolated folder and returns what it printed
const runFor = async (variant: BuildVariant, args: string[], env: Record<string, string>, ms: number) => {
  const home = makeHome(`pkg-${variant}`)
  const child = spawn(executablePath(variant), [...args, `--user-data-dir=${home}`], {
    env: { ...process.env, WITSY_HOME: home, ...env } as any,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const code = await Promise.race([exited, sleep(ms).then(() => 'running' as const)])
  if (code === 'running') {
    child.kill()
    await Promise.race([exited, sleep(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  return { out, code, home }
}

describe('fuses', () => {
  test('release build: Node.js options, --inspect off; cookies encrypted; app only from app.asar; RunAsNode on (CLI)', async () => {
    const f = await fuses('release')
    record(suite, { fusesRelease: f })
    expect(f.RunAsNode).toBe('on')
    expect(f.EnableCookieEncryption).toBe('on')
    expect(f.EnableNodeOptionsEnvironmentVariable).toBe('off')
    expect(f.EnableNodeCliInspectArguments).toBe('off')
    expect(f.OnlyLoadAppFromAsar).toBe('on')
    expect(f.EnableEmbeddedAsarIntegrityValidation).toBe(process.platform === 'darwin' ? 'on' : 'off')
  })

  test('WITSY_CLI_RUNTIME=node build: RunAsNode off', async () => {
    const f = await fuses('release-node')
    record(suite, { fusesReleaseNode: f })
    expect(f.RunAsNode).toBe('off')
    expect(f.EnableNodeCliInspectArguments).toBe('off')
  })

  test('e2e build (TEST=1): only --inspect differs, so Playwright can drive it', async () => {
    const [t, r] = [await fuses('test'), await fuses('release')]
    record(suite, { fusesTest: t })
    expect(t.EnableNodeCliInspectArguments).toBe('on')
    expect({ ...t, EnableNodeCliInspectArguments: 'x' }).toEqual({ ...r, EnableNodeCliInspectArguments: 'x' })
  })
})

describe('what the fuses do on the real binaries', () => {
  test('release build: ELECTRON_RUN_AS_NODE=1 runs a script (the CLI needs it)', () => {
    const res = spawnSync(executablePath('release'), ['-e', 'process.stdout.write("RAN-AS-NODE " + process.versions.node)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 })
    const out = String(res.stdout)
    record(suite, { runAsNodeRelease: out.trim() })
    expect(out).toContain('RAN-AS-NODE')
  })

  test('WITSY_CLI_RUNTIME=node build: ELECTRON_RUN_AS_NODE=1 does not run a script', async () => {
    const res = await runFor('release-node', ['-e', 'process.stdout.write("RAN-AS-NODE")'], { ELECTRON_RUN_AS_NODE: '1' }, 8000)
    record(suite, { runAsNodeReleaseNode: res.out.includes('RAN-AS-NODE') ? 'ran' : 'not run' })
    expect(res.out).not.toContain('RAN-AS-NODE')
  })

  test('release build: NODE_OPTIONS cannot load code into the app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-nodeopts-'))
    const marker = path.join(dir, 'marker.txt')
    const script = path.join(dir, 'inject.js')
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'injected')`)
    const res = await runFor('release', [], { NODE_OPTIONS: `--require "${script}"` }, 10000)
    record(suite, { nodeOptionsInjected: fs.existsSync(marker) })
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(res.home, { recursive: true, force: true })
  })

  test('release build: --inspect opens no debugger, the e2e build does', async () => {
    const release = await runFor('release', ['--inspect=127.0.0.1:0'], {}, 10000)
    const testBuild = await runFor('test', ['--inspect=127.0.0.1:0'], {}, 10000)
    record(suite, { inspectRelease: /Debugger listening/.test(release.out), inspectTestBuild: /Debugger listening/.test(testBuild.out) })
    expect(release.out).not.toMatch(/Debugger listening/)
    expect(testBuild.out).toMatch(/Debugger listening/)
  })
})

test('the release build starts and answers on its local API', async () => {
  const home = makeHome('pkg-start')
  const port = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).general.httpPort
  const child = spawn(executablePath('release'), [`--user-data-dir=${home}`], { env: { ...process.env, WITSY_HOME: home } as any, stdio: 'ignore' })
  try {
    const health = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      return r.ok ? await r.text() : null
    }, 60000, 500)
    record(suite, { releaseHealth: health.slice(0, 200) })
    expect(health).toBeTruthy()
    // the window loaded: the main log says so and no exception was logged
    const log = fs.readFileSync(path.join(home, 'logs', 'main.log'), 'utf8')
    expect(log).not.toMatch(/Uncaught Exception|Cannot find module/)
  } finally {
    child.kill()
    await sleep(2000)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

describe('app.asar', () => {
  const list = async (variant: BuildVariant) => {
    const asar = await import('@electron/asar')
    return asar.listPackage(path.join(resourcesPath(variant), 'app.asar'), { isPack: false }).map((p: string) => p.replace(/\\/g, '/'))
  }

  test('holds the main process, the preload and the page of the app', async () => {
    const files = await list('release')
    for (const f of ['/.vite/build/main.js', '/.vite/build/preload.js', '/.vite/renderer/main_window/index.html', '/package.json']) {
      expect(files, f).toContain(f)
    }
  })

  test('holds every runtime dependency the main process loads', async () => {
    const files = new Set(await list('release'))
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const unpacked = path.join(resourcesPath('release'), 'app.asar.unpacked', 'node_modules')
    const missing = Object.keys(pkg.dependencies).filter((dep) => !files.has(`/node_modules/${dep}`) && !fs.existsSync(path.join(unpacked, dep)))
    record(suite, { missingRuntimeDependencies: missing, runtimeDependencies: Object.keys(pkg.dependencies).length })
    expect(missing).toEqual([])
  })

  test('holds no development dependency and no key file', async () => {
    const files = await list('release')
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const prodDeps = new Set(Object.keys(pkg.dependencies))
    const devOnly = ['vitest', 'eslint', 'playwright', '@playwright/test', 'typescript', '@electron-forge/cli', 'vue-tsc', 'stylelint'].filter((d) => !prodDeps.has(d))
    const devFound = devOnly.filter((d) => files.includes(`/node_modules/${d}`))
    const keyFiles = files.filter((f) => /(^|\/)(apiKeys[^/]*\.json|\.env(\.[^/]*)?|id_rsa[^/]*|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx)$/i.test(f) && !f.includes('/node_modules/'))
    record(suite, { devDependenciesInAsar: devFound, keyFilesInAsar: keyFiles, asarEntries: files.length })
    expect(devFound).toEqual([])
    expect(keyFiles).toEqual([])
  })
})

describe('CLI launcher', () => {
  test('the runtime file matches the build (electron by default, node with WITSY_CLI_RUNTIME=node)', () => {
    const runtime = fs.readFileSync(path.join(resourcesPath('release'), 'cli', 'runtime'), 'utf8').trim()
    const runtimeNode = fs.readFileSync(path.join(resourcesPath('release-node'), 'cli', 'runtime'), 'utf8').trim()
    record(suite, { cliRuntime: runtime, cliRuntimeNode: runtimeNode })
    expect(runtime).toBe('electron')
    expect(runtimeNode).toBe('node')
  })

  test.runIf(process.platform !== 'win32')('bin/witsy --help runs the CLI on the app binary', () => {
    const launcher = path.join(resourcesPath('release'), 'cli', 'bin', 'witsy')
    const res = spawnSync('bash', [launcher, '--help'], { timeout: 30000, env: { ...process.env, PATH: '/usr/bin:/bin' } })
    const out = String(res.stdout) + String(res.stderr)
    record(suite, { cliHelp: out.slice(0, 400), cliExit: res.status })
    expect(res.status).toBe(0)
    expect(out).toMatch(/help/i)
  })

  test.runIf(process.platform === 'win32')('bin\\witsy.cmd --help runs the CLI on the app binary', () => {
    const launcher = path.join(resourcesPath('release'), 'cli', 'bin', 'witsy.cmd')
    const res = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${launcher}" --help`], { timeout: 30000, windowsVerbatimArguments: true })
    const out = String(res.stdout) + String(res.stderr)
    record(suite, { cliHelp: out.slice(0, 400), cliExit: res.status })
    expect(res.status).toBe(0)
    expect(out).toMatch(/help/i)
  })
})
