import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import { app } from 'electron'
import { checkAndInstallCLI } from '@main/cli_installer'
import * as config from '@main/config'
import { bug } from './bug'

// On Windows the CLI installer reads the user PATH with PowerShell, decides whether its folder is
// already there with a plain substring test, and appends the folder with a second PowerShell call.
// That call used to carry the whole PATH inside its command line (S-27). It is now a constant
// script that reads the PATH again inside PowerShell and takes the folder from its environment.
//
// Nothing here runs a command or touches the registry or the disk: child_process and fs are mocked
// (any command other than the two expected PowerShell calls fails the test), process.platform is
// stubbed to win32 and `path` is replaced by path.win32 so that the Windows branch behaves the same
// on Linux, macOS and Windows.

vi.mock('child_process', () => {
  const mocked = { execSync: vi.fn(), execFileSync: vi.fn() }
  return { default: mocked, ...mocked }
})

vi.mock('fs', () => {
  const mocked = {
    copyFileSync: vi.fn(),
    lstatSync: vi.fn(() => { throw new Error('ENOENT') }),
    readlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    symlinkSync: vi.fn(),
    chmodSync: vi.fn(),
  }
  return { default: mocked, ...mocked }
})

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual.win32, default: actual.win32 }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getAppPath: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('@main/config', () => ({ loadSettings: vi.fn(), saveSettings: vi.fn() }))
vi.mock('@main/i18n', () => ({ useI18n: vi.fn(() => (key: string) => key) }))

// a Squirrel install lives in a versioned folder and puts the folder above it on the PATH
const kSquirrelExe = 'C:\\Users\\me\\AppData\\Local\\Witsy\\app-3.5.2\\Witsy.exe'
const kSquirrelTarget = 'C:\\Users\\me\\AppData\\Local\\Witsy'

// a zip install puts its own resources\cli\bin folder on the PATH
const kZipExe = 'C:\\Program Files\\Witsy\\Witsy.exe'
const kZipTarget = 'C:\\Program Files\\Witsy\\resources\\cli\\bin'

const kOtherEntries = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\bin'

const kPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const kReadScript = '[Environment]::GetEnvironmentVariable(\'Path\', \'User\')'
const kAppendScript = '[Environment]::SetEnvironmentVariable(\'Path\', ([Environment]::GetEnvironmentVariable(\'Path\', \'User\') + \';\' + $env:WITSY_CLI_DIR), \'User\')'

type Install = { command: string | null, env: Record<string, string> | null, written: string | null }

// Runs the installer against a fake user PATH. Returns the PowerShell command line that writes the
// PATH (null when the installer decided not to write), the environment it is started with, and the
// PATH value that exact script stores: the user PATH it reads, a semicolon and $env:WITSY_CLI_DIR.
const install = async (exe: string, userPath: string): Promise<Install> => {
  let command: string | null = null
  let env: Record<string, string> | null = null
  vi.mocked(app.getPath).mockReturnValue(exe)
  vi.mocked(execSync).mockImplementation(((cmd: string) => {
    throw new Error(`unexpected shell command: ${cmd}`)
  }) as any)
  vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], options: any) => {
    const script = args[args.length - 1]
    if (file === 'powershell.exe' && script === kReadScript) return `${userPath}\r\n`
    if (file === 'powershell.exe' && script === kAppendScript) {
      command = [file, ...args].join(' ')
      env = options.env
      return ''
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }) as any)

  await checkAndInstallCLI(false)

  return { command, env, written: env === null ? null : `${userPath};${(env as Record<string, string>).WITSY_CLI_DIR}` }
}

const entries = (value: string | null): string[] => value === null ? [] : value.split(';')

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.mocked(config.loadSettings).mockReturnValue({ general: { cliInstallError: false } } as any)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', kPlatform)
})

