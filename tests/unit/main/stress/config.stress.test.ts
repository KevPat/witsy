
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app, safeStorage } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as config from '@main/config'
import { bug } from './bug'

let userData: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((data: string) => Buffer.from(`enc:${data}`, 'latin1')),
      decryptString: vi.fn((data: Buffer) => data.toString('latin1').replace(/^enc:/, '')),
    }
  }
})

// in-memory stand-in for the encrypted key store
const { keyStore } = vi.hoisted(() => ({ keyStore: new Map<string, string>() }))
vi.mock('electron-store', async () => {
  class Store {
    get store() { return Object.fromEntries(keyStore) }
    set(name: string, value: string) { keyStore.set(name, value) }
    delete(name: string) { keyStore.delete(name) }
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

const settingsFile = () => path.join(userData, 'settings.json')
const writeSettings = (content: any) => fs.writeFileSync(settingsFile(), typeof content === 'string' ? content : JSON.stringify(content))
const readSettingsText = () => fs.readFileSync(settingsFile(), 'utf-8')
const storeKey = (name: string, value: string) => keyStore.set(name, Buffer.from(`enc:${value}`, 'latin1').toString('latin1'))
const storedKeys = () => [...keyStore.keys()].sort()

// same as the implementations of the electron mock above
const encrypt = (data: string) => Buffer.from(`enc:${data}`, 'latin1')
const decrypt = (data: Buffer) => data.toString('latin1').replace(/^enc:/, '')

beforeEach(() => {
  vi.clearAllMocks()
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'config-stress-'))
  keyStore.clear()
  config.setSaveConfigInTests()
  config.clearAppSettingsCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('API key storage', () => {

  test('keys are moved out of settings.json and come back on reload', () => {
    const loaded = config.loadSettings(app)
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    loaded.engines.anthropic.apiKey = 'sk-anthropic-secret'
    config.saveSettings(app, loaded)
    expect(readSettingsText()).not.toContain('sk-openai-secret')
    expect(readSettingsText()).not.toContain('sk-anthropic-secret')
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])
    config.clearAppSettingsCache()
    const reloaded = config.loadSettings(app)
    expect(reloaded.engines.openai.apiKey).toBe('sk-openai-secret')
    expect(reloaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
  })

  test('stress: 100 save and reload cycles keep every key', () => {
    const engines = ['openai', 'anthropic', 'google', 'mistralai', 'groq']
    let loaded = config.loadSettings(app)
    for (let i = 0; i < 100; i++) {
      const engine = engines[i % engines.length]
      loaded.engines[engine].apiKey = `key-${engine}-${i}`
      config.saveSettings(app, loaded)
      config.clearAppSettingsCache()
      loaded = config.loadSettings(app)
    }
    for (const engine of engines) {
      expect(loaded.engines[engine].apiKey).toMatch(new RegExp(`^key-${engine}-\\d+$`))
    }
    expect(readSettingsText()).not.toContain('key-')
  // about 2,600 file writes and as many reads: more than the default 5 seconds on Windows
  }, 60000)

  test('keys stay in settings.json when the user turned safe storage off', () => {
    const loaded = config.loadSettings(app)
    loaded.general.safeKeys = false
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    expect(readSettingsText()).toContain('sk-openai-secret')
    expect(storedKeys()).toEqual([])
  })

  test('a key that cannot be decrypted right now is kept in the store', () => {
    // locked keychain, denied keychain prompt, keyring backend not ready yet... the error is not proof the key is gone for good
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    vi.mocked(safeStorage.decryptString).mockImplementation(() => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') })
    config.loadSettings(app)
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])
  })

  test('a key typed into settings.json by hand does not erase the other stored keys', () => {
    // loadSettings sees a plaintext key, and saves that list after clearing the store
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    writeSettings({ engines: { groq: { apiKey: 'gsk-new-key' } } })
    const loaded = config.loadSettings(app)
    expect(loaded.engines.groq.apiKey).toBe('gsk-new-key')
    expect(loaded.engines.openai.apiKey).toBe('sk-openai-secret')
    expect(loaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
  })

  test('a key that fails to encrypt is not dropped from both the store and settings.json', () => {
    // saveApiKeys reports success, so the caller removes the plaintext copy too
    const loaded = config.loadSettings(app)
    vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => { throw new Error('encryption failed') })
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    const inFile = readSettingsText().includes('sk-openai-secret')
    const inStore = storedKeys().includes('engines.openai.apiKey')
    expect(inFile || inStore).toBe(true)
  })

  test('a save after a failed decryption keeps the ciphertext, and the key is back when decryption works again', () => {
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    const ciphertext = keyStore.get('engines.openai.apiKey')
    vi.mocked(safeStorage.decryptString).mockImplementation((data: Buffer) => {
      if (data.toString('latin1').includes('openai')) throw new Error('keychain denied')
      return decrypt(data)
    })
    const loaded = config.loadSettings(app)
    expect(loaded.engines.openai.apiKey).toBe('')
    expect(loaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
    expect(config.getApiKeyStorageStatus().undecryptable).toEqual(['engines.openai.apiKey'])

    // the window saves what it loaded, with another change
    loaded.general.locale = 'fr'
    config.saveSettings(app, loaded)
    expect(keyStore.get('engines.openai.apiKey')).toBe(ciphertext)
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])

    // keychain is back
    vi.mocked(safeStorage.decryptString).mockImplementation(decrypt)
    config.clearAppSettingsCache()
    const reloaded = config.loadSettings(app)
    expect(reloaded.engines.openai.apiKey).toBe('sk-openai-secret')
    expect(reloaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
    expect(config.getApiKeyStorageStatus().undecryptable).toEqual([])
  })

  test('a new value typed for a key that cannot be decrypted replaces it', () => {
    storeKey('engines.openai.apiKey', 'sk-old')
    vi.mocked(safeStorage.decryptString).mockImplementation((data: Buffer) => {
      if (data.toString('latin1').includes('sk-old')) throw new Error('keychain denied')
      return decrypt(data)
    })
    const loaded = config.loadSettings(app)
    loaded.engines.openai.apiKey = 'sk-new'
    config.saveSettings(app, loaded)
    config.clearAppSettingsCache()
    expect(config.loadSettings(app).engines.openai.apiKey).toBe('sk-new')
    expect(config.getApiKeyStorageStatus().undecryptable).toEqual([])
  })

  test('one key that fails to encrypt does not affect the others and stays in settings.json until it can be stored', () => {
    storeKey('engines.openai.apiKey', 'sk-openai-old')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    vi.mocked(safeStorage.encryptString).mockImplementation((data: string) => {
      if (data === 'sk-openai-new') throw new Error('encryption failed')
      return encrypt(data)
    })
    const loaded = config.loadSettings(app)
    loaded.engines.openai.apiKey = 'sk-openai-new'
    loaded.engines.groq.apiKey = 'gsk-secret'
    config.saveSettings(app, loaded)

    // the failed key is in the file, the others are not; nothing was deleted from the store
    const onDisk = JSON.parse(readSettingsText())
    expect(onDisk.engines.openai.apiKey).toBe('sk-openai-new')
    expect(readSettingsText()).not.toContain('gsk-secret')
    expect(readSettingsText()).not.toContain('sk-anthropic-secret')
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey', 'engines.groq.apiKey', 'engines.openai.apiKey'])
    expect(config.getApiKeyStorageStatus().notStored).toEqual(['engines.openai.apiKey'])

    // the value of the file wins over the older stored one
    config.clearAppSettingsCache()
    vi.mocked(safeStorage.encryptString).mockImplementation(encrypt)
    const reloaded = config.loadSettings(app)
    expect(reloaded.engines.openai.apiKey).toBe('sk-openai-new')
    expect(reloaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
    expect(reloaded.engines.groq.apiKey).toBe('gsk-secret')

    // and that load moved it to the store now that encryption works
    expect(readSettingsText()).not.toContain('sk-openai-new')
    expect(config.getApiKeyStorageStatus().notStored).toEqual([])
    config.clearAppSettingsCache()
    expect(config.loadSettings(app).engines.openai.apiKey).toBe('sk-openai-new')
  })

  test('saveApiKeys returns false unless every key was stored', () => {
    expect(config.saveApiKeys([{ name: 'a.apiKey', apiKey: 'one' }, { name: 'b.apiKey', apiKey: 'two' }])).toBe(true)
    vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => { throw new Error('encryption failed') })
    expect(config.saveApiKeys([{ name: 'a.apiKey', apiKey: 'changed' }, { name: 'b.apiKey', apiKey: 'two' }])).toBe(false)
    expect(storedKeys()).toEqual(['a.apiKey', 'b.apiKey'])
    expect(config.loadApiKeys()).toEqual([{ name: 'a.apiKey', apiKey: 'one' }, { name: 'b.apiKey', apiKey: 'two' }])
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)
    expect(config.saveApiKeys([{ name: 'a.apiKey', apiKey: 'one' }])).toBe(false)
    expect(storedKeys()).toEqual(['a.apiKey', 'b.apiKey'])
  })

  test('a failed write to the key store keeps the key in settings.json', () => {
    const loaded = config.loadSettings(app)
    const set = vi.spyOn(keyStore, 'set').mockImplementationOnce(() => { throw new Error('EACCES') })
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    set.mockRestore()
    expect(JSON.parse(readSettingsText()).engines.openai.apiKey).toBe('sk-openai-secret')
    config.clearAppSettingsCache()
    expect(config.loadSettings(app).engines.openai.apiKey).toBe('sk-openai-secret')
  })

  test('a key removed by the user is removed from the store, the others stay', () => {
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    const loaded = config.loadSettings(app)
    loaded.engines.openai.apiKey = ''
    config.saveSettings(app, loaded)
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey'])
    config.clearAppSettingsCache()
    expect(config.loadSettings(app).engines.openai.apiKey).toBe('')
  })

  test('an empty key in settings.json does not erase the stored keys', () => {
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    writeSettings({ engines: { openai: { apiKey: '' }, groq: { apiKey: '' } } })
    const loaded = config.loadSettings(app)
    expect(loaded.engines.openai.apiKey).toBe('sk-openai-secret')
    expect(loaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])
  })

  test('turning safe storage off does not drop the stored keys when settings.json cannot be written', () => {
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    const loaded = config.loadSettings(app)
    loaded.general.safeKeys = false
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })
    config.saveSettings(app, loaded)
    rename.mockRestore()
    expect(storedKeys()).toEqual(['engines.openai.apiKey'])

    // next attempt works: the key moves to the file
    config.saveSettings(app, loaded, true)
    expect(JSON.parse(readSettingsText()).engines.openai.apiKey).toBe('sk-openai-secret')
    expect(storedKeys()).toEqual([])
  })

  test('safe storage turned off by hand in settings.json moves the stored keys to the file instead of losing them', () => {
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    writeSettings({ general: { safeKeys: false } })
    const loaded = config.loadSettings(app)
    expect(loaded.engines.openai.apiKey).toBe('sk-openai-secret')
    expect(JSON.parse(readSettingsText()).engines.openai.apiKey).toBe('sk-openai-secret')
    expect(storedKeys()).toEqual([])
  })

  test('no key value or ciphertext is written to the logs when storage fails', () => {
    const logs: string[] = []
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: any[]) => { logs.push(args.map(String).join(' ')) })
    }
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => { throw new Error('keychain denied') })
    const loaded = config.loadSettings(app)
    vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => { throw new Error('encryption failed') })
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    expect(logs.join('\n')).toContain('engines.anthropic.apiKey')
    expect(logs.join('\n')).not.toContain('sk-anthropic-secret')
    expect(logs.join('\n')).not.toContain('sk-openai-secret')
  })

  test('MCP server credentials are not written to settings.json in clear text', () => {
    // only properties named *apiKey* outside arrays are extracted
    const loaded = config.loadSettings(app)
    loaded.mcp.servers = [{
      uuid: 'h1', registryId: 'h1', state: 'enabled', type: 'http', url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer header-secret' },
      env: { GITHUB_TOKEN: 'env-secret' },
      oauth: { clientId: 'id', clientSecret: 'client-secret', tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret' } },
    } as any]
    config.saveSettings(app, loaded)
    const text = readSettingsText()
    for (const secret of ['header-secret', 'env-secret', 'client-secret', 'access-secret', 'refresh-secret']) {
      expect(text, secret).not.toContain(secret)
    }
  })

})

