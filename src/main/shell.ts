import { ChildProcess, spawn } from 'child_process'
import { statSync } from 'fs'
import PowerShell from 'powershell'
import { isPathInside, resolveRealPath } from './path_containment'

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
    if (typeof cwd !== 'string' || !cwd.length || typeof projectPath !== 'string' || !projectPath.length) {
      return { valid: false, error: `Invalid path: ${String(cwd)}` }
    }

    const realCwd = resolveRealPath(cwd)
    const realProject = resolveRealPath(projectPath)

    // resolveRealPath accepts paths that do not exist yet, a working directory has to exist
    if (!statSync(realCwd).isDirectory()) {
      return { valid: false, error: `Invalid path: ${cwd} is not a directory` }
    }

    if (isPathInside(realCwd, realProject)) {
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

// Command analysis: ADVISORY ONLY, NOT A SECURITY BOUNDARY.
//
// It recognizes the usual spelling of a few destructive commands so that a caller can
// refuse them (and, in a project, send the model to the tracked delete/move actions).
// A shell command can always be written in a way that is not recognized here (an
// interpreter, a variable, an encoding...), so nothing may rely on the result to confine
// a command: what protects a working directory is that commands are only run when it
// was shared read-write (see CliPlugin).

type SimpleCommand = {
  words: string[]
  redirects: string[]
  // what runs inside $( ), backticks and <( ), with the text of the substitution
  nested: { raw: string, pipelines: SimpleCommand[][] }[]
}

type Invocation = {
  name: string
  args: string[]
}

type Stage = {
  invocations: Invocation[]
  redirects: string[]
  // commands whose output is a whole argument, as in sh -c "$(curl ...)" or bash <(curl ...)
  substituted: string[]
}

const MAX_ANALYSIS_DEPTH = 8

const RESERVED_WORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

// commands that run the command found in their arguments, with the short options that take a value
const WRAPPERS = new Map<string, { valueOptions: string, positionals?: number }>([
  ['sudo', { valueOptions: 'CDghpRrTtUu' }],
  ['doas', { valueOptions: 'Cu' }],
  ['env', { valueOptions: 'Cu' }],
  ['xargs', { valueOptions: 'adEILnPs' }],
  ['nice', { valueOptions: 'n' }],
  ['timeout', { valueOptions: 'ks', positionals: 1 }],
  ['nohup', { valueOptions: '' }],
  ['exec', { valueOptions: 'a' }],
])

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh'])
const WINDOWS_SHELLS = new Set(['powershell', 'pwsh', 'cmd'])
const EVALUATORS = new Set(['eval', 'iex', 'invoke-expression'])
const SOURCERS = new Set(['source', '.'])
const SCRIPT_INTERPRETER = /^(python|perl|ruby|node|php)[\d.]*$/
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod'])

// Blocked file operation commands (Unix + PowerShell)
const BLOCKED_FILE_COMMANDS = new Map<string, string>([
  // Delete commands
  ['rm', 'rm'], ['rmdir', 'rm'], ['unlink', 'rm'],
  ['remove-item', 'Remove-Item'], ['del', 'Remove-Item'], ['erase', 'Remove-Item'], ['rd', 'Remove-Item'], ['ri', 'Remove-Item'],
  // Move commands
  ['mv', 'mv'],
  ['move-item', 'Move-Item'], ['mi', 'Move-Item'], ['move', 'Move-Item'],
])

const findClosing = (input: string, start: number, windows: boolean): number => {
  const escape = windows ? '`' : '\\'
  let depth = 1
  for (let i = start; i < input.length; i++) {
    const c = input[i]
    if (c === escape) {
      i++
    } else if (c === '\'') {
      const end = input.indexOf('\'', i + 1)
      if (end === -1) return input.length
      i = end
    } else if (c === '"') {
      for (i++; i < input.length && input[i] !== '"'; i++) {
        if (input[i] === escape) i++
      }
    } else if (c === '(') {
      depth++
    } else if (c === ')' && --depth === 0) {
      return i
    }
  }
  return input.length
}

// Splits a command line into pipelines of simple commands. This is a tokenizer, not a
// shell parser: quotes, escapes, separators, redirections and substitutions, nothing else.
const parseCommandLine = (input: string, windows: boolean, depth = 0): SimpleCommand[][] => {

  const escape = windows ? '`' : '\\'
  const pipelines: SimpleCommand[][] = []
  let pipeline: SimpleCommand[] = []
  let current: SimpleCommand = { words: [], redirects: [], nested: [] }
  let word = ''
  let hasWord = false
  let redirect: 'in' | 'out' | null = null

  const endWord = () => {
    if (!hasWord) return
    if (redirect === 'out') current.redirects.push(word)
    else if (redirect === null) current.words.push(word)
    redirect = null
    word = ''
    hasWord = false
  }

  const endCommand = () => {
    endWord()
    redirect = null
    if (current.words.length || current.redirects.length || current.nested.length) {
      pipeline.push(current)
    }
    current = { words: [], redirects: [], nested: [] }
  }

  const endPipeline = () => {
    endCommand()
    if (pipeline.length) pipelines.push(pipeline)
    pipeline = []
  }

  // returns the index of the last character of the substitution
  const substitution = (open: number, bodyStart: number, close: number): number => {
    if (depth < MAX_ANALYSIS_DEPTH) {
      current.nested.push({
        raw: input.slice(open, close + 1),
        pipelines: parseCommandLine(input.slice(bodyStart, close), windows, depth + 1),
      })
    }
    word += input.slice(open, close + 1)
    hasWord = true
    return close
  }

  const backticks = (open: number): number => {
    const end = input.indexOf('`', open + 1)
    return substitution(open, open + 1, end === -1 ? input.length : end)
  }

  for (let i = 0; i < input.length; i++) {

    const c = input[i]
    const next = input[i + 1]

    if (c === escape) {
      // an escaped newline continues the line
      if (next !== undefined && next !== '\n') {
        word += next
        hasWord = true
      }
      i++
    } else if (c === '\'') {
      const end = input.indexOf('\'', i + 1)
      const close = end === -1 ? input.length : end
      word += input.slice(i + 1, close)
      hasWord = true
      i = close
    } else if (c === '"') {
      hasWord = true
      for (i++; i < input.length && input[i] !== '"'; i++) {
        if (input[i] === escape && i + 1 < input.length) {
          word += input[++i]
        } else if (input[i] === '$' && input[i + 1] === '(') {
          i = substitution(i, i + 2, findClosing(input, i + 2, windows))
        } else if (input[i] === '`' && !windows) {
          i = backticks(i)
        } else {
          word += input[i]
        }
      }
    } else if (c === '$' && next === '\'') {
      // $'...' is a quoted word
    } else if ((c === '$' || c === '<' || c === '>') && next === '(') {
      i = substitution(i, i + 2, findClosing(input, i + 2, windows))
    } else if (c === '`') {
      i = backticks(i)
    } else if (c === '#' && !hasWord) {
      const end = input.indexOf('\n', i)
      i = end === -1 ? input.length : end - 1
    } else if (c === ';' || c === '\n' || c === '(' || c === ')' || (windows && (c === '{' || c === '}'))) {
      endPipeline()
    } else if (c === '&' && next === '>') {
      endWord()
      i += input[i + 2] === '>' ? 2 : 1
      redirect = 'out'
    } else if (c === '&') {
      if (next === '&') i++
      endPipeline()
    } else if (c === '|' && next === '|') {
      i++
      endPipeline()
    } else if (c === '|') {
      if (next === '&') i++
      endCommand()
    } else if (c === '>' || c === '<') {
      // "2>" is a file descriptor, not an argument
      if (/^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }
      endWord()
      while (input[i + 1] === c) i++
      if (input[i + 1] === '&' || input[i + 1] === '|') i++
      redirect = c === '>' ? 'out' : 'in'
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
      hasWord = true
    }

  }

  endPipeline()
  return pipelines

}

// "/bin/rm" and "C:\Windows\System32\format.com" are "rm" and "format"
const commandName = (word: string): string => {
  const base = word.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '')
}

