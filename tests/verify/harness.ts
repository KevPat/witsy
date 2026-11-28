//
// Shared helpers of the verification suites (npm run verify, see VERIFY.md).
//
// The suites drive the PACKAGED app (electron-forge package), not the dev server: what they check is
// what a user gets. Every launch is isolated in a temporary folder (WITSY_HOME and --user-data-dir),
// so a Witsy installed on the same computer, its settings and its key store are never touched.
// Only made-up keys (DUMMY_KEYS) are ever written.
//

import { _electron as electron, ElectronApplication, Page } from 'playwright'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const repoRoot = path.resolve(__dirname, '../..')
export const reportRoot = path.join(repoRoot, 'verify-report')
export const outRoot = path.join(repoRoot, 'out', 'verify')

export type BuildVariant = 'test' | 'release' | 'release-node'

export const kDefaultWorkspaceId = '00000000-0000-0000-0000-000000000000'

// made-up secrets: a suite fails if one of them leaves the folder it was written to
export const DUMMY_KEYS = {
  openai: 'sk-verifyDUMMYopenai0000000000000000000000',
  anthropic: 'sk-ant-verifyDUMMYanthropic111111111111111',
  mcpEnv: 'verifyDUMMYmcpEnv2222222222222222',
  mcpHeader: 'verifyDUMMYmcpHeader3333333333333',
  otherMachine: 'sk-verifyDUMMYotherMachine44444444444444444',
  oldBackup: 'sk-verifyDUMMYoldBackup55555555555555555555',
}

export const buildFolder = (variant: BuildVariant): string => {
  return path.join(outRoot, variant, `Witsy-${process.platform}-${process.arch}`)
}

export const executablePath = (variant: BuildVariant): string => {
  const root = buildFolder(variant)
  if (process.platform === 'darwin') return path.join(root, 'Witsy.app', 'Contents', 'MacOS', 'Witsy')
  if (process.platform === 'win32') return path.join(root, 'Witsy.exe')
  return path.join(root, 'witsy')
}

export const resourcesPath = (variant: BuildVariant): string => {
  const root = buildFolder(variant)
  if (process.platform === 'darwin') return path.join(root, 'Witsy.app', 'Contents', 'Resources')
  return path.join(root, 'resources')
}

export const hasBuild = (variant: BuildVariant): boolean => fs.existsSync(executablePath(variant))

export const artifactsDir = (suite: string): string => {
  const dir = path.join(reportRoot, 'artifacts', suite)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// details of a suite (numbers, paths of artifacts...) next to the test results of vitest
export const record = (suite: string, data: Record<string, unknown>): void => {
  fs.mkdirSync(reportRoot, { recursive: true })
  const file = path.join(reportRoot, `${suite}.details.json`)
  let current: Record<string, unknown> = {}
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first record */ }
  fs.writeFileSync(file, JSON.stringify({ ...current, ...data, platform: `${process.platform}-${process.arch}` }, null, 2))
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const waitFor = async <T>(fn: () => T | Promise<T>, timeout = 15000, interval = 200): Promise<T> => {
  const start = Date.now()
  let last: unknown
  while (Date.now() - start < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) { last = error }
    await sleep(interval)
  }
  throw new Error(`timed out after ${timeout} ms${last ? `: ${last}` : ''}`)
}

const isPlainObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const deepMerge = (a: Record<string, any>, b: Record<string, any>): Record<string, any> => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(v) && isPlainObject(a[k]) ? deepMerge(a[k], v) : v
  }
  return out
}

export type HomeOptions = {
  settings?: Record<string, any>
  history?: Record<string, any>
}

// a fresh user data folder, with the onboarding done and the http server on a free port
export const makeHome = (name: string, options: HomeOptions = {}): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `witsy-verify-${name}-`))
  const port = 20000 + crypto.randomInt(20000)
  const settings = deepMerge({ general: { onboardingDone: true, httpPort: port }, appearance: { theme: 'light' } }, options.settings || {})
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2))
  if (options.history) {
    const folder = path.join(home, 'workspaces', kDefaultWorkspaceId)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'history.json'), JSON.stringify(options.history, null, 2))
  }
  return home
}

export const historyFile = (home: string) => path.join(home, 'workspaces', kDefaultWorkspaceId, 'history.json')

export const message = (role: 'user' | 'assistant', content: string, extra: Record<string, any> = {}) => ({
  uuid: crypto.randomUUID(),
  type: 'text',
  role,
  content,
  createdAt: Date.now(),
  engine: 'openai',
  model: 'gpt-4.1',
  attachments: [],
  toolCalls: [],
  transient: false,
  ...extra,
})

export const chat = (title: string, messages: any[]) => ({
  uuid: crypto.randomUUID(),
  title,
  createdAt: Date.now(),
  lastModified: Date.now(),
  engine: 'openai',
  model: 'gpt-4.1',
  messages: [message('system' as any, 'You are a helpful assistant'), ...messages],
  temporary: false,
  disableStreaming: false,
  tools: null,
  modelOpts: undefined,
  locale: undefined,
  instructions: undefined,
})

