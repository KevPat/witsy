
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { execFileSync, execSync } from 'child_process'
import { app } from 'electron'
import { checkAndInstallCLI, retryInstallCLI } from '@main/cli_installer'
import * as config from '@main/config'

// The Windows branch is exercised on any OS: process.platform is stubbed, `path` is path.win32,
// and child_process is mocked so that no command ever runs.

vi.mock('child_process', () => {
  const mocked = { execSync: vi.fn(), execFileSync: vi.fn() }
  return { default: mocked, ...mocked }
})

vi.mock('fs', () => {
  const mocked = { copyFileSync: vi.fn() }
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

const kPowerShellArgs = ['-NoProfile', '-NonInteractive', '-Command']
const kReadScript = '[Environment]::GetEnvironmentVariable(\'Path\', \'User\')'
const kAppendScript = '[Environment]::SetEnvironmentVariable(\'Path\', ([Environment]::GetEnvironmentVariable(\'Path\', \'User\') + \';\' + $env:WITSY_CLI_DIR), \'User\')'

const kExe = 'C:\\Program Files\\Witsy\\Witsy.exe'
const kTarget = 'C:\\Program Files\\Witsy\\resources\\cli\\bin'

const kPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const install = async (exe: string, userPath: string) => {
  vi.mocked(app.getPath).mockReturnValue(exe)
  vi.mocked(execFileSync).mockImplementation(((_file: string, args: string[]) => {
    return args[args.length - 1] === kReadScript ? `${userPath}\r\n` : ''
  }) as any)
  await checkAndInstallCLI(false)
  return vi.mocked(execFileSync).mock.calls
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.mocked(config.loadSettings).mockReturnValue({ general: { cliInstallError: false } } as any)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', kPlatform)
})

describe('Windows CLI install', () => {

  test('reads and extends the user PATH with constant scripts and no shell', async () => {
    const calls = await install(kExe, 'C:\\Users\\me\\bin')
    expect(calls).toEqual([
      ['powershell.exe', [...kPowerShellArgs, kReadScript], { encoding: 'utf8' }],
      ['powershell.exe', [...kPowerShellArgs, kAppendScript], { env: { ...process.env, WITSY_CLI_DIR: kTarget } }],
    ])
    expect(execSync).not.toHaveBeenCalled()
  })

  test.each([
    ['a subexpression', 'C:\\Tools\\$(calc)'],
    ['a variable', 'C:\\$env:USERNAME\\$home'],
    ['a backtick', 'C:\\a`b'],
    ['a double quote and a statement', 'C:\\x";calc;"'],
    ['an apostrophe', 'C:\\it\'s'],
    ['an apostrophe and a statement', 'C:\\x\', \'User\'); calc; (\''],
    ['a percent variable', '%USERPROFILE%\\bin'],
  ])('an existing PATH entry with %s is handed to no command', async (_name, entry) => {
    const calls = await install(kExe, `C:\\Users\\me\\bin;${entry}`)
    expect(calls).toEqual([
      ['powershell.exe', [...kPowerShellArgs, kReadScript], { encoding: 'utf8' }],
      ['powershell.exe', [...kPowerShellArgs, kAppendScript], { env: { ...process.env, WITSY_CLI_DIR: kTarget } }],
    ])
    expect(JSON.stringify(calls)).not.toContain(JSON.stringify(entry).slice(1, -1))
    expect(execSync).not.toHaveBeenCalled()
  })

  test.each([
    ['a subexpression', 'C:\\Tools\\$(calc)'],
    ['a backtick', 'C:\\a`b'],
    ['an apostrophe and a statement', 'C:\\it\'s\', \'User\'); calc; (\''],
    ['a percent variable', 'C:\\%TEMP% $home'],
  ])('an install folder with %s travels in the environment only', async (_name, dir) => {
    const calls = await install(`${dir}\\Witsy.exe`, 'C:\\Users\\me\\bin')
    expect(calls).toEqual([
      ['powershell.exe', [...kPowerShellArgs, kReadScript], { encoding: 'utf8' }],
      ['powershell.exe', [...kPowerShellArgs, kAppendScript], { env: { ...process.env, WITSY_CLI_DIR: `${dir}\\resources\\cli\\bin` } }],
    ])
    expect(execSync).not.toHaveBeenCalled()
  })

  test('the PATH is only read when the folder is already there', async () => {
    const calls = await install(kExe, `C:\\Users\\me\\bin;${kTarget}`)
    expect(calls).toEqual([
      ['powershell.exe', [...kPowerShellArgs, kReadScript], { encoding: 'utf8' }],
    ])
  })

  test('a failing PATH update reports failure', async () => {
    vi.mocked(app.getPath).mockReturnValue(kExe)
    vi.mocked(execFileSync).mockImplementation(((_file: string, args: string[]) => {
      if (args[args.length - 1] === kReadScript) return ''
      throw new Error('access denied')
    }) as any)
    expect(await retryInstallCLI()).toEqual({ success: false })
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  test('a successful PATH update reports success', async () => {
    vi.mocked(app.getPath).mockReturnValue(kExe)
    vi.mocked(execFileSync).mockReturnValue('' as any)
    expect(await retryInstallCLI()).toEqual({ success: true })
  })

})