describe('Linux key storage backend', () => {

  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value, configurable: true })
  const setBackend = (backend?: string) => {
    if (backend) (safeStorage as any).getSelectedStorageBackend = vi.fn(() => backend)
    else delete (safeStorage as any).getSelectedStorageBackend
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    setBackend()
  })

  test.each([
    ['linux', 'basic_text', true],
    ['linux', 'gnome_libsecret', false],
    ['linux', 'kwallet5', false],
    ['linux', 'unknown', false],
    ['linux', undefined, false],
    ['darwin', 'basic_text', false],
    ['win32', 'basic_text', false],
  ])('on %s with backend %s the storage is weak: %s', (os, backend, weak) => {
    setPlatform(os)
    setBackend(backend)
    expect(config.isKeyStorageWeak()).toBe(weak)
    expect(config.getApiKeyStorageStatus().weak).toBe(weak)
  })

  test('the basic_text backend is reported once in the logs, and keys still work', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPlatform('linux')
    setBackend('basic_text')
    const loaded = config.loadSettings(app)
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    config.clearAppSettingsCache()
    expect(config.loadSettings(app).engines.openai.apiKey).toBe('sk-openai-secret')
    const warnings = warn.mock.calls.filter((call) => String(call[0]).includes('basic_text'))
    expect(warnings).toHaveLength(1)
  })

  test('a backend lookup that throws is not a reason to fail', () => {
    setPlatform('linux');
    (safeStorage as any).getSelectedStorageBackend = vi.fn(() => { throw new Error('not ready') })
    expect(config.isKeyStorageWeak()).toBe(false)
    expect(() => config.loadSettings(app)).not.toThrow()
  })

})

