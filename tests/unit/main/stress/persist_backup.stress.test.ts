
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import archiver from 'archiver'
import { app, dialog } from 'electron'
import extractZip from 'extract-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportBackup, importBackup } from '@main/backup'
import * as config from '@main/config'
import * as file from '@main/file'

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
      // (the definition of a workspace and its agents are parsed and written again: they have the format the app gives them)
      writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ uuid: `workspace-${w}`, name: `Workspace ${w}` }, null, 2))
      writeFile(path.join(dir, 'history.json'), JSON.stringify({ version: 1, folders: [], chats: [{ uuid: `chat-${w}`, title: '日本語 ❤️' }] }))
      writeFile(path.join(dir, 'experts.json'), '')
      for (let i = 0; i < 12; i++) writeFile(path.join(dir, 'images', `image ${i}.png`), bytes(Math.floor(rand() * 3000)))
      for (let i = 0; i < 4; i++) writeFile(path.join(dir, 'agents', `agent-${i}.json`), JSON.stringify({ uuid: `agent-${i}` }, null, 2))
    }
    const saved = snapshot(userData)
    expect(Object.keys(saved)).toHaveLength(79)

    const zip = await exportToZip()
    useMachine('B')
    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })
    expect(snapshot(userData)).toEqual(saved)
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  }, 60000)

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

  test('an export that cannot list the files of the workspaces fails and leaves no backup behind', async () => {
    // the files that can hold a token are added apart from the others: without their list the backup would silently miss them
    writeFile(path.join(userData, 'settings.json'), '{}')
    writeFile(path.join(userData, 'workspaces', 'w1', 'history.json'), '{"version":1}')
    const readdirSync = fs.readdirSync
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: string, options: any) => {
      if (options?.withFileTypes && String(dir).startsWith(path.join(userData, 'workspaces'))) {
        throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' })
      }
      return (readdirSync as any)(dir, options)
    }) as any)
    vi.mocked(file.pickDirectory).mockReturnValue(backupsDir())
    expect(await exportBackup(app)).toBe(false)
    await vi.waitUntil(() => (readdirSync as any)(backupsDir()).length === 0, { timeout: 2000, interval: 10 })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
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

