import { app, BrowserWindow, session, Session } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { kSandboxApi, kSandboxCsp, kSandboxOrigin, kSandboxPage, kSandboxPagePath, kSandboxRunner, kSandboxRunnerPath } from './pyodide_sandbox'

/**
 * Pyodide Manager - Runs Python (WebAssembly) in a sandboxed renderer process
 *
 * Security model:
 * - Pyodide is never loaded in the main process. It runs in a hidden window whose renderer has the
 *   Chromium sandbox on, no preload script, no Node.js integration and a session of its own.
 * - That session answers one made-up https origin with the runtime files and refuses everything
 *   else: Python (or JavaScript it manages to run) has no network, no file system, no IPC.
 * - The main process only sends the script as a string and reads back { result } or { error }.
 *   A JavaScript object that Python gets hold of leads to the page of the sandbox, not to the app.
 *
 * Features:
 * - Lazy loading: the sandbox is only created on first use
 * - Memory TTL: the sandbox is destroyed after 15 minutes of inactivity
 * - File caching: the runtime and the packages are downloaded once and cached on disk
 * - Time limit: a script that does not finish in time is stopped with its sandbox
 *
 * Usage:
 * - Call runPythonCode() to execute Python scripts
 * - First call may download ~12MB plus the packages (cached for subsequent app launches)
 * - Subsequent calls reuse the sandbox
 */

// Configuration
const PYODIDE_CONFIG = {
  version: '0.29.0',
  memoryTTL: 15 * 60 * 1000,  // 15 minutes of inactivity
  cacheDir: 'pyodide-cache',
  cdnURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/',  // Only used for downloads
  initTimeout: 10 * 60 * 1000,  // first use downloads the packages
  runTimeout: 5 * 60 * 1000,
}

const PYODIDE_PACKAGES = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'statsmodels', 'matplotlib']

const FILES_TO_CACHE = [
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide.asm.js',
  'pyodide-lock.json',
  'pyodide.js',
  'pyodide.mjs',
]

const kLockFile = 'pyodide-lock.json'

// in-memory session (no `persist:` prefix) used by the sandbox window and nothing else
const kSandboxPartition = 'pyodide-sandbox'

const kContentTypes: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
}

// Runtime state
let sandboxWindow: BrowserWindow | null = null
let sandboxSession: Session | null = null
let initializationPromise: Promise<BrowserWindow> | null = null
let disposalTimer: NodeJS.Timeout | null = null
let lastUsedTime: number = 0
let lockedFiles: Map<string, string> | null = null
let queue: Promise<unknown> = Promise.resolve()

/**
 * Get cache directory path
 */
function getCacheDirectory(): string {
  return path.join(
    app.getPath('userData'),
    PYODIDE_CONFIG.cacheDir,
    PYODIDE_CONFIG.version
  )
}

function isFileCached(filename: string): boolean {
  try {
    const filePath = path.join(getCacheDirectory(), filename)
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0
  } catch {
    return false
  }
}

/**
 * Check if all required files exist in cache
 */
function isCacheComplete(): boolean {
  return FILES_TO_CACHE.every(isFileCached)
}

/**
 * Clear the entire Pyodide cache
 */
export function clearPyodideCache(): boolean {
  const cacheDir = getCacheDirectory()

  try {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true })
      console.log('[Pyodide] Cache cleared at', cacheDir)
    }
    lockedFiles = null
    return true
  } catch (error) {
    console.warn('[Pyodide] Failed to clear cache:', error)
    return false
  }
}

/**
 * Download a single file from CDN, cache it and return its bytes.
 * `sha256` is known for the packages (from the lock file), not for the runtime itself.
 */
