import { ChildProcess, spawn } from 'child_process'
import { realpathSync } from 'fs'
import { sep } from 'path'
import PowerShell from 'powershell'

export const DEFAULT_TIMEOUT_MS = 15000
export const MAX_TIMEOUT_MS = 60000
const MAX_OUTPUT_LENGTH = 1024 * 1024 // 1MB
const KILL_GRACE_MS = 2000

export type ShellInfo = {
  shell: string
  platform: 'darwin' | 'linux' | 'win32'
}

export type ShellExecuteParams = {
  command: string
  cwd: string
  restrictToPath?: string
  timeoutMs?: number // Default: 15000ms (15s), enforced max: 60000ms (60s)
}

export type ShellExecuteResult = {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  error?: string
}

interface PathValidationResult {
  valid: boolean
  normalizedPath?: string
  error?: string
}

interface CommandAnalysis {
  isDangerous: boolean
  dangersDetected: string[]
  hasForbiddenOperators: boolean
  blockedCommand?: string  // e.g., "rm", "mv", "format" - if set, command is blocked
}

// Path validation with symlink resolution
export function validateWorkingDirectory(cwd: string, projectPath: string): PathValidationResult {
  try {
    // Resolve symlinks to real paths
    const realCwd = realpathSync(cwd)
    const realProject = realpathSync(projectPath)

    // Ensure trailing separator for safe prefix matching
    const projectPrefix = realProject.endsWith(sep) ? realProject : realProject + sep
    const cwdWithSep = realCwd.endsWith(sep) ? realCwd : realCwd + sep

    // Check if cwd is within project (or equals project)
    if (realCwd === realProject || cwdWithSep.startsWith(projectPrefix)) {
      return { valid: true, normalizedPath: realCwd }
    }

    return {
      valid: false,
      error: `Working directory ${cwd} is outside project directory ${projectPath}`
    }
  } catch (error: any) {
    return {
      valid: false,
      error: `Invalid path: ${error.message}`
    }
  }
}

// Blocked file operation commands (Unix + PowerShell)
const blockedFileCommands = [
  // Delete commands
  { regex: /\b(rm|rmdir)\b/i, command: 'rm' },
  { regex: /\b(Remove-Item|del|rd|ri)\b/i, command: 'Remove-Item' },
  // Move commands
  { regex: /\b(mv)\b/i, command: 'mv' },
  { regex: /\b(Move-Item|mi)\b/i, command: 'Move-Item' },
]

// Command analysis for dangerous patterns
export function analyzeCommand(command: string, restrictToPath?: string): CommandAnalysis {
  const dangersDetected: string[] = []
  let isDangerous = false
  let blockedCommand: string | undefined

  // In project context, block file operation commands
  if (restrictToPath) {
    for (const blocked of blockedFileCommands) {
      if (blocked.regex.test(command)) {
        blockedCommand = blocked.command
        break
      }
    }
  }

  // Check for dangerous patterns that warrant confirmation
  const dangerousPatterns = [
    { regex: /\brm\b.*-[rf]+/i, description: 'recursive file deletion (rm -rf)' },
    { regex: /\bdd\b/i, description: 'disk operations (dd)' },
    { regex: /\bformat\b/i, description: 'format command' },
    { regex: /\bmkfs\b/i, description: 'filesystem creation (mkfs)' },
    { regex: /\bfdisk\b/i, description: 'disk partitioning (fdisk)' },
    { regex: /:\(\)\{.*:\|:.*\};:/i, description: 'fork bomb' },
    { regex: />\s*\/dev\/sd/i, description: 'direct disk write' },
    { regex: /\bcurl\b.*\|\s*(bash|sh)/i, description: 'piped execution from remote source' },
    { regex: /\bwget\b.*\|\s*(bash|sh)/i, description: 'piped execution from remote source' },
    { regex: /\bsudo\b/i, description: 'privilege escalation (sudo)' },
    { regex: /\bsu\b/i, description: 'user switching (su)' },
    { regex: /\bchmod\b.*[+\\-]x/i, description: 'making files executable' },
  ]

  for (const pattern of dangerousPatterns) {
    if (pattern.regex.test(command)) {
      isDangerous = true
      dangersDetected.push(pattern.description)
    }
  }

  // Check for forbidden operators (&&, ||, ;)
  // Allow pipes (|) and redirects (>, >>)
  // COMMENTED OUT: Too restrictive - allow command chaining for now
  // const forbiddenOperators = /(&&|\|\||;(?!\s*$))/
  // const hasForbiddenOperators = forbiddenOperators.test(command)
  const hasForbiddenOperators = false

  // if (hasForbiddenOperators) {
  //   dangersDetected.push('command chaining operators (&&, ||, ;)')
  // }

  return {
    isDangerous: isDangerous, // || hasForbiddenOperators,
    dangersDetected,
    hasForbiddenOperators,
    blockedCommand
  }
}

export const getShellInfo = (): ShellInfo => {
  if (process.platform === 'win32') {
    return { shell: 'powershell', platform: 'win32' }
  }
  return {
    shell: process.env.SHELL || '/bin/bash',
    platform: process.platform as 'darwin' | 'linux'
  }
}

// Models send the timeout as a number, a numeric string or nothing at all, and Node turns a
// timer delay above 2^31-1 into 1ms: anything unusable becomes the default, the rest is capped
export const normalizeTimeout = (timeoutMs: unknown): number => {
  const value = typeof timeoutMs === 'string' && timeoutMs.trim() !== '' ? Number(timeoutMs) : timeoutMs
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.ceil(value), MAX_TIMEOUT_MS)
}