describe('Windows CLI install: PATH handling that works today', () => {

  test('a zip install appends its cli folder to the user PATH', async () => {
    const { written } = await install(kZipExe, kOtherEntries)
    expect(written).toBe(`${kOtherEntries};${kZipTarget}`)
    expect(fs.copyFileSync).not.toHaveBeenCalled()
  })

  test('a Squirrel install copies the launchers above the versioned folder and appends that folder', async () => {
    const { written } = await install(kSquirrelExe, kOtherEntries)
    expect(written).toBe(`${kOtherEntries};${kSquirrelTarget}`)
    expect(vi.mocked(fs.copyFileSync).mock.calls).toEqual([
      ['C:\\Users\\me\\AppData\\Local\\Witsy\\app-3.5.2\\resources\\cli\\bin\\witsy.cmd', 'C:\\Users\\me\\AppData\\Local\\Witsy\\witsy.cmd'],
      ['C:\\Users\\me\\AppData\\Local\\Witsy\\app-3.5.2\\resources\\cli\\bin\\witsy.ps1', 'C:\\Users\\me\\AppData\\Local\\Witsy\\witsy.ps1'],
    ])
  })

  test.each([
    ['as the last entry', `${kOtherEntries};${kSquirrelTarget}`],
    ['as the first entry', `${kSquirrelTarget};${kOtherEntries}`],
    ['as the only entry', kSquirrelTarget],
    ['with a trailing backslash', `${kOtherEntries};${kSquirrelTarget}\\`],
  ])('the PATH is left alone when the folder is already there %s', async (_, userPath) => {
    expect((await install(kSquirrelExe, userPath)).written).toBeNull()
  })

  test('an apostrophe in the PATH is not carried by the command line', async () => {
    const userPath = 'C:\\Users\\O\'Brien\\bin'
    const { command, written } = await install(kZipExe, userPath)
    expect(written).toBe(`${userPath};${kZipTarget}`)
    expect(command).not.toContain('Brien')
  })

  test('a long PATH is written back whole, never truncated', async () => {
    // the "length" suspicion from the audit: unlike setx (1024 characters) nothing is cut off here,
    // and the PATH no longer has to fit in a command line at all
    const userPath = Array.from({ length: 200 }, (_, i) => `C:\\tools\\some-fairly-long-folder-name-${i}\\bin`).join(';')
    expect(userPath.length).toBeGreaterThan(8191)
    const { command, written } = await install(kZipExe, userPath)
    expect(written).toBe(`${userPath};${kZipTarget}`)
    expect(command).not.toContain('some-fairly-long-folder-name')
  })

  test('a previous failed install is not retried and runs no command', async () => {
    vi.mocked(config.loadSettings).mockReturnValue({ general: { cliInstallError: true } } as any)
    await checkAndInstallCLI(false)
    expect(execSync).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
  })

  test('a failing PATH read is swallowed and nothing is written', async () => {
    vi.mocked(app.getPath).mockReturnValue(kZipExe)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('powershell not found') })
    await expect(checkAndInstallCLI(false)).resolves.toBeUndefined()
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execSync).not.toHaveBeenCalled()
  })

})

describe('Windows CLI install: substring match instead of an entry match', () => {

  bug.each([
    ['a sibling folder with the same prefix', kSquirrelExe, kSquirrelTarget, 'C:\\Users\\me\\AppData\\Local\\Witsy-beta'],
    ['a folder below the install folder', kSquirrelExe, kSquirrelTarget, 'C:\\Users\\me\\AppData\\Local\\Witsy\\app-3.0.0\\resources\\cli\\bin'],
    ['a longer folder name', kZipExe, kZipTarget, 'C:\\Program Files\\Witsy\\resources\\cli\\bin-old'],
  ])('the folder is added when the PATH only contains %s', async (_, exe, target, lookalike) => {
    // fails today: currentPath.includes(targetDir) is true for any entry that merely contains the folder
    // name, so the installer reports "already in PATH" and the witsy command is never reachable
    const { written } = await install(exe, `${kOtherEntries};${lookalike}`)
    expect(entries(written)).toContain(target)
  })

  bug.each([
    ['lower case', kSquirrelTarget.toLowerCase()],
    ['a lower-case drive letter', `c${kSquirrelTarget.slice(1)}`],
  ])('no duplicate entry is added when the folder is already there in %s', async (_, existing) => {
    // fails today: Windows paths are case-insensitive but the comparison is not, so the same folder is appended again
    expect((await install(kSquirrelExe, `${kOtherEntries};${existing}`)).written).toBeNull()
  })

})

describe('Windows CLI install: the PATH is never spliced into a PowerShell command line', () => {

  // The command used to run with { shell: 'powershell.exe' }, i.e. `powershell.exe -c <command>`, with
  // the PATH inside the double-quoted -Command "..." argument of that command. PowerShell expands
  // $name and $(...) and ends the string at a bare " inside double quotes. Each row is the piece of
  // an existing PATH entry that must not reach the command line without being escaped by a backtick.
  test.each([
    ['a dollar sign in a folder name', 'D:\\$tools\\bin', /(?<!`)\$tools/],
    ['a subexpression', 'D:\\$(Remove-Item x)\\bin', /(?<!`)\$\(/],
    ['a quoted entry', '"D:\\My Tools\\bin"', /(?<!`)"D:/],
  ])('an existing PATH entry with %s is not embedded raw', async (_, entry, raw) => {
    // S-27: the entry used to be copied verbatim into the command line, so PowerShell rewrote or
    // evaluated it. The existing PATH now stays inside PowerShell: neither the command line nor the
    // environment of the child process carries it.
    const { command, env, written } = await install(kZipExe, `${kOtherEntries};${entry}`)
    expect(command).not.toBeNull()
    expect(command).not.toMatch(raw)
    expect(env!.WITSY_CLI_DIR).toBe(kZipTarget)
    expect(written).toBe(`${kOtherEntries};${entry};${kZipTarget}`)
  })

})
