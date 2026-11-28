
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
  })

  test('keys stay in settings.json when the user turned safe storage off', () => {
    const loaded = config.loadSettings(app)
    loaded.general.safeKeys = false
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    expect(readSettingsText()).toContain('sk-openai-secret')
    expect(storedKeys()).toEqual([])
  })

  bug('a key that cannot be decrypted right now is kept in the store', () => {
    // locked keychain, denied keychain prompt, keyring backend not ready yet... the error is not proof the key is gone for good
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    vi.mocked(safeStorage.decryptString).mockImplementation(() => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') })
    config.loadSettings(app)
    expect(storedKeys()).toEqual(['engines.anthropic.apiKey', 'engines.openai.apiKey'])
  })

  bug('a key typed into settings.json by hand does not erase the other stored keys', () => {
    // loadSettings sees a plaintext key, and saves that list after clearing the store
    storeKey('engines.openai.apiKey', 'sk-openai-secret')
    storeKey('engines.anthropic.apiKey', 'sk-anthropic-secret')
    writeSettings({ engines: { groq: { apiKey: 'gsk-new-key' } } })
    const loaded = config.loadSettings(app)
    expect(loaded.engines.groq.apiKey).toBe('gsk-new-key')
    expect(loaded.engines.openai.apiKey).toBe('sk-openai-secret')
    expect(loaded.engines.anthropic.apiKey).toBe('sk-anthropic-secret')
  })

  bug('a key that fails to encrypt is not dropped from both the store and settings.json', () => {
    // saveApiKeys reports success, so the caller removes the plaintext copy too
    const loaded = config.loadSettings(app)
    vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => { throw new Error('encryption failed') })
    loaded.engines.openai.apiKey = 'sk-openai-secret'
    config.saveSettings(app, loaded)
    const inFile = readSettingsText().includes('sk-openai-secret')
    const inStore = storedKeys().includes('engines.openai.apiKey')
    expect(inFile || inStore).toBe(true)
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

  test('unknown and extra properties are preserved', () => {
    writeSettings({ general: { locale: 'fr', futureOption: { a: 1 } }, futureSection: [1, 2, 3] })
    const loaded = config.loadSettings(app) as any
    expect(loaded.general.locale).toBe('fr')
    expect(loaded.general.futureOption).toEqual({ a: 1 })
    expect(loaded.futureSection).toEqual([1, 2, 3])
  })

  bug.each([
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

  bug('an interrupted save leaves the previous settings file readable', () => {
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