// The commands a simple command runs: itself, what a wrapper such as sudo or xargs
// runs, what find -exec runs. Command lines given as a string (sh -c, eval) are
// added to `inner` for the caller to analyze.
const expandWords = (words: string[], windows: boolean, inner: SimpleCommand[][], depth = 0): Invocation[] => {

  let start = 0
  while (start < words.length && (RESERVED_WORDS.has(words[start]) || ASSIGNMENT.test(words[start]))) start++
  if (start >= words.length) return []

  const name = commandName(words[start])
  const args = words.slice(start + 1)
  const invocations: Invocation[] = [{ name, args }]
  if (depth >= MAX_ANALYSIS_DEPTH) return invocations

  const wrapper = WRAPPERS.get(name)
  if (wrapper) {
    let index = 0
    let positionals = wrapper.positionals ?? 0
    for (; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--') {
        index++
        break
      }
      if (arg.length > 1 && arg.startsWith('-')) {
        if (arg.length === 2 && wrapper.valueOptions.includes(arg[1])) index++
      } else if (!ASSIGNMENT.test(arg) && positionals-- <= 0) {
        break
      }
    }
    invocations.push(...expandWords(args.slice(index), windows, inner, depth + 1))
  }

  if (name === 'find') {
    for (let index = 0; index < args.length; index++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(args[index])) {
        const end = args.findIndex((arg, i) => i > index && (arg === ';' || arg === '+'))
        invocations.push(...expandWords(args.slice(index + 1, end === -1 ? args.length : end), windows, inner, depth + 1))
      }
    }
  }

  let script: string | undefined
  if (POSIX_SHELLS.has(name)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c$/i.test(arg))
    if (flag !== -1) script = args[flag + 1]
  } else if (WINDOWS_SHELLS.has(name)) {
    const flag = args.findIndex((arg) => /^(-c|-command|\/c|\/k)$/i.test(arg))
    if (flag !== -1) script = args.slice(flag + 1).join(' ')
  } else if (EVALUATORS.has(name)) {
    script = args.join(' ')
  }
  if (script) {
    inner.push(...parseCommandLine(script, windows, depth + 1))
  }

  return invocations

}

