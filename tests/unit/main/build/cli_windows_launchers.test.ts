
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// The Windows launchers of the CLI (bin/witsy.cmd and bin/witsy.ps1): what they contain on every
// platform, and on Windows what they do in copies of the layouts the CLI is installed in, with
// node.exe standing in for the app binary (Witsy.exe, electron.exe).

const root = path.join(__dirname, '../../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8')

describe('the Windows launchers', () => {

  const cmd = read('bin/witsy.cmd')
  const ps1 = read('bin/witsy.ps1')

  test('witsy.cmd has CRLF line ends, which cmd.exe needs to find its labels', () => {
    expect(cmd).toContain('\r\n')
    expect(cmd.replace(/\r\n/g, '')).not.toContain('\n')
    expect(read('.gitattributes')).toMatch(/^bin\/\*\.cmd -text$/m)
  })

  test('they are plain ASCII: Windows PowerShell 5.1 reads a script without BOM in the ANSI code page', () => {
    for (const script of [cmd, ps1]) {
      expect([...script].filter((char) => char !== '\t' && char !== '\r' && char !== '\n' && (char < ' ' || char > '~'))).toEqual([])
    }
  })

  test('they run the CLI and are no longer a placeholder', () => {
    for (const script of [cmd, ps1]) {
      expect(script).not.toContain('under development')
      expect(script).toContain('--no-deprecation')
    }
  })

  test('witsy.cmd only asks the app binary to be Node.js for the electron runtime, after the runtime file was read', () => {
    const lines = cmd.split('\r\n')
    const uses = lines.map((line, index) => line.includes('ELECTRON_RUN_AS_NODE') && !line.trim().startsWith('rem') ? index : -1).filter((index) => index !== -1)
    expect(uses).toHaveLength(1)
    expect(lines[uses[0]]).toBe('set "ELECTRON_RUN_AS_NODE=1"')
    const read = lines.findIndex((line) => line.includes('"%WITSY_CLI_DIR%runtime"'))
    const choice = lines.findIndex((line) => line === 'if "%WITSY_RUNTIME%"=="node" goto :run_node')
    expect(read).toBeGreaterThan(-1)
    expect(choice).toBeGreaterThan(read)
    expect(uses[0]).toBeGreaterThan(choice)
    // the run line comes right after, and the node line does not have it
    expect(lines[uses[0] + 1]).toBe('call :clean & "%WITSY_APP%" --no-deprecation "%WITSY_CLI%" %*')
    expect(lines).toContain('call :clean & "%WITSY_NODE%" --no-deprecation "%WITSY_CLI%" %*')
  })

  test('witsy.cmd finds node through the PATH only and keeps ! and % of the arguments', () => {
    expect(cmd).toContain('for %%I in (node.exe) do set "WITSY_NODE=%%~$PATH:I"')
    expect(cmd).not.toMatch(/^\s*where\b/im)
    expect(cmd).not.toMatch(/^\s*node\b/im)
    expect(cmd).toContain('setlocal EnableExtensions DisableDelayedExpansion')
    // delayed expansion only in the error messages, which never come back to the run lines
    const firstDelayed = cmd.indexOf('setlocal EnableDelayedExpansion')
    expect(firstDelayed).toBeGreaterThan(cmd.lastIndexOf('%*'))
  })

  test('witsy.ps1 gives ELECTRON_RUN_AS_NODE to the CLI only, for the electron runtime, after the runtime file was read', () => {
    const runtimeRead = ps1.indexOf('Get-Content -LiteralPath $runtimeFile -TotalCount 1')
    const choice = ps1.indexOf('if ($runtime -eq \'node\') {')
    const set = ps1.indexOf('$environment[\'ELECTRON_RUN_AS_NODE\'] = \'1\'')
    expect(runtimeRead).toBeGreaterThan(-1)
    expect(choice).toBeGreaterThan(runtimeRead)
    expect(set).toBeGreaterThan(choice)
    const uses = ps1.split(/\r?\n/).filter((line) => line.includes('ELECTRON_RUN_AS_NODE') && !line.trim().startsWith('#'))
    expect(uses).toEqual(['    $environment[\'ELECTRON_RUN_AS_NODE\'] = \'1\''])
    expect(ps1).not.toMatch(/\$env:ELECTRON_RUN_AS_NODE/)
    expect(ps1).toContain('$info.EnvironmentVariables[$name] = $script:environment[$name]')
    expect(ps1).toContain('Get-Command -Name node -CommandType Application')
    expect(ps1).not.toContain('$MyInvocation.MyCommand')
  })

})

