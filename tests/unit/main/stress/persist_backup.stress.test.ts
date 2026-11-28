
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import archiver from 'archiver'
import { app, dialog } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportBackup, importBackup } from '@main/backup'
import * as config from '@main/config'
import * as file from '@main/file'
import { bug } from './bug'

let root: string
let userData: string

// which machine the OS key store belongs to: a key encrypted on one machine cannot be decrypted on another
let machine: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
      getLocale: vi.fn(() => 'en-US'),
      relaunch: vi.fn(),
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((data: string) => Buffer.from(`enc:${machine}:${data}`, 'latin1')),
      decryptString: vi.fn((data: Buffer) => {
        const text = data.toString('latin1')
        if (!text.startsWith(`enc:${machine}:`)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
        return text.slice(`enc:${machine}:`.length)
      }),
    },
  }
})

// stand-in for the key store: like the real one it is the apiKeys.json file of the user data folder, which the backup includes
vi.mock('electron-store', async () => {
  const fs = (await import('node:fs')).default
  const path = (await import('node:path')).default
  class Store {
    get file() { return path.join(userData, 'apiKeys.json') }
    get store() {
      try {
        return JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      } catch {
        return {}
      }
    }
    set(name: string, value: string) { fs.writeFileSync(this.file, JSON.stringify({ ...this.store, [name]: value })) }
    delete(name: string) {
      const data = this.store
      delete data[name]
      fs.writeFileSync(this.file, JSON.stringify(data))
    }
  }
  return { default: Store }
})

vi.mock('@main/monitor', async () => {
  class Monitor {
    start() {}
    stop() {}
  }
  return { default: Monitor }
})

vi.mock('@main/window', async () => {
  return { emitIpcEventToAll: vi.fn() }
})

vi.mock('@main/windows/index', async () => {
  return { emitIpcEventToAll: vi.fn() }
})

vi.mock('@main/file', async () => {
  return { pickFile: vi.fn(), pickDirectory: vi.fn() }
})

vi.mock('@main/i18n', async (importOriginal) => {
  const mod: any = await importOriginal()
  return { ...mod, useI18n: () => (key: string) => key }
})

// the real archiver, unless a test installs a fake archive to play an error scenario
const { fakeArchive } = vi.hoisted(() => ({ fakeArchive: { current: null as any } }))
vi.mock('archiver', async (importOriginal) => {
  const real: any = (await importOriginal<any>()).default
  return { default: (...args: any[]) => fakeArchive.current ?? real(...args) }
})

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const backupsDir = () => path.join(root, 'backups')

const writeFile = (target: string, content: string | Buffer): string => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

// every file below dir with its content, as hex
const snapshot = (dir: string): Record<string, string> => {
  const result: Record<string, string> = {}
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(full)
      else result[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('hex')
    }
  }
  walk(dir)
  return result
}

const useMachine = (name: string): string => {
  machine = name
  userData = path.join(root, `userData-${name}`)
  fs.mkdirSync(userData, { recursive: true })
  config.clearAppSettingsCache()
  return userData
}

// exports the current user data and returns the path of the zip
const exportToZip = async (): Promise<string> => {
  vi.mocked(file.pickDirectory).mockReturnValue(backupsDir())
  expect(await exportBackup(app)).toBe(true)
  const zips = fs.readdirSync(backupsDir()).filter(name => name.endsWith('.zip'))
  expect(zips).toHaveLength(1)
  return path.join(backupsDir(), zips[0])
}

const restoreFromZip = async (zip: string): Promise<{ result: boolean, quit: number }> => {
  const quit = vi.fn()
  vi.mocked(file.pickFile).mockReturnValue(zip)
  const result = await importBackup(app, quit)
  return { result, quit: quit.mock.calls.length }
}

// a zip made of the given entries, built with the real archiver
const makeZip = async (name: string, entries: Record<string, string>): Promise<string> => {
  const target = path.join(root, name)
  const output = fs.createWriteStream(target)
  const archive = archiver('zip')
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    archive.on('error', reject)
  })
  archive.pipe(output)
  for (const [entry, text] of Object.entries(entries)) archive.append(text, { name: entry })
  await archive.finalize()
  await closed
  return target
}

const dialogMessages = (): string[] => vi.mocked(dialog.showMessageBox).mock.calls.map(call => (call[0] as any).message)

