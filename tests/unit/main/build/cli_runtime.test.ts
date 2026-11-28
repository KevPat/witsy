
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { cliRuntime, kCliRuntimeFile, runAsNodeFuse, writeCliRuntime } from '@root/build/cli_runtime'

// Which Node.js runs the Witsy CLI, and with it whether the packaged app can be turned into a
// Node.js runtime by any local process (S-15). The rule is in build/cli_runtime.ts, forge.config.ts
// follows it for the RunAsNode fuse and bin/witsy reads the choice next to cli.js.

const root = path.join(__dirname, '../../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8')

describe('the Node.js that runs the CLI', () => {

  test.each(['win32', 'darwin', 'mas', 'linux'])('a %s build uses the app binary unless it is built for the Node.js of the user', (platform) => {
    expect(cliRuntime(platform, {})).toBe('electron')
    expect(runAsNodeFuse(platform, {})).toBe(true)
    expect(cliRuntime(platform, { WITSY_CLI_RUNTIME: 'node' })).toBe('node')
    expect(runAsNodeFuse(platform, { WITSY_CLI_RUNTIME: 'node' })).toBe(false)
  })

  test.each(['', 'electron', 'NODE', 'Node', '1', 'true', ' node'])('WITSY_CLI_RUNTIME=%j is not a request for the Node.js of the user', (value) => {
    expect(cliRuntime('win32', { WITSY_CLI_RUNTIME: value })).toBe('electron')
    expect(cliRuntime('darwin', { WITSY_CLI_RUNTIME: value })).toBe('electron')
    expect(cliRuntime('linux', { WITSY_CLI_RUNTIME: value })).toBe('electron')
  })

  test('the fuse is on exactly when the CLI needs the app binary', () => {
    for (const platform of ['win32', 'darwin', 'mas', 'linux']) {
      for (const env of [{}, { WITSY_CLI_RUNTIME: 'node' }, { WITSY_CLI_RUNTIME: 'electron' }]) {
        expect(runAsNodeFuse(platform, env)).toBe(cliRuntime(platform, env) === 'electron')
      }
    }
  })

  test('the choice is written next to cli.js for the launcher', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-cli-runtime-'))
    try {
      writeCliRuntime(dir, 'node')
      expect(fs.readFileSync(path.join(dir, kCliRuntimeFile), 'utf-8')).toBe('node\n')
      writeCliRuntime(dir, 'electron')
      expect(fs.readFileSync(path.join(dir, kCliRuntimeFile), 'utf-8')).toBe('electron\n')
      expect(kCliRuntimeFile).toBe('runtime')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})

describe('the packaging configuration', () => {

  const forgeConfig = read('forge.config.ts')

  test('the RunAsNode fuse follows the rule, for the platform being packaged', () => {
    expect(forgeConfig).toMatch(/\[FuseV1Options\.RunAsNode\]:\s*runAsNodeFuse\(targetPlatform\),/)
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.RunAsNode\]:\s*true/)
  })

  test('the launcher is told the same choice, after the CLI is built and before it is packaged', () => {
    const hook = forgeConfig.match(/prePackage: async \(_forgeConfig, platform, arch\) => \{([\s\S]*?)\n {4}\},/)?.[1]
    expect(hook).toBeDefined()
    const build = hook.indexOf('npm run build:cli')
    const write = hook.indexOf('writeCliRuntime(\'dist/cli\', cliRuntime(platform))')
    expect(build).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(build)
  })

  test('the choice is packaged with the CLI', () => {
    // dist/cli is copied as a whole next to the app: cli.js, its launchers and the runtime file
    expect(forgeConfig).toMatch(/extraResource:\s*\[[^\]]*'dist\/cli'/)
  })

})