// A backup never carries key material, and a restore never imports any (decision taken for D-27):
// no key store, no key in clear text, no ciphertext. The keys of the computer that restores are kept.
// Every secret below is an obviously fake value.
describe('API keys in a backup', () => {

  const saveKeys = (openai: string = 'sk-openai-secret', anthropic: string = 'sk-anthropic-secret') => {
    const settings = config.loadSettings(app)
    settings.engines.openai.apiKey = openai
    settings.engines.anthropic.apiKey = anthropic
    config.saveSettings(app, settings)
    config.clearAppSettingsCache()
  }

  const loadKeys = () => {
    config.clearAppSettingsCache()
    const settings = config.loadSettings(app)
    return { openai: settings.engines.openai.apiKey || '', anthropic: settings.engines.anthropic.apiKey || '' }
  }

  const keyStorePath = () => path.join(userData, 'apiKeys.json')

  const readJson = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf-8'))

  const unzip = async (zip: string): Promise<string> => {
    const dir = path.join(root, `unzipped-${path.basename(zip, '.zip')}`)
    await extractZip(zip, { dir })
    return dir
  }

  // the files below dir that hold one of the texts, read as raw bytes
  const filesHolding = (dir: string, texts: string[]): string[] => {
    const found: string[] = []
    for (const [name, hex] of Object.entries(snapshot(dir))) {
      const content = Buffer.from(hex, 'hex').toString('latin1')
      for (const text of texts) {
        if (content.includes(text)) found.push(`${name} holds ${text}`)
      }
    }
    return found
  }

  const secrets: string[] = []
  const secret = (place: string): string => {
    const value = `FAKE-${place}-not-a-real-secret`
    secrets.push(value)
    return value
  }

  // a user data folder with a secret wherever one can be, for an install that does not use the key store
  const writeInstallWithSecrets = () => {
    writeFile(path.join(userData, 'settings.json'), JSON.stringify({
      general: { safeKeys: false, locale: 'fr', customProxy: `http://proxyuser:${secret('proxy-password')}@proxy.example.com:3128` },
      engines: {
        openai: { apiKey: secret('openai'), baseURL: 'https://api.openai.com/v1', model: { chat: 'gpt-x' } },
        anthropic: { apiKey: secret('anthropic') },
        'custom-1': { label: 'Gateway', api: 'openai', apiKey: secret('custom-engine'), baseURL: `https://gateway.example.com/v1?api_key=${secret('custom-url')}` },
      },
      plugins: { search: { enabled: true, engine: 'tavily', tavilyApiKey: secret('tavily'), braveApiKey: secret('brave'), exaApiKey: secret('exa'), perplexityApiKey: secret('perplexity'), googleApiKey: secret('google') } },
      mcp: {
        smitheryApiKey: secret('smithery'),
        servers: [
          {
            uuid: 'srv-1', registryId: 'srv-1', state: 'enabled', type: 'stdio', command: 'npx',
            url: `-y @example/server --key ${secret('args-key')} --token=${secret('args-token')} --header "Authorization: Bearer ${secret('args-header')}"`,
            env: { GITHUB_TOKEN: secret('env-token'), REGION: secret('env-any-name') },
            toolSelection: null,
          },
          {
            uuid: 'srv-2', registryId: 'srv-2', state: 'enabled', type: 'http',
            url: `https://mcp.example.com/mcp?access_token=${secret('url-token')}`,
            headers: { Authorization: `Bearer ${secret('header')}`, 'X-Api-Key': secret('header-key') },
            oauth: { tokens: { access_token: secret('oauth-access'), refresh_token: secret('oauth-refresh') }, clientId: 'client-1', clientSecret: secret('oauth-client-secret') },
            toolSelection: null,
          },
        ],
        mcpServersExtra: { s1: { state: 'enabled', oauth: { tokens: { access_token: secret('extra-oauth') }, clientId: 'client-2', clientSecret: secret('extra-client-secret') } } },
      },
      mcpServers: { s1: { command: 'npx', args: ['-y', 's1', '--api-key', secret('claude-args')], env: { S1_API_KEY: secret('claude-env') } } },
    }, null, 2))
    // a key store left by a time when it was used
    writeFile(path.join(userData, 'apiKeys.json'), JSON.stringify({ 'engines.groq.apiKey': `enc:A:${secret('key-store')}` }))
    writeFile(path.join(userData, 'commands.json'), JSON.stringify([{ id: 'cmd-1', label: 'Mine', state: 'enabled' }]))
    writeFile(path.join(userData, 'engines', 'openai.json'), JSON.stringify({ models: { chat: [] } }))
    const workspace = path.join(userData, 'workspaces', 'w1')
    writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({
      uuid: 'w1', name: 'Work',
      webapps: [{ id: 'app-1', name: 'Intranet', url: `https://me:${secret('webapp-password')}@intranet.example.com/?token=${secret('webapp-token')}`, enabled: true }],
    }, null, 2))
    writeFile(path.join(workspace, 'agents', 'agent-1.json'), JSON.stringify({ uuid: 'agent-1', name: 'Agent', webhookToken: secret('webhook'), invocationValues: { topic: 'news' } }, null, 2))
    writeFile(path.join(workspace, 'agents', 'agent-1', 'run-1.json'), JSON.stringify({ uuid: 'run-1', agentId: 'agent-1', messages: [{ role: 'user', content: 'the user wrote this in a run' }] }))
    writeFile(path.join(workspace, 'history.json'), JSON.stringify({ version: 1, folders: [], chats: [{ uuid: 'chat-1', title: 'A chat', messages: [{ role: 'user', content: 'the user wrote this in a chat' }] }] }))
  }

  test('the key store is not part of a backup and no file of the backup holds a key', async () => {
    saveKeys()
    const zip = await exportToZip()
    const files = await unzip(zip)
    expect(Object.keys(snapshot(files))).toContain('settings.json')
    expect(Object.keys(snapshot(files))).not.toContain('apiKeys.json')
    // neither the keys nor what the key store of this computer made of them
    expect(filesHolding(files, ['sk-openai-secret', 'sk-anthropic-secret', 'enc:A:'])).toEqual([])
    expect(fs.readFileSync(zip).toString('latin1')).not.toContain('sk-openai-secret')
    // they are still on this computer
    expect(Object.keys(readJson(keyStorePath())).sort()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])
    expect(loadKeys()).toEqual({ openai: 'sk-openai-secret', anthropic: 'sk-anthropic-secret' })
  }, 30000)

  test('an install that keeps its secrets in its files gives none of them to a backup', async () => {
    const first = secrets.length
    writeInstallWithSecrets()
    const saved = snapshot(userData)
    // (the test itself: every secret is on the disk before the export)
    const written = secrets.slice(first)
    expect(written.length).toBeGreaterThan(25)
    expect(filesHolding(userData, written)).toHaveLength(written.length)

    const zip = await exportToZip()
    const files = await unzip(zip)
    const exported = snapshot(files)

    expect(filesHolding(files, [...secrets, 'FAKE-', 'not-a-real-secret'])).toEqual([])
    expect(Object.keys(exported).sort()).toEqual([
      'commands.json',
      'engines/openai.json',
      'settings.json',
      'workspaces/w1/agents/agent-1.json',
      'workspaces/w1/agents/agent-1/run-1.json',
      'workspaces/w1/history.json',
      'workspaces/w1/workspace.json',
    ])

    // what is not a secret is all there
    const settings = readJson(files, 'settings.json')
    expect(settings.general).toEqual({ safeKeys: false, locale: 'fr', customProxy: 'http://proxy.example.com:3128' })
    expect(settings.engines.openai).toEqual({ apiKey: '', baseURL: 'https://api.openai.com/v1', model: { chat: 'gpt-x' } })
    expect(settings.engines['custom-1']).toEqual({ label: 'Gateway', api: 'openai', apiKey: '', baseURL: 'https://gateway.example.com/v1?api_key=' })
    expect(settings.mcp.servers[0]).toEqual({
      uuid: 'srv-1', registryId: 'srv-1', state: 'enabled', type: 'stdio', command: 'npx',
      url: '-y @example/server --key --token= --header "Authorization: "',
      env: { GITHUB_TOKEN: '', REGION: '' },
      toolSelection: null,
    })
    expect(settings.mcp.servers[1]).toEqual({
      uuid: 'srv-2', registryId: 'srv-2', state: 'enabled', type: 'http',
      url: 'https://mcp.example.com/mcp?access_token=',
      headers: { Authorization: '', 'X-Api-Key': '' },
      oauth: { clientId: 'client-1', clientSecret: '' },
      toolSelection: null,
    })
    expect(settings.mcpServers.s1).toEqual({ command: 'npx', args: ['-y', 's1', '--api-key', ''], env: { S1_API_KEY: '' } })
    expect(readJson(files, 'workspaces', 'w1', 'agents', 'agent-1.json')).toEqual({ uuid: 'agent-1', name: 'Agent', webhookToken: null, invocationValues: { topic: 'news' } })
    expect(readJson(files, 'workspaces', 'w1', 'workspace.json').webapps[0].url).toBe('https://intranet.example.com/?token=')

    // conversations, runs and the other files are the ones of the user, byte for byte
    for (const name of ['commands.json', 'engines/openai.json', 'workspaces/w1/history.json', 'workspaces/w1/agents/agent-1/run-1.json']) {
      expect(exported[name], name).toBe(saved[name])
    }

    // and the export changed nothing on this computer
    expect(snapshot(userData)).toEqual(saved)
  }, 30000)

  test('a file that should lose its secrets and cannot be parsed is left out of the backup', async () => {
    writeFile(path.join(userData, 'settings.json'), `{"engines":{"openai":{"apiKey":"${secret('truncated-settings')}"`)
    writeFile(path.join(userData, 'workspaces', 'w1', 'agents', 'agent-1.json'), `{"webhookToken":"${secret('truncated-agent')}`)
    writeFile(path.join(userData, 'workspaces', 'w1', 'history.json'), '{"version":1,"folders":[],"chats":[]}')
    const files = await unzip(await exportToZip())
    expect(Object.keys(snapshot(files))).toEqual(['workspaces/w1/history.json'])
    expect(filesHolding(files, secrets)).toEqual([])
  }, 30000)

  test('restoring a backup on the computer that made it keeps the keys that are there', async () => {
    saveKeys()
    const zip = await exportToZip()
    const keyStore = fs.readFileSync(keyStorePath())
    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })
    expect(fs.readFileSync(keyStorePath()).equals(keyStore)).toBe(true)
    expect(loadKeys()).toEqual({ openai: 'sk-openai-secret', anthropic: 'sk-anthropic-secret' })
  }, 30000)

  test('a backup does not bring keys back to an install that lost them', async () => {
    saveKeys()
    const zip = await exportToZip()
    fs.rmSync(userData, { recursive: true, force: true })
    useMachine('A')
    expect(loadKeys()).toEqual({ openai: '', anthropic: '' })
    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })
    expect(loadKeys()).toEqual({ openai: '', anthropic: '' })
    expect(filesHolding(userData, ['sk-openai-secret', 'sk-anthropic-secret'])).toEqual([])
  }, 30000)

  test('a backup restored on another computer brings no key, keeps the keys of that computer and says so', async () => {
    // before: the key store of the first computer replaced the one of the second, where it cannot be decrypted, and every key was lost after a "restored" dialog
    saveKeys()
    const zip = await exportToZip()

    useMachine('B')
    saveKeys('sk-openai-of-b', 'sk-anthropic-of-b')
    const keyStore = fs.readFileSync(keyStorePath())
    vi.mocked(dialog.showMessageBox).mockClear()

    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })

    // the key store of this computer is the same, byte for byte, and nothing of the other one arrived
    expect(fs.readFileSync(keyStorePath()).equals(keyStore)).toBe(true)
    expect(filesHolding(userData, ['sk-openai-secret', 'sk-anthropic-secret', 'enc:A:'])).toEqual([])
    expect(loadKeys()).toEqual({ openai: 'sk-openai-of-b', anthropic: 'sk-anthropic-of-b' })

    // the user is told before and after
    const [confirmation, done] = vi.mocked(dialog.showMessageBox).mock.calls.map(call => call[0] as any)
    expect(confirmation.detail).toContain('backup.restore.confirm.keys')
    expect(done.message).toBe('backup.restore.restart.message')
    expect(done.detail).toContain('backup.restore.restart.keys')
  }, 30000)

  test('an older backup, with a key store and keys in clear text, imports none of them', async () => {
    const old = (place: string) => secret(`old-backup-${place}`)
    const history = JSON.stringify({ version: 1, folders: [], chats: [{ uuid: 'chat-1', title: 'From the backup' }] })
    const zip = await makeZip('old-backup.zip', {
      'apiKeys.json': JSON.stringify({ 'engines.openai.apiKey': `enc:A:${old('key-store-openai')}`, 'engines.mistralai.apiKey': `enc:A:${old('key-store-mistral')}` }),
      'settings.json': JSON.stringify({
        general: { safeKeys: false, locale: 'fr' },
        engines: { openai: { apiKey: old('openai'), model: { chat: 'model-of-the-backup' } }, groq: { apiKey: old('groq') } },
        mcp: {
          smitheryApiKey: old('smithery'),
          servers: [
            { uuid: 'srv-1', registryId: 'srv-1', state: 'enabled', type: 'stdio', command: 'npx', url: `-y @example/server --key ${old('args')}`, env: { GITHUB_TOKEN: old('env') }, toolSelection: null },
            { uuid: 'srv-2', registryId: 'srv-2', state: 'enabled', type: 'http', url: 'https://moved.example.com/mcp', headers: { Authorization: `Bearer ${old('header')}` }, oauth: { tokens: { access_token: old('oauth') }, clientId: 'client-1', clientSecret: old('client-secret') }, toolSelection: null },
          ],
          mcpServersExtra: {},
        },
        mcpServers: {},
      }),
      'workspaces/w1/workspace.json': JSON.stringify({ uuid: 'w1', name: 'Work', webapps: [{ id: 'app-1', name: 'Intranet', url: `https://me:${old('webapp')}@intranet.example.com/`, enabled: true }] }),
      'workspaces/w1/agents/agent-1.json': JSON.stringify({ uuid: 'agent-1', name: 'Agent of the backup', webhookToken: old('webhook-1') }),
      'workspaces/w1/agents/agent-2.json': JSON.stringify({ uuid: 'agent-2', name: 'Only in the backup', webhookToken: old('webhook-2') }),
      'workspaces/w1/history.json': history,
    })

    // the computer that restores: keys in its key store, and secrets of its own in its files
    useMachine('B')
    saveKeys('sk-openai-of-b', 'sk-anthropic-of-b')
    const local = readJson(userData, 'settings.json')
    local.mcp.servers = [
      // the same server as in the backup
      { uuid: 'srv-1', registryId: 'srv-1', state: 'enabled', type: 'stdio', command: 'npx', url: '-y @example/server --key local-args-key', env: { GITHUB_TOKEN: 'local-env-token' }, toolSelection: null },
      // a server that the backup sends elsewhere
      { uuid: 'srv-2', registryId: 'srv-2', state: 'enabled', type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer local-header' }, oauth: { tokens: { access_token: 'local-oauth' }, clientId: 'client-1', clientSecret: 'local-client-secret' }, toolSelection: null },
    ]
    writeFile(path.join(userData, 'settings.json'), JSON.stringify(local, null, 2))
    writeFile(path.join(userData, 'workspaces', 'w1', 'workspace.json'), JSON.stringify({ uuid: 'w1', name: 'Work', webapps: [{ id: 'app-1', name: 'Intranet', url: 'https://me:local-webapp@intranet.example.com/', enabled: true }] }))
    writeFile(path.join(userData, 'workspaces', 'w1', 'agents', 'agent-1.json'), JSON.stringify({ uuid: 'agent-1', name: 'Agent', webhookToken: 'local-webhook' }))
    config.clearAppSettingsCache()
    const keyStore = fs.readFileSync(keyStorePath())

    expect(await restoreFromZip(zip)).toEqual({ result: true, quit: 1 })

    // nothing of the backup's key material is on this computer, in any file
    expect(filesHolding(userData, [...secrets, 'FAKE-', 'enc:A:'])).toEqual([])
    expect(fs.readFileSync(keyStorePath()).equals(keyStore)).toBe(true)

    // the settings are the ones of the backup, with the secrets this computer has for the same things
    const settings = readJson(userData, 'settings.json')
    expect(settings.general).toEqual({ safeKeys: true, locale: 'fr' })
    expect(settings.engines).toEqual({ openai: { apiKey: '', model: { chat: 'model-of-the-backup' } }, groq: { apiKey: '' } })
    expect(settings.mcp.smitheryApiKey).toBe('')
    expect(settings.mcp.servers[0]).toEqual({ uuid: 'srv-1', registryId: 'srv-1', state: 'enabled', type: 'stdio', command: 'npx', url: '-y @example/server --key local-args-key', env: { GITHUB_TOKEN: 'local-env-token' }, toolSelection: null })
    expect(settings.mcp.servers[1]).toEqual({ uuid: 'srv-2', registryId: 'srv-2', state: 'enabled', type: 'http', url: 'https://moved.example.com/mcp', headers: { Authorization: '' }, oauth: { clientId: 'client-1', clientSecret: '' }, toolSelection: null })

    expect(readJson(userData, 'workspaces', 'w1', 'workspace.json').webapps[0].url).toBe('https://me:local-webapp@intranet.example.com/')
    expect(readJson(userData, 'workspaces', 'w1', 'agents', 'agent-1.json')).toEqual({ uuid: 'agent-1', name: 'Agent of the backup', webhookToken: 'local-webhook' })
    expect(readJson(userData, 'workspaces', 'w1', 'agents', 'agent-2.json')).toEqual({ uuid: 'agent-2', name: 'Only in the backup', webhookToken: null })
    expect(fs.readFileSync(path.join(userData, 'workspaces', 'w1', 'history.json'), 'utf-8')).toBe(history)

    // and the keys of this computer still open its engines
    expect(loadKeys()).toEqual({ openai: 'sk-openai-of-b', anthropic: 'sk-anthropic-of-b' })
  }, 30000)

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
      append: () => {},
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