beforeEach(() => {
  vi.clearAllMocks()
  fakeArchive.current = null
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-backup-'))
  fs.mkdirSync(backupsDir(), { recursive: true })
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
  // the restore extracts the zip to a folder of the OS temp dir: keep it inside the temp root of the test
  vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(root, 'tmp'))
  config.setSaveConfigInTests()
  useMachine('A')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  fakeArchive.current = null
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('backup and restore', () => {

  test('stress: a user data folder with 79 files comes back byte for byte on an empty install', async () => {
    const rand = mulberry32(8080)
    const bytes = (length: number) => Buffer.from(Array.from({ length }, () => Math.floor(rand() * 256)))
    writeFile(path.join(userData, 'settings.json'), JSON.stringify({ general: { locale: 'fr' } }, null, 2))
    writeFile(path.join(userData, 'commands.json'), JSON.stringify([{ id: 'cmd-1', label: 'Mine', state: 'enabled' }]))
    writeFile(path.join(userData, 'engines', 'openai.json'), JSON.stringify({ models: { chat: [] } }))
    for (let w = 0; w < 4; w++) {
      const dir = path.join(userData, 'workspaces', `workspace-${w}`)
      writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ uuid: `workspace-${w}`, name: `Workspace ${w}` }))
      writeFile(path.join(dir, 'history.json'), JSON.stringify({ version: 1, folders: [], chats: [{ uuid: `chat-${w}`, title: '日本語 ❤️' }] }))
      writeFile(path.join(dir, 'experts.json'), '')
      for (let i = 0; i < 12; i++) writeFile(path.join(dir, 'images', `image ${i}.png`), bytes(Math.floor(rand() * 3000)))
      for (let i = 0; i < 4; i++) writeFile(path.join(dir, 'agents', `agent-${i}.json`), JSON.stringify({ uuid: `agent-${i}` }))
    }
    const saved = snapshot(userData)
    expect(Object.keys(saved)).toHaveLength(79)

    const zip = await exportToZip()
    useMachine('B')
    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })
    expect(snapshot(userData)).toEqual(saved)
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  test('files of the user data folder that are not part of a backup are not exported', async () => {
    writeFile(path.join(userData, 'settings.json'), '{}')
    writeFile(path.join(userData, 'window-state.json'), '{}')
    writeFile(path.join(userData, 'Cache', 'data_0'), 'cache')
    const zip = await exportToZip()
    useMachine('B')
    await restoreFromZip(zip)
    expect(Object.keys(snapshot(userData))).toEqual(['settings.json'])
  })

  test('cancelling at any step changes nothing', async () => {
    writeFile(path.join(userData, 'settings.json'), '{"general":{"locale":"fr"}}')
    const before = snapshot(root)

    vi.mocked(file.pickDirectory).mockReturnValue(null)
    expect(await exportBackup(app)).toBe(false)

    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0 } as any)
    expect(await importBackup(app, vi.fn())).toBe(false)
    expect(file.pickFile).not.toHaveBeenCalled()

    vi.mocked(file.pickFile).mockReturnValue(null)
    expect(await importBackup(app, vi.fn())).toBe(false)

    expect(snapshot(root)).toEqual(before)
    expect(app.relaunch).not.toHaveBeenCalled()
  })

  test.each([
    ['random bytes', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])],
    ['an empty file', Buffer.alloc(0)],
    ['a truncated zip', null],
  ])('restoring %s reports an error, keeps the current data and does not restart', async (_, content) => {
    writeFile(path.join(userData, 'settings.json'), '{"general":{"locale":"fr"}}')
    writeFile(path.join(userData, 'workspaces', 'w', 'history.json'), '{"version":1}')
    if (content === null) {
      const zip = await exportToZip()
      const data = fs.readFileSync(zip)
      content = data.subarray(0, Math.floor(data.length / 2))
    }
    const broken = writeFile(path.join(root, 'broken.zip'), content)
    const before = snapshot(userData)
    expect(await restoreFromZip(broken)).toEqual({ result: false, quit: 0 })
    expect(dialogMessages()).toContain('backup.restore.error.message')
    expect(snapshot(userData)).toEqual(before)
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  test('a zip that is not a Witsy backup is refused instead of being reported as restored', async () => {
    // nothing checks that the zip holds anything to restore: nothing is copied, yet the success dialog is shown and the app restarts
    const zip = await makeZip('holiday-pictures.zip', { 'readme.txt': 'not a backup', 'pictures/beach.txt': 'sand' })
    expect(await restoreFromZip(zip)).toEqual({ result: false, quit: 0 })
  })

  test.each([
    ['truncated', '{"general":{"locale":"f'],
    ['empty', ''],
    ['not an object', '[1,2,3]'],
  ])('a backup whose settings.json is %s does not replace the current settings', async (_, text) => {
    // the files of the zip are copied over the current ones without being parsed first
    const current = '{"general":{"locale":"fr"}}'
    writeFile(path.join(userData, 'settings.json'), current)
    const zip = await makeZip('damaged-backup.zip', { 'settings.json': text })
    await restoreFromZip(zip)
    expect(fs.readFileSync(path.join(userData, 'settings.json'), 'utf-8')).toBe(current)
  })

})