export const historyWith = (chats: any[]) => ({ version: 1, folders: [], chats, quickPrompts: [] })

export type LaunchedApp = {
  app: ElectronApplication
  window: Page
  logs: string[]
  close: () => Promise<void>
}

export const isMainWindowUrl = (url: string) => url.includes('main_window') && /[?&]view=/.test(url) || url.endsWith('main_window/index.html')

export const mainWindow = async (app: ElectronApplication, timeout = 60000): Promise<Page> => {
  return waitFor(() => app.windows().find((p) => isMainWindowUrl(p.url())), timeout)
}

export const launchApp = async (home: string, options: { env?: Record<string, string>, waitForMain?: boolean } = {}): Promise<LaunchedApp> => {
  if (!hasBuild('test')) {
    throw new Error(`no test build in ${buildFolder('test')}: run npm run verify:build first`)
  }
  const logs: string[] = []
  const env: Record<string, string> = { ...process.env as Record<string, string>, WITSY_HOME: home, TEST: '1', ...(options.env || {}) }
  delete env.DEBUG
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: executablePath('test'),
    args: [`--user-data-dir=${home}`],
    env,
    timeout: 90000,
  })
  const watchPage = (page: Page) => {
    page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`))
  }
  app.windows().forEach(watchPage)
  app.on('window', watchPage)
  app.process().stdout?.on('data', (d) => logs.push(`[main] ${String(d).trim()}`))
  app.process().stderr?.on('data', (d) => logs.push(`[main:err] ${String(d).trim()}`))
  let window: Page = null as any
  if (options.waitForMain !== false) {
    window = await mainWindow(app)
    await window.waitForSelector('.main-window', { timeout: 60000 })
  }
  const close = async () => {
    try {
      await Promise.race([app.close(), sleep(15000)])
    } catch { /* already gone */ }
    try { app.process().kill('SIGKILL') } catch { /* already gone */ }
  }
  return { app, window, logs, close }
}

// the native dialogs of the main process answer by themselves (the suites never wait on a person)
export const stubDialogs = async (app: ElectronApplication, answers: { openPaths?: string[], savePath?: string, messageBoxResponse?: number }) => {
  await app.evaluate(({ dialog }, answers) => {
    const g = globalThis as any
    g.__verifyDialogs = g.__verifyDialogs || []
    const log = (kind: string, opts: any) => g.__verifyDialogs.push({ kind, title: opts?.title, message: opts?.message, detail: opts?.detail })
    dialog.showOpenDialogSync = ((...args: any[]) => { log('open', args[args.length - 1]); return answers.openPaths }) as any
    dialog.showOpenDialog = (async (...args: any[]) => { log('open', args[args.length - 1]); return { canceled: !answers.openPaths, filePaths: answers.openPaths || [] } }) as any
    dialog.showSaveDialogSync = ((...args: any[]) => { log('save', args[args.length - 1]); return answers.savePath }) as any
    dialog.showSaveDialog = (async (...args: any[]) => { log('save', args[args.length - 1]); return { canceled: !answers.savePath, filePath: answers.savePath } }) as any
    dialog.showMessageBoxSync = ((...args: any[]) => { log('message', args[args.length - 1]); return answers.messageBoxResponse ?? 0 }) as any
    dialog.showMessageBox = (async (...args: any[]) => { log('message', args[args.length - 1]); return { response: answers.messageBoxResponse ?? 0, checkboxChecked: false } }) as any
    dialog.showErrorBox = ((title: string, content: string) => { log('error', { title, message: content }) }) as any
  }, answers)
}

export const dialogsShown = async (app: ElectronApplication): Promise<any[]> => {
  return app.evaluate(() => (globalThis as any).__verifyDialogs || [])
}

// every file under a folder, with its content
export const walkFiles = (root: string): string[] => {
  const files: string[] = []
  if (!fs.existsSync(root)) return files
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(full))
    else files.push(full)
  }
  return files
}

// which of the secrets appear in which files (raw bytes, utf-8 and utf-16)
export const findSecrets = (files: string[], secrets: string[]): { file: string, secret: string }[] => {
  const hits: { file: string, secret: string }[] = []
  for (const file of files) {
    const data = fs.readFileSync(file)
    for (const secret of secrets) {
      if (data.includes(Buffer.from(secret, 'utf8')) || data.includes(Buffer.from(secret, 'utf16le'))) {
        hits.push({ file, secret })
      }
    }
  }
  return hits
}

export const commandExists = (command: string): boolean => {
  const probe = process.platform === 'win32' ? spawnSync('where', [command]) : spawnSync('sh', ['-c', `command -v ${command}`])
  return probe.status === 0
}

// the lines of the log of a launch that say the content security policy refused something
export const cspRefusals = (logs: string[]) => logs.filter((line) => /Refused to|Content Security Policy|securitypolicyviolation/i.test(line))