describe('settings.json robustness', () => {

  test('fuzz: a settings file truncated at any point loads defaults and is backed up', () => {
    const full = JSON.stringify({ general: { locale: 'fr' }, engines: { openai: { apiKey: 'x' } }, llm: { engine: 'openai' } }, null, 2)
    for (let cut = 1; cut < full.length - 1; cut += 7) {
      for (const file of fs.readdirSync(userData)) fs.rmSync(path.join(userData, file), { recursive: true, force: true })
      config.clearAppSettingsCache()
      const text = full.slice(0, cut)
      writeSettings(text)
      const loaded = config.loadSettings(app)
      expect(loaded.general).toBeDefined()
      expect(loaded.engines.openai).toBeDefined()
      const backups = fs.readdirSync(userData).filter(file => /^settings\.\d+\.json$/.test(file))
      expect(backups, `cut at ${cut}`).toHaveLength(1)
      expect(fs.readFileSync(path.join(userData, backups[0]), 'utf-8')).toBe(text)
    }
  })

  test.each([['null'], ['42'], ['"text"'], ['[1,2]']])('a settings file that is not a JSON object is backed up before defaults are used: %s', (text) => {
    writeSettings(text)
    config.loadSettings(app)
    expect(config.settingsFileHadError()).toBe(true)
    const backups = fs.readdirSync(userData).filter(file => /^settings\.\d+\.json$/.test(file))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(userData, backups[0]), 'utf-8')).toBe(text)
    // the file itself is left as it is until the user saves something
    expect(readSettingsText()).toBe(text)
  })

  test('a backup that cannot be written does not prevent startup', () => {
    writeSettings('{ "general": ')
    const realWrite = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file: any, ...args: any[]) => {
      if (/settings\.\d+\.json$/.test(String(file))) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      return (realWrite as any)(file, ...args)
    })
    let loaded: any
    expect(() => loaded = config.loadSettings(app)).not.toThrow()
    expect(loaded.general).toBeTypeOf('object')
  })

  test('sections of the wrong shape get their defaults, valid ones and valid nulls are kept', () => {
    writeSettings({
      general: { locale: 'fr' },
      appearance: 'dark',
      engines: { openai: null, custom1: 'text', custom2: { label: 'Mine' } },
      shortcuts: { prompt: null },
      llm: { defaults: {} },
    })
    const loaded = config.loadSettings(app) as any
    expect(loaded.general.locale).toBe('fr')
    expect(loaded.appearance.chat).toBeTypeOf('object')
    expect(loaded.engines.openai).toBeTypeOf('object')
    expect(loaded.engines.custom1).toBeUndefined()
    expect(loaded.engines.custom2.label).toBe('Mine')
    expect(loaded.shortcuts.prompt).toBeNull()
    expect(loaded.shortcuts.main).toBeTypeOf('object')
    expect(Array.isArray(loaded.llm.defaults)).toBe(true)
  })

  test('the engine model files are written atomically too', () => {
    const loaded = config.loadSettings(app)
    loaded.engines.openai.models = { chat: [{ id: 'model-1', name: 'Model 1' }] } as any
    config.saveSettings(app, loaded)
    const engineFile = path.join(userData, 'engines', 'openai.json')
    const before = fs.readFileSync(engineFile, 'utf-8')
    expect(before).toContain('model-1')
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })
    loaded.engines.openai.models = { chat: [{ id: 'model-2', name: 'Model 2' }] } as any
    config.saveSettings(app, loaded)
    fsync.mockRestore()
    expect(fs.readFileSync(engineFile, 'utf-8')).toBe(before)
    expect(fs.readdirSync(path.join(userData, 'engines')).filter(file => file.endsWith('.tmp'))).toEqual([])
  })

  test('unknown and extra properties are preserved', () => {
    writeSettings({ general: { locale: 'fr', futureOption: { a: 1 } }, futureSection: [1, 2, 3] })
    const loaded = config.loadSettings(app) as any
    expect(loaded.general.locale).toBe('fr')
    expect(loaded.general.futureOption).toEqual({ a: 1 })
    expect(loaded.futureSection).toEqual([1, 2, 3])
  })

  test.each([
    ['null'],
    ['42'],
    ['"text"'],
    ['{"general":null}'],
    ['{"general":"text"}'],
    ['{"engines":null}'],
    ['{"engines":{"openai":null}}'],
    ['{"appearance":null}'],
    ['{"appearance":{"chat":null}}'],
    ['{"plugins":null}'],
    ['{"llm":{"defaults":null}}'],
    ['{"shortcuts":null}'],
  ])('valid JSON of the wrong shape does not prevent startup: %s', (text) => {
    // loadSettings runs before the app is ready: an exception here is a crash at launch with no dialog
    writeSettings(text)
    let loaded: any
    expect(() => loaded = config.loadSettings(app)).not.toThrow()
    expect(loaded.general).toBeTypeOf('object')
    expect(loaded.engines.openai).toBeTypeOf('object')
    expect(loaded.appearance.chat).toBeTypeOf('object')
  })

  test('an interrupted save leaves the previous settings file readable', () => {
    // settings.json is rewritten in place; a crash or a full disk mid-write leaves a truncated file
    const loaded = config.loadSettings(app)
    loaded.general.locale = 'fr'
    config.saveSettings(app, loaded)
    const realWrite = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file: any, data: any, ...args: any[]) => {
      if (typeof data === 'string' && data.includes('"general"')) {
        realWrite(file, data.slice(0, Math.floor(data.length / 2)), ...args)
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return realWrite(file, data, ...args)
    })
    loaded.general.locale = 'de'
    config.saveSettings(app, loaded)
    vi.mocked(fs.writeFileSync).mockRestore()
    const onDisk = JSON.parse(readSettingsText())
    expect(['fr', 'de']).toContain(onDisk.general.locale)
  })

})