async function downloadFile(filename: string, cacheDir: string, sha256?: string): Promise<Buffer> {
  const url = `${PYODIDE_CONFIG.cdnURL}${encodeURIComponent(filename)}`
  const destPath = path.join(cacheDir, filename)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${filename}: ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (sha256 && crypto.createHash('sha256').update(buffer).digest('hex') !== sha256.toLowerCase()) {
    throw new Error(`Failed to download ${filename}: checksum mismatch`)
  }

  await fs.promises.mkdir(cacheDir, { recursive: true })
  await fs.promises.writeFile(destPath, buffer)

  console.log(`[Pyodide] Cached ${filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
  return buffer
}

/**
 * Download and cache all Pyodide files
 */
async function downloadAndCacheFiles(): Promise<void> {
  const cacheDir = getCacheDirectory()

  console.log('[Pyodide] Downloading runtime files...')

  // Create cache directory
  await fs.promises.mkdir(cacheDir, { recursive: true })

  // Download all files
  for (const file of FILES_TO_CACHE) {
    await downloadFile(file, cacheDir)
  }

  lockedFiles = null
  console.log('[Pyodide] All files cached successfully')
}

/**
 * Ensure cache exists, download if needed
 */
async function ensureCacheExists(): Promise<string> {
  const cacheDir = getCacheDirectory()

  if (isCacheComplete()) {
    console.log('[Pyodide] Using cached files from', cacheDir)
    return cacheDir
  }

  console.log('[Pyodide] Cache incomplete, downloading...')
  await downloadAndCacheFiles()

  return cacheDir
}

/**
 * The package files of this Pyodide version and their checksums, from the cached lock file.
 */
async function getLockedFiles(): Promise<Map<string, string>> {
  if (!lockedFiles) {
    const files = new Map<string, string>()
    const lock = JSON.parse(await fs.promises.readFile(path.join(getCacheDirectory(), kLockFile), 'utf8'))
    for (const pkg of Object.values(lock?.packages ?? {}) as { file_name?: unknown, sha256?: unknown }[]) {
      if (typeof pkg?.file_name === 'string' && typeof pkg?.sha256 === 'string') {
        files.set(pkg.file_name, pkg.sha256)
      }
    }
    lockedFiles = files
  }
  return lockedFiles
}

const respond = (status: number, body: string | Buffer | null = null, headers: Record<string, string> = {}): Response => {
  return new Response(body as BodyInit | null, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

/**
 * Answers the requests of the sandbox: its page, its script, the runtime files and the packages
 * listed in the lock file. A package that is not cached yet is downloaded here, by the main
 * process, from the Pyodide CDN and checked against the lock file. Nothing else is served.
 */
export async function handleSandboxRequest(request: { url: string, method: string }): Promise<Response> {

  try {

    const url = new URL(request.url)
    if (url.origin !== kSandboxOrigin || request.method !== 'GET') {
      return respond(403)
    }

    if (url.pathname === '/' || url.pathname === kSandboxPagePath) {
      return respond(200, kSandboxPage, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': kSandboxCsp })
    }
    if (url.pathname === kSandboxRunnerPath) {
      return respond(200, kSandboxRunner, { 'Content-Type': 'text/javascript; charset=utf-8' })
    }

    // a plain file name: no folder, no `..`
    const filename = decodeURIComponent(url.pathname.slice(1))
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(filename) || filename.includes('..')) {
      return respond(404)
    }

    let sha256: string | undefined
    if (!FILES_TO_CACHE.includes(filename)) {
      const files = await getLockedFiles()
      if (!files.has(filename)) {
        return respond(404)
      }
      sha256 = files.get(filename)
    }

    const cacheDir = getCacheDirectory()
    const body = isFileCached(filename)
      ? await fs.promises.readFile(path.join(cacheDir, filename))
      : await downloadFile(filename, cacheDir, sha256)

    return respond(200, body, { 'Content-Type': kContentTypes[path.extname(filename)] ?? 'application/octet-stream' })

  } catch (error) {
    console.warn('[Pyodide] Sandbox request failed:', error instanceof Error ? error.message : error)
    return respond(500)
  }

}

/**
 * The session of the sandbox: http(s) is answered by handleSandboxRequest and never reaches the
 * network, every other request is cancelled, every permission is refused.
 */
function getSandboxSession(): Session {

  if (sandboxSession) {
    return sandboxSession
  }

  const ses = session.fromPartition(kSandboxPartition)
  ses.protocol.handle('https', handleSandboxRequest)
  ses.protocol.handle('http', () => respond(403))
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${kSandboxOrigin}/`) })
  })
  ses.setPermissionRequestHandler((webContents, permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())

  sandboxSession = ses
  return ses

}

/**
 * True for the hidden window Python runs in: it is not a window of the app as far as the user is concerned.
 */
export function isPyodideSandboxWindow(window: BrowserWindow | null | undefined): boolean {
  return !!window && window === sandboxWindow
}

function createSandboxWindow(): BrowserWindow {

  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    webPreferences: {
      // no `preload`: the page has no channel to the app
      session: getSandboxSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      disableDialogs: true,
      spellcheck: false,
      autoplayPolicy: 'user-gesture-required',
      // the window is never shown: its timers must not be slowed down
      backgroundThrottling: false,
    },
  })

  // the page stays where it is
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // closed by the app (quit) or crashed (out of memory): start again next time
  const forget = () => {
    if (sandboxWindow === win) {
      sandboxWindow = null
      initializationPromise = null
    }
  }
  win.on('closed', forget)
  win.webContents.on('render-process-gone', (event, details) => {
    console.warn('[Pyodide] Sandbox process gone:', details?.reason)
    forget()
    if (!win.isDestroyed()) win.destroy()
  })

  return win

}

/**
 * Destroy the sandbox and its renderer process
 */