export const executeCommand = async (params: ShellExecuteParams): Promise<ShellExecuteResult> => {
  const { command, restrictToPath } = params
  const timeoutMs = normalizeTimeout(params.timeoutMs)
  let { cwd } = params

  // Validate working directory if restriction is enabled
  if (restrictToPath) {
    const validation = validateWorkingDirectory(cwd, restrictToPath)
    if (!validation.valid) {
      return {
        success: false,
        stdout: '',
        stderr: validation.error || 'Invalid working directory',
        exitCode: 1,
      }
    }
    // Use validated path
    cwd = validation.normalizedPath!
  }

  if (process.platform === 'win32') {
    return await executeWindows(command, cwd, timeoutMs)
  } else {
    return await executeUnix(command, cwd, timeoutMs)
  }
}

// The shell is the leader of its own process group (see `detached` below),
// so a negative pid reaches the shell and everything it started
const killProcessGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

const executeUnix = (command: string, cwd: string, timeoutMs: number): Promise<ShellExecuteResult> => {
  return new Promise((resolve) => {

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflow: string | null = null
    let settled = false
    let timeoutHandle: NodeJS.Timeout | undefined = undefined
    let killHandle: NodeJS.Timeout | undefined = undefined
    let giveUpHandle: NodeJS.Timeout | undefined = undefined

    const finish = (result: ShellExecuteResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(killHandle)
      clearTimeout(giveUpHandle)
      resolve(result)
    }

    const failure = (code: number | null): ShellExecuteResult => {
      if (timedOut) {
        // 124 is standard timeout exit code
        return { success: false, stdout, stderr, exitCode: 124, error: `Command timed out after ${timeoutMs}ms and was terminated` }
      }
      if (overflow) {
        return { success: false, stdout, stderr, exitCode: 1, error: overflow }
      }
      return { success: false, stdout, stderr, exitCode: typeof code === 'number' && code !== 0 ? code : 1, error: `Command failed: ${command}\n${stderr}` }
    }

    let child: ChildProcess
    try {
      child = spawn(process.env.SHELL || '/bin/bash', ['-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error: any) {
      resolve({ success: false, stdout, stderr, exitCode: 1, error: error.message })
      return
    }

    // stops the shell and its children, harder if they do not go away,
    // and stops waiting if something still holds the output open after that
    const terminate = () => {
      killProcessGroup(child.pid, 'SIGTERM')
      killHandle = setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
      giveUpHandle = setTimeout(() => finish(failure(null)), KILL_GRACE_MS * 2)
    }

    const append = (current: string, chunk: string, name: string): string => {
      if (overflow) return current
      if (current.length + chunk.length > MAX_OUTPUT_LENGTH) {
        overflow = `${name} maxBuffer length exceeded`
        terminate()
        return current + chunk.slice(0, MAX_OUTPUT_LENGTH - current.length)
      }
      return current + chunk
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout = append(stdout, chunk, 'stdout') })
    child.stderr?.on('data', (chunk: string) => { stderr = append(stderr, chunk, 'stderr') })

    child.on('error', (error: Error) => {
      finish({ success: false, stdout, stderr, exitCode: 1, error: error.message })
    })

    child.on('close', (code: number | null) => {
      if (timedOut || overflow) {
        // whatever survived the first signal and let go of the output
        killProcessGroup(child.pid, 'SIGKILL')
        finish(failure(code))
      } else if (code === 0) {
        finish({ success: true, stdout, stderr, exitCode: 0 })
      } else {
        finish(failure(code))
      }
    })

    timeoutHandle = setTimeout(() => {
      if (settled || overflow) return
      timedOut = true
      terminate()
    }, timeoutMs)

  })
}

// taskkill /T ends the process and the processes it started; without it only PowerShell goes away
const killWindowsProcessTree = (proc: ChildProcess | undefined): void => {
  if (!proc) return
  const killShell = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  if (!proc.pid) {
    killShell()
    return
  }
  try {
    const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', killShell)
  } catch {
    killShell()
  }
}

const executeWindows = async (command: string, cwd: string, timeoutMs: number): Promise<ShellExecuteResult> => {
  return new Promise((resolve) => {
    // PowerShell library doesn't support cwd option, so we prepend Set-Location
    // Escape single quotes in path by doubling them
    const escapedCwd = cwd.replace(/'/g, "''")
    const fullCommand = `Set-Location -LiteralPath '${escapedCwd}'; ${command}`
    const ps = new PowerShell(fullCommand)
    let stdout = ''
    let stderr = ''
    let isTimedOut = false
    let hasEnded = false

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      if (!hasEnded) {
        isTimedOut = true
        killWindowsProcessTree((ps as any).proc) // Kill the PowerShell process and its children
        resolve({
          success: false,
          stdout,
          stderr,
          exitCode: 124, // Standard timeout exit code
          error: `Command timed out after ${timeoutMs}ms and was terminated`
        })
      }
    }, timeoutMs)
    ps.on('output', (data: string) => {
      stdout += data
    })

    ps.on('error-output', (data: string) => {
      stderr += data
    })

    ps.on('error', (err: any) => {
      hasEnded = true
      clearTimeout(timeoutHandle)
      if (!isTimedOut) {
        resolve({
          success: false,
          stdout,
          stderr,
          exitCode: 1,
          error: err.message
        })
      }
    })

    ps.on('end', (code: number) => {
      hasEnded = true
      clearTimeout(timeoutHandle)
      if (!isTimedOut) {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code || 0
        })
      }
    })
  })
}