// Adds all the pipelines of a command line to `all`, the nested ones included,
// and returns the names of the commands they run
const collectPipelines = (pipelines: SimpleCommand[][], windows: boolean, all: Stage[][], depth = 0): string[] => {
  const names: string[] = []
  if (depth > MAX_ANALYSIS_DEPTH) return names
  for (const pipeline of pipelines) {
    const stages: Stage[] = []
    for (const command of pipeline) {
      const inner: SimpleCommand[][] = []
      const invocations = expandWords(command.words, windows, inner)
      const substituted: string[] = []
      names.push(...invocations.map((invocation) => invocation.name))
      names.push(...collectPipelines(inner, windows, all, depth + 1))
      for (const nested of command.nested) {
        const nestedNames = collectPipelines(nested.pipelines, windows, all, depth + 1)
        if (command.words.includes(nested.raw)) substituted.push(...nestedNames)
        names.push(...nestedNames)
      }
      stages.push({ invocations, redirects: command.redirects, substituted })
    }
    all.push(stages)
  }
  return names
}

const executesArguments = ({ name }: Invocation): boolean => {
  return POSIX_SHELLS.has(name) || WINDOWS_SHELLS.has(name) || EVALUATORS.has(name) || SOURCERS.has(name)
}

// a shell runs what it is given, python and the like only run their input when no script is named
const executesInput = (invocation: Invocation): boolean => {
  if (executesArguments(invocation)) return true
  return SCRIPT_INTERPRETER.test(invocation.name) && (invocation.args.length === 0 || invocation.args[0] === '-')
}

const describeDangers = ({ name, args }: Invocation): string[] => {
  const dangers: string[] = []
  if (name === 'rm' && args.some((arg) => /^-[a-z]*[rf][a-z]*$/i.test(arg) || /^--(recursive|force)$/.test(arg))) {
    dangers.push('recursive file deletion (rm -rf)')
  }
  if (name === 'dd') dangers.push('disk operations (dd)')
  if (name === 'format') dangers.push('format command')
  if (name === 'mkfs' || name.startsWith('mkfs.')) dangers.push('filesystem creation (mkfs)')
  if (name === 'fdisk') dangers.push('disk partitioning (fdisk)')
  if (name === 'sudo') dangers.push('privilege escalation (sudo)')
  if (name === 'su') dangers.push('user switching (su)')
  if (name === 'chmod' && args.some((arg) => /[+=][rwst]*x/i.test(arg))) dangers.push('making files executable')
  return dangers
}

export function analyzeCommand(command: string, restrictToPath?: string, platform: string = process.platform): CommandAnalysis {
  const dangersDetected: string[] = []
  let blockedCommand: string | undefined

  const flag = (danger: string) => {
    if (!dangersDetected.includes(danger)) dangersDetected.push(danger)
  }

  const windows = platform === 'win32'
  const pipelines: Stage[][] = []
  if (typeof command === 'string') {
    collectPipelines(parseCommandLine(command, windows), windows, pipelines)
    if (/:\(\)\{.*:\|:.*\};:/.test(command)) flag('fork bomb')
  }

  for (const pipeline of pipelines) {
    pipeline.forEach((stage, index) => {

      for (const invocation of stage.invocations) {

        // In project context, block file operation commands
        if (restrictToPath && !blockedCommand) {
          blockedCommand = BLOCKED_FILE_COMMANDS.get(invocation.name)
          if (invocation.name === 'find' && invocation.args.includes('-delete')) blockedCommand = 'find -delete'
        }

        describeDangers(invocation).forEach(flag)

      }

      if (stage.redirects.some((target) => /^\/dev\/(sd|hd|nvme|mmcblk|r?disk)/i.test(target))) {
        flag('direct disk write')
      }

      const piped = pipeline.slice(0, index).some((previous) => previous.invocations.some(({ name }) => DOWNLOADERS.has(name)))
      const substituted = stage.substituted.some((name) => DOWNLOADERS.has(name))
      if ((piped && stage.invocations.some(executesInput)) || (substituted && stage.invocations.some(executesArguments))) {
        flag('piped execution from remote source')
      }

    })
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
    isDangerous: dangersDetected.length > 0, // || hasForbiddenOperators,
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