function destroySandbox(): void {
  const win = sandboxWindow
  sandboxWindow = null
  initializationPromise = null
  if (win && !win.isDestroyed()) {
    win.destroy()
  }
}

/**
 * Wait for a promise, but not forever
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Schedule disposal of the sandbox after TTL
 */
function scheduleDisposal(): void {
  // Clear existing timer
  if (disposalTimer) {
    clearTimeout(disposalTimer)
  }

  // Schedule disposal
  disposalTimer = setTimeout(() => {
    const idleTime = Date.now() - lastUsedTime

    if (idleTime >= PYODIDE_CONFIG.memoryTTL) {
      console.log('[Pyodide] Disposing due to inactivity (freed ~50-100MB)')
      destroySandbox()
      disposalTimer = null
    }
  }, PYODIDE_CONFIG.memoryTTL)
}

/**
 * Initialize Pyodide (lazy loading)
 * Uses singleton pattern to reuse the sandbox across calls
 */
async function initializePyodide(): Promise<BrowserWindow> {

  // If already initialized, return the existing sandbox
  if (sandboxWindow && !sandboxWindow.isDestroyed() && !initializationPromise) {
    return sandboxWindow
  }

  // If initialization in progress, wait for it
  if (initializationPromise) {
    return initializationPromise
  }

  let abandoned = false

  const initialize = async (): Promise<BrowserWindow> => {

    await ensureCacheExists()
    if (abandoned) {
      throw new Error('Timed out')
    }

    console.log('[Pyodide] Starting sandbox')
    const win = createSandboxWindow()
    sandboxWindow = win

    await win.loadURL(`${kSandboxOrigin}${kSandboxPagePath}`)
    await win.webContents.executeJavaScript(`${kSandboxApi}.init(${JSON.stringify(PYODIDE_PACKAGES)})`)

    console.log('[Pyodide] Initialized successfully')
    return win

  }

  const promise = withTimeout(initialize(), PYODIDE_CONFIG.initTimeout, 'Timed out')
  initializationPromise = promise

  try {
    const win = await promise
    if (initializationPromise === promise) {
      initializationPromise = null
    }
    return win
  } catch (error) {
    abandoned = true
    if (initializationPromise === promise) {
      destroySandbox()
    }
    throw new Error(`Failed to initialize Pyodide:${error instanceof Error ? error.message : String(error)}`)
  }

}

async function execute(script: string): Promise<{ result?: string; error?: string }> {
  try {

    // Update last used time
    lastUsedTime = Date.now()

    // Initialize Pyodide if needed
    const win = await initializePyodide()

    // Execute the script: it travels as a string literal and is only evaluated as Python, in the sandbox
    let output: unknown
    try {
      output = await withTimeout(
        win.webContents.executeJavaScript(`${kSandboxApi}.run(${JSON.stringify(script)})`),
        PYODIDE_CONFIG.runTimeout,
        `Python execution timed out after ${PYODIDE_CONFIG.runTimeout / 1000} seconds`
      )
    } catch (error) {
      // a script that is still running can only be stopped with its process
      if (sandboxWindow === win) {
        destroySandbox()
      }
      throw error
    }

    // Schedule disposal after TTL
    scheduleDisposal()

    // what comes back was produced next to untrusted code: only strings are taken from it
    const { result, error } = (output ?? {}) as { result?: unknown, error?: unknown }
    if (typeof error === 'string') {
      return { error }
    }
    if (typeof result === 'string') {
      return { result }
    }
    return { error: 'Unexpected response from the Python sandbox' }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { error: errorMessage }
  }
}

/**
 * Execute Python code in sandboxed environment
 *
 * @param script - Python code to execute
 * @returns Object with either result or error
 */
export async function runPythonCode(script: string): Promise<{ result?: string; error?: string }> {

  if (typeof script !== 'string') {
    return { error: 'The script must be a string' }
  }

  // one script at a time: they share the interpreter and its stdout
  const run = queue.then(() => execute(script))
  queue = run.then(() => {}, () => {})
  return run

}

/**
 * Get initialization status
 * Useful for UI to show loading state
 */
export function isPyodideInitialized(): boolean {
  return sandboxWindow !== null && initializationPromise === null
}

/**
 * Preemptively download and cache Pyodide files
 * Useful for settings UI to download in advance
 */
export async function downloadPyodideRuntime(): Promise<void> {
  await ensureCacheExists()
}

/**
 * Check if Pyodide is already cached locally
 */
export function isPyodideCached(): boolean {
  return isCacheComplete()
}

/**
 * Reset Pyodide (for testing)
 */
export function resetPyodide(): void {
  if (disposalTimer) {
    clearTimeout(disposalTimer)
    disposalTimer = null
  }
  destroySandbox()
  sandboxSession = null
  lockedFiles = null
  lastUsedTime = 0
  queue = Promise.resolve()
}