// The launchers themselves, on Windows

const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const powershells = process.platform === 'win32' ? [
  path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ...(process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length).map((dir) => path.join(dir, 'pwsh.exe')).filter((file) => fs.existsSync(file)).slice(0, 1),
] : []

type Result = { status: number | null, stdout: string, stderr: string }
type Seen = { tag: string, argv: string[], exe: string, runAsNode: string | null, vars: string[], cwd: string, stdin?: string }

// the CLI: says where it runs, what it got, and exits with --code=N
const cliScript = (tag: string) => `const fs = require('fs')
const parent = new Set(JSON.parse(process.env.WITSY_TEST_PARENT_VARS || '[]'))
const seen = { tag: ${JSON.stringify(tag)}, argv: process.argv.slice(2), exe: process.execPath, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, vars: Object.keys(process.env).filter((k) => /^WITSY_/i.test(k) && !parent.has(k.toUpperCase())), cwd: process.cwd() }
if (process.argv.includes('--stdin')) seen.stdin = fs.readFileSync(0, 'utf-8')
process.stdout.write(JSON.stringify(seen) + '\\n')
const code = process.argv.find((a) => a.startsWith('--code='))
process.exitCode = code ? Number(code.slice(7)) : 0
`

// an argument of the command line, as CommandLineToArgvW reads it back
const quoteArg = (arg: string): string => {
  if (arg.length && !/[\s"&|<>^%!()]/.test(arg)) return arg
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}
const psLiteral = (value: string) => `'${value.replace(/'/g, '\'\'')}'`

describe.runIf(process.platform === 'win32')('the Windows launchers in an installed app', { timeout: 60000 }, () => {

  let work: string
  let squirrel: string
  let zip: string
  let repo: string
  let nodeRuntime: string
  let empty: string
  let noApp: string
  let lookalikes: string
  let systemPath: string
  let preload: string
  let drivers: string
  let driverCount = 0

  const exeOf = (dir: string) => path.join(dir, 'Witsy.exe')
  const nodeDir = path.dirname(process.execPath)

  const fakeExe = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      fs.linkSync(process.execPath, file)
    } catch {
      fs.copyFileSync(process.execPath, file)
    }
  }
  const writeFile = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const launchers = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(root, 'bin', 'witsy.cmd'), path.join(dir, 'witsy.cmd'))
    fs.copyFileSync(path.join(root, 'bin', 'witsy.ps1'), path.join(dir, 'witsy.ps1'))
  }
  const app = (dir: string, tag: string, exe = true) => {
    if (exe) fakeExe(exeOf(dir))
    writeFile(path.join(dir, 'resources', 'cli', 'cli.js'), cliScript(tag))
  }

  beforeAll(() => {
    // a folder name with the characters cmd.exe is the most likely to get wrong
    work = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'witsy A & B (x86) 100% ^!'))
    drivers = path.join(work, 'drivers')
    fs.mkdirSync(drivers)

    // Squirrel: <root>\witsy.cmd|ps1 next to app-X.Y.Z folders
    squirrel = path.join(work, 'Local', 'Witsy')
    launchers(squirrel)
    app(path.join(squirrel, 'app-1.9.0'), 'app-1.9.0')
    app(path.join(squirrel, 'app-1.10.0'), 'app-1.10.0')
    app(path.join(squirrel, 'app-1.2.0'), 'app-1.2.0')
    app(path.join(squirrel, 'app-2.0.0'), 'app-2.0.0 without Witsy.exe', false)
    app(path.join(squirrel, 'app-3.0.0-beta'), 'not a version')
    app(path.join(squirrel, 'app-10.0'), 'not a version')
    app(path.join(squirrel, 'app-9.0.0 (old)'), 'not a version')
    app(path.join(squirrel, 'app-1.10.0x'), 'not a version')
    launchers(path.join(squirrel, 'app-1.10.0', 'resources', 'cli', 'bin'))

    // zip: <app>\Witsy.exe, <app>\resources\cli\{cli.js,bin\witsy.*}
    zip = path.join(work, 'zip', 'Witsy-win32-x64')
    app(zip, 'zip')
    launchers(path.join(zip, 'resources', 'cli', 'bin'))

    // the repository: bin\witsy.*, dist\cli\{cli.js,bin\witsy.*}, node_modules\electron\dist\electron.exe
    repo = path.join(work, 'repo')
    launchers(path.join(repo, 'bin'))
    launchers(path.join(repo, 'dist', 'cli', 'bin'))
    writeFile(path.join(repo, 'dist', 'cli', 'cli.js'), cliScript('repo'))
    fakeExe(path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'))

    // a build for the Node.js of the computer
    nodeRuntime = path.join(work, 'node-runtime')
    app(nodeRuntime, 'node-runtime')
    launchers(path.join(nodeRuntime, 'resources', 'cli', 'bin'))

    // nothing around the launcher, and an app without its binary
    empty = path.join(work, 'empty')
    launchers(empty)
    noApp = path.join(work, 'no-app')
    app(noApp, 'no-app', false)
    launchers(path.join(noApp, 'resources', 'cli', 'bin'))

    // a current folder full of things the launchers must not run
    lookalikes = path.join(work, 'cwd')
    fakeExe(path.join(lookalikes, 'node.exe'))
    fakeExe(path.join(lookalikes, 'Witsy.exe'))
    writeFile(path.join(lookalikes, 'cli.js'), cliScript('the current folder'))
    app(path.join(lookalikes, 'app-99.0.0'), 'the current folder')
    writeFile(path.join(lookalikes, 'runtime'), 'node\n')

    // Windows itself and nothing else: no node
    systemPath = [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter)
    expect(systemPath.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'node.exe')))).toBe(false)

    // node -p ... answers what WITSY_TEST_NODE_MAJOR says: a node too old, or not a node
    preload = path.join(work, 'fake-version.js')
    writeFile(preload, 'if (process.execArgv.includes(\'-p\')) { process.stdout.write(process.env.WITSY_TEST_NODE_MAJOR + \'\\n\'); process.exit(0) }\n')
  })

  afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  })

  const baseEnv = (env: Record<string, string>) => {
    const merged: Record<string, string> = { ...process.env as Record<string, string>, ...env }
    delete merged.ELECTRON_RUN_AS_NODE
    merged.WITSY_TEST_PARENT_VARS = JSON.stringify(Object.keys(merged).filter((k) => /^WITSY_/i.test(k)).map((k) => k.toUpperCase()).concat('WITSY_TEST_PARENT_VARS'))
    return merged
  }

  const clean = (text: string) => text.replace(/\r/g, '').trim()

  type RunOptions = { env?: Record<string, string>, cwd?: string, input?: string, after?: string }

  // witsy.cmd from cmd.exe, as typed in a console (every argument quoted when it has to be)
  const runCmd = (launcher: string, args: string[], options: RunOptions = {}): Result => {
    const line = `"${launcher}" ${args.map(quoteArg).join(' ')}${options.after ? ` & ${options.after}` : ''}`
    const result = spawnSync(comspec, ['/d', '/s', '/c', `"${line}"`], {
      windowsVerbatimArguments: true, encoding: 'utf-8', cwd: options.cwd ?? lookalikes, env: baseEnv(options.env ?? {}), input: options.input ?? '',
    })
    return { status: result.status, stdout: clean(result.stdout), stderr: clean(result.stderr) }
  }

  // witsy.ps1 from a PowerShell session, as `& witsy.ps1 args` (and `input | & witsy.ps1 args`)
  const runPs = (shell: string, launcher: string, args: string[], options: RunOptions & { constrained?: boolean, pipeline?: string[] } = {}): Result => {
    const script = [
      '$ErrorActionPreference = \'Stop\'',
      options.constrained ? '$ExecutionContext.SessionState.LanguageMode = \'ConstrainedLanguage\'' : '',
      `${options.pipeline ? `@(${options.pipeline.map(psLiteral).join(', ')}) | ` : ''}& ${psLiteral(launcher)} ${args.map(psLiteral).join(' ')}`,
      '$code = $LASTEXITCODE',
      options.after ?? '',
      'exit $code',
    ].join('\r\n')
    // a script file (with the BOM Windows PowerShell needs to read UTF-8): -EncodedCommand would
    // write CLIXML on stderr and limits the length of the arguments
    const driver = path.join(drivers, `driver-${++driverCount}.ps1`)
    fs.writeFileSync(driver, '﻿' + script)
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], {
      encoding: 'utf-8', cwd: options.cwd ?? lookalikes, env: baseEnv(options.env ?? {}), input: options.input ?? '',
    })
    return { status: result.status, stdout: clean(result.stdout), stderr: clean(result.stderr) }
  }

  // witsy.ps1 started as a program: powershell.exe -File witsy.ps1 args
  const runPsFile = (shell: string, launcher: string, args: string[], options: RunOptions = {}): Result => {
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args], {
      encoding: 'utf-8', cwd: options.cwd ?? lookalikes, env: baseEnv(options.env ?? {}), input: options.input ?? '',
    })
    return { status: result.status, stdout: clean(result.stdout), stderr: clean(result.stderr) }
  }

  type Runner = [string, (dir: string, args: string[], options?: RunOptions) => Result]
  const runners = (): Runner[] => [
    ['witsy.cmd', (dir, args, options) => runCmd(path.join(dir, 'witsy.cmd'), args, options)],
    ...powershells.map((shell): Runner => [`witsy.ps1 in ${path.basename(shell)}`, (dir, args, options) => runPs(shell, path.join(dir, 'witsy.ps1'), args, options)]),
    ...powershells.map((shell): Runner => [`witsy.ps1 in ${path.basename(shell)} -File`, (dir, args, options) => runPsFile(shell, path.join(dir, 'witsy.ps1'), args, options)]),
    ...powershells.slice(0, 1).map((shell): Runner => [`witsy.ps1 in ${path.basename(shell)}, ConstrainedLanguage`, (dir, args, options) => runPs(shell, path.join(dir, 'witsy.ps1'), args, { ...options, constrained: true })]),
  ]

  const seen = (result: Result, name: string): Seen => {
    expect(result.stderr, name).toBe('')
    const lines = result.stdout.split('\n')
    expect(lines.length, name + ': ' + result.stdout).toBeGreaterThanOrEqual(1)
    return JSON.parse(lines[0])
  }

  test('Squirrel: the highest app-X.Y.Z with the app and the CLI, compared as numbers, runs the CLI as Node.js', () => {
    for (const [name, run] of runners()) {
      const result = run(squirrel, ['--port', '8090'])
      expect(result.status, name).toBe(0)
      const child = seen(result, name)
      expect(child.tag, name).toBe('app-1.10.0')
      expect(child.exe.toLowerCase(), name).toBe(exeOf(path.join(squirrel, 'app-1.10.0')).toLowerCase())
      expect(child.argv, name).toEqual(['--port', '8090'])
      expect(child.runAsNode, name).toBe('1')
      expect(child.vars, name).toEqual([])
      expect(child.cwd.toLowerCase(), name).toBe(lookalikes.toLowerCase())
    }
  })

  test.each([
    ['zip install: <app>\\resources\\cli\\bin', () => path.join(zip, 'resources', 'cli', 'bin'), 'zip', () => exeOf(zip)],
    ['the launcher inside a Squirrel version', () => path.join(squirrel, 'app-1.10.0', 'resources', 'cli', 'bin'), 'app-1.10.0', () => exeOf(path.join(squirrel, 'app-1.10.0'))],
    ['repository, after npm run build:cli: dist\\cli\\bin', () => path.join(repo, 'dist', 'cli', 'bin'), 'repo', () => path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')],
    ['repository: bin', () => path.join(repo, 'bin'), 'repo', () => path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')],
  ])('%s', (_, dir, tag, exe) => {
    for (const [name, run] of runners()) {
      const result = run(dir(), ['two words'])
      expect(result.status, name).toBe(0)
      const child = seen(result, name)
      expect(child.tag, name).toBe(tag)
      expect(child.exe.toLowerCase(), name).toBe(exe().toLowerCase())
      expect(child.argv, name).toEqual(['two words'])
      expect(child.runAsNode, name).toBe('1')
    }
  })

  test('witsy.cmd passes the arguments on as the CLI gets them', () => {
    const args = ['a', 'two words', '', 'x&y|z<w>v^u', '100%', '%WITSY_TEST_UNDEFINED%', '!bang!', '^^', 'say "hi"', 'tail\\', 'mid\\"dle', '(paren)', 'hÃ©llo wÃ¶rld âœ“ æ—¥æœ¬èªž']
    const result = runCmd(path.join(squirrel, 'witsy.cmd'), args)
    expect(result.status).toBe(0)
    expect(seen(result, 'witsy.cmd').argv).toEqual(args)
  })

  test('witsy.ps1 passes the arguments on as the CLI gets them, empty ones and double quotes included', () => {
    const args = ['a', 'two words', '', 'x&y|z<w>v^u', '100%', '$env:PATH', '!bang!', 'say "hi there"', '"', 'tail\\', 'tail space\\', 'mid\\"dle', '\\\\server\\share', 'hÃ©llo wÃ¶rld âœ“ æ—¥æœ¬èªž', '-p', '--', '--flag=a b']
    for (const shell of powershells) {
      const result = runPs(shell, path.join(squirrel, 'witsy.ps1'), args)
      expect(result.status, shell).toBe(0)
      expect(seen(result, shell).argv, shell).toEqual(args)
    }
  })

  test('the exit code of the CLI is the one of the launcher', () => {
    for (const [name, run] of runners()) {
      for (const code of [0, 1, 7, 255, 256]) {
        const result = run(squirrel, [`--code=${code}`])
        expect(result.status, `${name} ${code}`).toBe(code)
        expect(seen(result, name).argv).toEqual([`--code=${code}`])
      }
    }
  })

  test('stdin reaches the CLI', () => {
    const input = 'first line\nsecond line\n'
    for (const [name, run] of runners()) {
      if (name.includes('ConstrainedLanguage')) continue
      const result = run(squirrel, ['--stdin'], { input })
      expect(result.status, name).toBe(0)
      expect(seen(result, name).stdin!.replace(/\r/g, ''), name).toBe(input)
    }
  })

  test('PowerShell pipeline input reaches the CLI in UTF-8, without BOM', () => {
    for (const shell of powershells) {
      const result = runPs(shell, path.join(squirrel, 'witsy.ps1'), ['--stdin'], { pipeline: ['hÃ©llo', 'wÃ¶rld âœ“'] })
      expect(result.status, shell).toBe(0)
      expect(seen(result, shell).stdin, shell).toBe('hÃ©llo\nwÃ¶rld âœ“\n')
    }
  })

  test('ELECTRON_RUN_AS_NODE and the variables of the launcher do not stay in the shell', () => {
    const cmdResult = runCmd(path.join(squirrel, 'witsy.cmd'), ['x'], { after: 'if defined ELECTRON_RUN_AS_NODE (echo LEAK) else if defined WITSY_CLI (echo LEAK) else (echo CLEAN)' })
    expect(cmdResult.stdout.split('\n').pop()).toBe('CLEAN')
    for (const shell of powershells) {
      for (const constrained of [false, true]) {
        const result = runPs(shell, path.join(squirrel, 'witsy.ps1'), ['x'], { constrained, after: '"after=[$env:ELECTRON_RUN_AS_NODE]"' })
        expect(result.status, shell).toBe(0)
        expect(result.stdout.split('\n').pop(), shell).toBe('after=[]')
      }
    }
  })

  test('without a CLI around the launcher, it says where it looked', () => {
    for (const [name, run] of runners()) {
      const result = run(empty, ['--help'])
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toContain('cannot find the Witsy CLI')
      expect(result.stderr, name).toContain(path.join(empty, 'app-X.Y.Z'))
    }
  })

  test('without the app binary, it says which one is missing', () => {
    for (const [name, run] of runners()) {
      const result = run(path.join(noApp, 'resources', 'cli', 'bin'), ['--help'])
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toContain('not the Witsy app')
      expect(result.stderr, name).toContain(exeOf(noApp))
    }
  })

  test.each([
    ['runtime "node"', 'node\n'],
    ['a runtime file written on Windows', 'node\r\n'],
    ['a runtime file without a line end', 'node'],
    ['spaces around the name', '  node \t\n'],
  ])('%s: the Node.js of the PATH runs the CLI, not the app binary', (_, content) => {
    writeFile(path.join(nodeRuntime, 'resources', 'cli', 'runtime'), content)
    for (const [name, run] of runners()) {
      const result = run(path.join(nodeRuntime, 'resources', 'cli', 'bin'), ['two words', '--code=3'], { env: { PATH: [nodeDir, systemPath].join(path.delimiter) } })
      expect(result.status, name).toBe(3)
      const child = seen(result, name)
      expect(child.tag, name).toBe('node-runtime')
      expect(child.exe.toLowerCase(), name).toBe(process.execPath.toLowerCase())
      expect(child.runAsNode, name).toBeNull()
      expect(child.argv, name).toEqual(['two words', '--code=3'])
    }
  })

  test.each([
    ['no runtime file', null],
    ['runtime "electron"', 'electron\n'],
    ['an empty runtime file', ''],
    ['an unknown runtime', 'deno\n'],
  ])('%s: the app binary runs the CLI as Node.js', (_, content) => {
    const file = path.join(nodeRuntime, 'resources', 'cli', 'runtime')
    if (content === null) fs.rmSync(file, { force: true })
    else writeFile(file, content)
    for (const [name, run] of runners()) {
      const result = run(path.join(nodeRuntime, 'resources', 'cli', 'bin'), ['x'], { env: { PATH: [nodeDir, systemPath].join(path.delimiter) } })
      expect(result.status, name).toBe(0)
      const child = seen(result, name)
      expect(child.exe.toLowerCase(), name).toBe(exeOf(nodeRuntime).toLowerCase())
      expect(child.runAsNode, name).toBe('1')
    }
  })

  test('runtime "node" without node in the PATH: a clear error, and nothing from the current folder runs', () => {
    writeFile(path.join(nodeRuntime, 'resources', 'cli', 'runtime'), 'node\n')
    for (const [name, run] of runners()) {
      // the current folder has a node.exe
      const result = run(path.join(nodeRuntime, 'resources', 'cli', 'bin'), ['--help'], { env: { PATH: systemPath } })
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toContain('Witsy CLI requires Node.js 18 or later, and no \'node\' was found in your PATH.')
      expect(result.stderr, name).toContain('https://nodejs.org')
    }
  })

  test('runtime "node" with a PATH that points to the current folder: its node.exe does not run', () => {
    writeFile(path.join(nodeRuntime, 'resources', 'cli', 'runtime'), 'node\n')
    for (const [name, run] of runners()) {
      const result = run(path.join(nodeRuntime, 'resources', 'cli', 'bin'), ['--help'], { env: { PATH: ['.', systemPath].join(path.delimiter) } })
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toMatch(/current folder|no 'node' was found/)
    }
  })

  test.each([
    ['a node that is too old', '16'],
    ['a node that does not say its version', 'abc'],
    ['a version that is not one', '0018'],
  ])('runtime "node" with %s: a clear error and the CLI does not run', (_, major) => {
    writeFile(path.join(nodeRuntime, 'resources', 'cli', 'runtime'), 'node\n')
    for (const [name, run] of runners()) {
      const result = run(path.join(nodeRuntime, 'resources', 'cli', 'bin'), ['--help'], { env: { PATH: [nodeDir, systemPath].join(path.delimiter), NODE_OPTIONS: `--require "${preload}"`, WITSY_TEST_NODE_MAJOR: major } })
      expect(result.status, name).toBe(1)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toMatch(/Witsy CLI requires Node\.js 18 or later: '.*node\.exe' is v\d+\.\d+\.\d+\./)
    }
  })

  test('many and long arguments', () => {
    const many = Array.from({ length: 300 }, (_, i) => `arg ${i} âœ“`)
    const long = ['x'.repeat(3000), 'y y'.repeat(1000)]
    const cmdResult = runCmd(path.join(squirrel, 'witsy.cmd'), [...long, ...many.slice(0, 100)])
    expect(cmdResult.status).toBe(0)
    expect(seen(cmdResult, 'witsy.cmd').argv).toEqual([...long, ...many.slice(0, 100)])
    for (const shell of powershells) {
      const args = [...many, 'z'.repeat(20000)]
      const result = runPs(shell, path.join(squirrel, 'witsy.ps1'), args)
      expect(result.status, shell).toBe(0)
      expect(seen(result, shell).argv, shell).toEqual(args)
    }
  })

})