describe('API keys in a backup', () => {

  const saveKeys = () => {
    const settings = config.loadSettings(app)
    settings.engines.openai.apiKey = 'sk-openai-secret'
    settings.engines.anthropic.apiKey = 'sk-anthropic-secret'
    config.saveSettings(app, settings)
    config.clearAppSettingsCache()
  }

  const loadKeys = () => {
    config.clearAppSettingsCache()
    const settings = config.loadSettings(app)
    return { openai: settings.engines.openai.apiKey || '', anthropic: settings.engines.anthropic.apiKey || '' }
  }

  test('the keys are in the backup, encrypted, and not in the exported settings.json', async () => {
    saveKeys()
    const zip = await exportToZip()
    expect(fs.readFileSync(zip).toString('latin1')).not.toContain('sk-openai-secret')
    expect(fs.readFileSync(path.join(userData, 'settings.json'), 'utf-8')).not.toContain('sk-openai-secret')
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(userData, 'apiKeys.json'), 'utf-8'))).sort()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])
  })

  test('the keys come back when the backup is restored on the machine that made it', async () => {
    saveKeys()
    const zip = await exportToZip()
    fs.rmSync(userData, { recursive: true, force: true })
    useMachine('A')
    expect(loadKeys()).toEqual({ openai: '', anthropic: '' })
    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })
    expect(loadKeys()).toEqual({ openai: 'sk-openai-secret', anthropic: 'sk-anthropic-secret' })
  })

  bug('the keys come back when the backup is restored on another machine', async () => {
    // apiKeys.json holds ciphertext of the OS key store of the first machine; on the new one decryption fails and every key is deleted, after a "restored" dialog
    saveKeys()
    const zip = await exportToZip()
    useMachine('B')
    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })
    expect(loadKeys()).toEqual({ openai: 'sk-openai-secret', anthropic: 'sk-anthropic-secret' })
  })

})

describe('archiver events during an export', () => {

  type Scenario = { settled: boolean | undefined, thrown: string | undefined }

  // plays an export whose archive emits `event` asynchronously, as the real archiver does, and reports what the handler of backup.ts did
  const playEvent = async (event: 'warning' | 'error', error: Error): Promise<Scenario> => {
    const handlers: Record<string, (err: Error) => void> = {}
    let thrown: string | undefined
    let emitted = false
    fakeArchive.current = {
      on: (name: string, handler: (err: Error) => void) => { handlers[name] = handler },
      pipe: () => {},
      file: () => {},
      directory: () => {},
      pointer: () => 0,
      finalize: () => {
        setImmediate(() => {
          try {
            handlers[event](error)
          } catch (e) {
            // in the app nothing catches this: it is an uncaught exception of the main process
            thrown = e.message
          }
          emitted = true
        })
      },
    }
    let output: fs.WriteStream
    const realCreateWriteStream = fs.createWriteStream
    vi.spyOn(fs, 'createWriteStream').mockImplementation((...args: any[]) => {
      output = (realCreateWriteStream as any)(...args)
      return output
    })
    vi.mocked(file.pickDirectory).mockReturnValue(backupsDir())

    let settled: boolean | undefined
    const pending = exportBackup(app).then(result => { settled = result })
    await vi.waitUntil(() => emitted, { timeout: 500, interval: 5 })
    await vi.waitUntil(() => settled !== undefined, { timeout: 60, interval: 5 }).catch(() => {})
    const scenario = { settled, thrown }

    // release the file and let the export finish whatever happened, so that nothing stays pending after the test
    output.destroy()
    await vi.waitUntil(() => output.closed, { timeout: 500, interval: 5 })
    await pending
    return scenario
  }

  const errorWithCode = (code: string) => Object.assign(new Error(`${code}: simulated`), { code })

  test('an archiver error makes the export fail instead of throwing from the event handler', async () => {
    // the handler rethrows inside the emitter, out of reach of the try/catch of exportBackup: an uncaught exception, and the export never reports its failure
    expect(await playEvent('error', errorWithCode('EACCES'))).toEqual({ settled: false, thrown: undefined })
  })

  test('an archiver warning other than ENOENT makes the export fail instead of throwing from the event handler', async () => {
    // same rethrow for every warning that is not ENOENT
    expect(await playEvent('warning', errorWithCode('EACCES'))).toEqual({ settled: false, thrown: undefined })
  })

  test('an archiver ENOENT warning (a file removed during the export) is only logged', async () => {
    const scenario = await playEvent('warning', errorWithCode('ENOENT'))
    expect(scenario.thrown).toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
  })

})
