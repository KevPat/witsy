import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { executeCommand } from '@main/shell'

// PowerShell double: the test decides when it produces output and when it ends
class FakeProc extends EventEmitter {
  pid: number | undefined = 4242
  kill = vi.fn()
}

class FakePowerShell extends EventEmitter {
  proc = new FakeProc()
  constructor(public command: string) {
    super()
    shells.push(this)
  }
}

const shells: FakePowerShell[] = []

vi.mock('powershell', () => ({
  default: vi.fn((command: string) => new FakePowerShell(command)),
}))

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events')
  const spawn = vi.fn(() => new EventEmitter())
  return { default: { spawn }, spawn }
})

const platform = process.platform

beforeEach(() => {
  shells.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: platform })
})

describe('shell executeCommand on Windows', () => {

  test('runs the command in the working directory and returns its output', async () => {
    const promise = executeCommand({ command: 'Get-ChildItem', cwd: `C:\\Users\\it's me` })
    expect(shells[0].command).toBe(`Set-Location -LiteralPath 'C:\\Users\\it''s me'; Get-ChildItem`)
    shells[0].emit('output', 'file.txt')
    shells[0].emit('end', 0)
    expect(await promise).toEqual({ success: true, stdout: 'file.txt', stderr: '', exitCode: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('a timed out command is ended with the processes it started', async () => {
    const promise = executeCommand({ command: 'Start-Sleep 100', cwd: 'C:\\', timeoutMs: 500 })
    shells[0].emit('error-output', 'partial')
    await vi.advanceTimersByTimeAsync(500)
    expect(await promise).toEqual({
      success: false, stdout: '', stderr: 'partial', exitCode: 124,
      error: 'Command timed out after 500ms and was terminated',
    })
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    expect(shells[0].proc.kill).not.toHaveBeenCalled()
  })

  test('the shell is killed directly when taskkill cannot be started', async () => {
    const promise = executeCommand({ command: 'Start-Sleep 100', cwd: 'C:\\', timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    await promise
    vi.mocked(spawn).mock.results[0].value.emit('error', new Error('spawn taskkill ENOENT'))
    expect(shells[0].proc.kill).toHaveBeenCalledTimes(1)
  })

  test('the shell is killed directly when taskkill throws or the shell has no pid', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('spawn failed') })
    const first = executeCommand({ command: 'Start-Sleep 100', cwd: 'C:\\', timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    expect((await first).exitCode).toBe(124)
    expect(shells[0].proc.kill).toHaveBeenCalledTimes(1)

    const second = executeCommand({ command: 'Start-Sleep 100', cwd: 'C:\\', timeoutMs: 500 })
    shells[1].proc.pid = undefined
    await vi.advanceTimersByTimeAsync(500)
    expect((await second).exitCode).toBe(124)
    expect(shells[1].proc.kill).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('a timeout above the maximum is capped at 60 seconds instead of firing at once', async () => {
    let settled = false
    const promise = executeCommand({ command: 'Start-Sleep 100', cwd: 'C:\\', timeoutMs: 1e12 }).then((result) => { settled = true; return result })
    await vi.advanceTimersByTimeAsync(59999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await promise).error).toBe('Command timed out after 60000ms and was terminated')
  })

  test('a command that ends after its timeout does not report twice', async () => {
    const promise = executeCommand({ command: 'Start-Sleep 100', cwd: 'C:\\', timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    shells[0].emit('end', 1)
    expect((await promise).exitCode).toBe(124)
  })

  test('a shell that cannot be started is reported', async () => {
    const promise = executeCommand({ command: 'Get-ChildItem', cwd: 'C:\\' })
    shells[0].emit('error', new Error('spawn powershell.exe ENOENT'))
    expect(await promise).toEqual({ success: false, stdout: '', stderr: '', exitCode: 1, error: 'spawn powershell.exe ENOENT' })
    expect(vi.getTimerCount()).toBe(0)
  })

})