describe('the launchers', () => {

  const launcher = read('bin/witsy').replace(/\r/g, '')

  test('the Windows launchers read the same choice and only ask the app binary to be Node.js for the electron runtime', () => {
    // what they do is tested in cli_windows_launchers.test.ts
    const cmd = read('bin/witsy.cmd').replace(/\r/g, '')
    const cmdLines = cmd.split('\n')
    const cmdChoice = cmdLines.indexOf('if "%WITSY_RUNTIME%"=="node" goto :run_node')
    const cmdUse = cmdLines.indexOf('set "ELECTRON_RUN_AS_NODE=1"')
    expect(cmd).toContain('"%WITSY_CLI_DIR%runtime"')
    expect(cmdChoice).toBeGreaterThan(-1)
    expect(cmdUse).toBeGreaterThan(cmdChoice)
    expect(cmdLines.slice(cmdChoice, cmdUse).some((line) => line.includes('%WITSY_NODE%'))).toBe(false)

    const ps1 = read('bin/witsy.ps1')
    expect(ps1).toContain('$runtimeFile = Join-Path (Split-Path -Parent $cli) \'runtime\'')
    const psChoice = ps1.indexOf('if ($runtime -eq \'node\') {')
    const psElse = ps1.indexOf('} else {', psChoice)
    const psUse = ps1.indexOf('$environment[\'ELECTRON_RUN_AS_NODE\'] = \'1\'')
    expect(psChoice).toBeGreaterThan(-1)
    expect(psUse).toBeGreaterThan(psElse)
    expect(psElse).toBeGreaterThan(psChoice)
  })

  test('bin/witsy only asks the app binary to be Node.js on one line, after the choice was read', () => {
    const lines = launcher.split('\n')
    const uses = lines.map((line, index) => line.includes('ELECTRON_RUN_AS_NODE=1') && !line.trim().startsWith('#') ? index : -1).filter((index) => index !== -1)
    expect(uses).toHaveLength(1)
    const choice = lines.findIndex((line) => line.includes('if [ "$RUNTIME" = "node" ]; then'))
    expect(choice).toBeGreaterThan(-1)
    expect(uses[0]).toBeGreaterThan(choice)
    expect(launcher).toContain('if [ -f "$CLI_DIR/runtime" ]; then')
  })

  test('bin/witsy uses nothing that the bash of macOS (3.2) does not have', () => {
    expect(launcher).not.toMatch(/declare -A|mapfile|readarray|\$\{[A-Za-z_]+(\^\^|,,)\}|&>>|\|&|\[\[[^\]]*=~/)
    expect(launcher.startsWith('#!/usr/bin/env bash\n')).toBe(true)
  })

})

// The launcher itself, in a copy of the layout of an installed app, with stand-ins for the app
// binary and for old versions of node. It needs a POSIX shell: on Windows it runs when the tests
// are started from Git Bash, which is where bin/witsy would be read from on that platform anyway.
const bash = process.platform !== 'win32' || process.env.MSYSTEM ? 'bash' : null

describe.runIf(bash !== null)('bin/witsy in an installed app', () => {

  let work: string
  let linux: { launcher: string, cliDir: string }
  let mac: { launcher: string, cliDir: string }
  let oldNodeDir: string
  let noNodeDir: string

  const writeScript = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    fs.chmodSync(file, 0o755)
  }

  // the app binary: says how it was started and exits with a code of its own
  const appBinary = (code: number) => `#!/usr/bin/env bash\necho "APP run_as_node=\${ELECTRON_RUN_AS_NODE:-unset} args=$*"\nexit ${code}\n`

  const kCli = 'console.log(\'CLI on node \' + process.versions.node.split(\'.\')[0] + \' electron=\' + String(process.versions.electron) + \' args=\' + JSON.stringify(process.argv.slice(2)))\nprocess.exit(process.argv.includes(\'--fail\') ? 3 : 0)\n'

  const run = (launcher: string, args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(bash, [launcher, ...args], { encoding: 'utf-8', env: { ...process.env, ...env }, cwd: work })
    return { status: result.status, stdout: result.stdout.replace(/\r/g, '').trim(), stderr: result.stderr.replace(/\r/g, '').trim() }
  }

  // the node that runs the tests first, then the system folders bash needs (head, tr, dirname...)
  const pathWith = (...dirs: string[]): string => [...dirs, ...(process.env.PATH ?? '').split(path.delimiter)].join(path.delimiter)
  // a PATH with what the launcher needs and no node, wherever node is installed on this computer
  let toolsPath: string
  const pathWithoutNode = (): string => {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length)
    if (process.platform === 'win32') {
      // Git for Windows keeps its tools in folders of their own: leaving out the folders of node is enough
      return dirs.filter((dir) => !fs.existsSync(path.join(dir, 'node.exe')) && !fs.existsSync(path.join(dir, 'node'))).join(path.delimiter)
    }
    // elsewhere node may sit next to the tools (/usr/bin): link the tools alone in a folder
    const tools = path.join(work, 'tools')
    fs.mkdirSync(tools)
    for (const tool of ['bash', 'env', 'dirname', 'readlink', 'head', 'tr']) {
      const found = dirs.map((dir) => path.join(dir, tool)).find((candidate) => fs.existsSync(candidate))
      if (found) fs.symlinkSync(found, path.join(tools, tool))
    }
    return tools
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'witsy-launcher-'))
    const script = read('bin/witsy').replace(/\r/g, '')

    // Linux: <app>/witsy and <app>/resources/cli/{cli.js,runtime,bin/witsy}
    linux = { launcher: path.join(work, 'linux', 'resources', 'cli', 'bin', 'witsy'), cliDir: path.join(work, 'linux', 'resources', 'cli') }
    writeScript(linux.launcher, script)
    writeScript(path.join(work, 'linux', 'witsy'), appBinary(7))
    fs.writeFileSync(path.join(linux.cliDir, 'cli.js'), kCli)

    // macOS: Witsy.app/Contents/MacOS/Witsy and Witsy.app/Contents/Resources/cli/{cli.js,runtime,bin/witsy}
    const contents = path.join(work, 'mac', 'Witsy.app', 'Contents')
    mac = { launcher: path.join(contents, 'Resources', 'cli', 'bin', 'witsy'), cliDir: path.join(contents, 'Resources', 'cli') }
    writeScript(mac.launcher, script)
    writeScript(path.join(contents, 'MacOS', 'Witsy'), appBinary(9))
    fs.writeFileSync(path.join(mac.cliDir, 'cli.js'), kCli)

    // a node that is too old, and a folder without node
    oldNodeDir = path.join(work, 'old-node')
    writeScript(path.join(oldNodeDir, 'node'), '#!/usr/bin/env bash\nif [ "$1" = "-p" ]; then echo 16; elif [ "$1" = "--version" ]; then echo v16.20.2; else echo "THE OLD NODE RAN THE CLI"; fi\n')
    noNodeDir = path.join(work, 'no-node')
    fs.mkdirSync(noNodeDir)
    toolsPath = pathWithoutNode()
  })

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true })
  })

  const setRuntime = (cliDir: string, content: string | null) => {
    const file = path.join(cliDir, 'runtime')
    if (content === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, content)
  }

  const layouts = (): [string, { launcher: string, cliDir: string }, Record<string, string>, number][] => [
    ['linux', linux, {}, 7],
    ['macOS', mac, { OSTYPE: 'darwin23' }, 9],
  ]

  test.each([
    ['no runtime file (an app built before this choice existed)', null],
    ['runtime "electron"', 'electron\n'],
    ['an empty runtime file', ''],
    ['an unknown runtime', 'deno\n'],
  ])('%s: the app binary runs the CLI as Node.js, as before', (_, content) => {
    for (const [name, layout, env, code] of layouts()) {
      setRuntime(layout.cliDir, content)
      const result = run(layout.launcher, ['--port', '8090', 'two words'], env)
      expect(result.stdout, name).toMatch(/^APP run_as_node=1 args=--no-deprecation .*cli\.js --port 8090 two words$/)
      expect(result.status, name).toBe(code)
    }
  })

  test.each([
    ['runtime "node"', 'node\n'],
    ['a runtime file written on Windows', 'node\r\n'],
    ['a runtime file without a line end', 'node'],
  ])('%s: the Node.js of the computer runs the CLI and the app binary is not started', (_, content) => {
    for (const [name, layout, env] of layouts()) {
      setRuntime(layout.cliDir, content)
      const result = run(layout.launcher, ['--port', '8090', 'two words'], { ...env, PATH: pathWith(path.dirname(process.execPath)) })
      expect(result.stdout, name).toBe(`CLI on node ${process.versions.node.split('.')[0]} electron=undefined args=["--port","8090","two words"]`)
      expect(result.status, name).toBe(0)
    }
  })

  test('the exit code of the CLI is the one of the launcher', () => {
    for (const [name, layout, env] of layouts()) {
      setRuntime(layout.cliDir, 'node\n')
      expect(run(layout.launcher, ['--fail'], { ...env, PATH: pathWith(path.dirname(process.execPath)) }).status, name).toBe(3)
    }
  })

  test('without node, the launcher says what is missing and does not fall back to the app binary', () => {
    for (const [name, layout, env] of layouts()) {
      setRuntime(layout.cliDir, 'node\n')
      const result = run(layout.launcher, ['--help'], { ...env, PATH: [noNodeDir, toolsPath].join(path.delimiter) })
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toContain('Witsy CLI requires Node.js 18 or later, and no \'node\' was found in your PATH.')
      expect(result.stderr, name).toContain('https://nodejs.org')
    }
  })

  test('with a node that is too old, the launcher says so and does not run the CLI with it', () => {
    for (const [name, layout, env] of layouts()) {
      setRuntime(layout.cliDir, 'node\n')
      const result = run(layout.launcher, ['--help'], { ...env, PATH: [oldNodeDir, toolsPath].join(path.delimiter) })
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toMatch(/Witsy CLI requires Node\.js 18 or later: '.*node' is v16\.20\.2\./)
    }
  })

  test.runIf(process.platform !== 'win32')('the launcher is found through the link the app installs', () => {
    // /usr/local/bin/witsy is a link to the launcher inside the app
    const link = path.join(work, 'usr-local-bin-witsy')
    for (const [name, layout, env, code] of layouts()) {
      fs.rmSync(link, { force: true })
      fs.symlinkSync(layout.launcher, link)
      setRuntime(layout.cliDir, 'node\n')
      expect(run(link, ['x'], { ...env, PATH: pathWith(path.dirname(process.execPath)) }).stdout, name).toContain('CLI on node')
      setRuntime(layout.cliDir, 'electron\n')
      expect(run(link, ['x'], env).status, name).toBe(code)
    }
  })

})
