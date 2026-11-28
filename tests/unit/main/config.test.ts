
import { app, safeStorage } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi, Mock } from 'vitest'
import defaultSettings from '@root/defaults/settings.json'
import * as config from '@main/config'
import { migrateMcpToolNames } from '@main/migrations/mcp_tool_names'

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => ''),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((data) => `encrypted-${data}`),
      decryptString: vi.fn((data) => data.toString('latin1'))
    }
  }
})

vi.mock('electron-store', async () => {
  const Store = vi.fn()
  Store.prototype.store = {
    'engines.openai.apiKey': Buffer.from('openai-api-key', 'latin1')
  }
  Store.prototype.delete = vi.fn()
  Store.prototype.set = vi.fn()
  return { default: Store }
})

// settings are written through the atomic helper: route it to the mocked fs so that fixtures are never modified
vi.mock('@main/atomic', async () => {
  const fs = (await import('fs')).default
  return { writeFileAtomicSync: (file: string, data: string) => fs.writeFileSync(file, data) }
})

vi.mock('fs', async (importOriginal) => {
  const mod: any = await importOriginal()
  return { default: {
    ...mod,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn()
  }}
})

beforeEach(() => {
  vi.clearAllMocks()
  config.setSaveConfigInTests()
  config.clearAppSettingsCache()
})

test('Load default settings', () => {
  const loaded = config.loadSettings(app)
  expect(config.settingsFileHadError()).toBe(false)
  loaded.engines.openai.baseURL = defaultSettings.engines.openai.baseURL
  loaded.engines.ollama.baseURL = defaultSettings.engines.ollama.baseURL
  loaded.engines.lmstudio.baseURL = defaultSettings.engines.lmstudio.baseURL
  loaded.engines.sdwebui.baseURL = defaultSettings.engines.sdwebui.baseURL
  expect(loaded.engines.openai.apiKey).toBe('openai-api-key')
  loaded.engines.openai.apiKey = ''
  expect(loaded).toStrictEqual(defaultSettings)
  expect(loaded.general.locale).toBe('')
  expect(loaded.engines.openai.models.chat).toStrictEqual([])
  // the stored key is unchanged: it is neither deleted nor rewritten
  expect(Store.prototype.delete).not.toHaveBeenCalled()
  expect(Store.prototype.set).not.toHaveBeenCalled()
})

test('Uses cache on second load', () => {
  vi.spyOn(fs, 'readFileSync')
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/override1')
  config.loadSettings(app)
  expect(fs.readFileSync).toHaveBeenCalledTimes(2)
  config.loadSettings(app)
  expect(fs.readFileSync).toHaveBeenCalledTimes(2)
})

test('Does not save when unmodified', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/override1')
  const loaded = config.loadSettings(app)
  config.saveSettings(app, loaded)
  expect(fs.writeFileSync).not.toHaveBeenCalled()
  loaded.general.locale = 'en'
  config.saveSettings(app, loaded)
  expect(fs.writeFileSync).toHaveBeenCalled()
  vi.clearAllMocks()
  const loaded2 = config.loadSettings(app)
  expect(loaded2.general.locale).toBe('en')
  loaded2.general.locale = 'fr'
  config.saveSettings(app, loaded2)
  expect(fs.writeFileSync).toHaveBeenCalled()
})

test('Load engine config files', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/engines')
  const loaded = config.loadSettings(app)
  expect(loaded.engines.openai.apiKey).toBe('openai-api-key')
  expect(loaded.engines.openai.models.chat).toHaveLength(1)
})

test('Load settings with error', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/invalid')
  const loaded = config.loadSettings(app)
  expect(config.settingsFileHadError()).toBe(true)
  loaded.engines.openai.baseURL = defaultSettings.engines.openai.baseURL
  loaded.engines.ollama.baseURL = defaultSettings.engines.ollama.baseURL
  loaded.engines.lmstudio.baseURL = defaultSettings.engines.lmstudio.baseURL
  loaded.engines.sdwebui.baseURL = defaultSettings.engines.sdwebui.baseURL
  expect(loaded.engines.openai.apiKey).toBe('openai-api-key')
  loaded.engines.openai.apiKey = ''
  expect(loaded).toStrictEqual(defaultSettings)
})

test('Load overridden settings 1', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/override1')
  const loaded = config.loadSettings(app)
  expect(loaded.general.locale).toBe('fr')
  expect(loaded.general.keepRunning).toBe(true)
})

test('Load overridden settings 2', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/override2')
  const loaded = config.loadSettings(app)
  expect(loaded.engines.openai.models.chat).toStrictEqual(['model1', 'model2'])
})

test('Backwards compatibility 1', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/compat1')
  const loaded = config.loadSettings(app)
  expect(loaded.general.proxyMode).toBe('bypass')
  expect(loaded.appearance.darkTint).toBe('blue')
  expect(loaded.engines.openai.model.chat).toBe('model1')
  expect(loaded.engines.ollama.model.chat).toBe('model2')
  expect(loaded.llm.defaults[0].instructions).toBe('instructions')
})

test('Backwards compatibility 2', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/compat2')
  const loaded = config.loadSettings(app)
  expect(loaded.engines.openai.apiKey).toBe('openai-api-key2')
  // the new value replaces the stored one without deleting it first
  expect(Store.prototype.delete).not.toHaveBeenCalled()
  expect(Store.prototype.set).toHaveBeenCalledWith('engines.openai.apiKey', 'encrypted-openai-api-key2')
  expect(fs.writeFileSync).toHaveBeenCalledWith('tests/fixtures/config/compat2/settings.json', expect.any(String))
  const calls = (fs.writeFileSync as Mock).mock.calls
  expect(calls[calls.length-1][0]).toBe('tests/fixtures/config/compat2/settings.json')
  expect(JSON.stringify(calls[calls.length-1][1])).not.toContain('apiKey')
})

test('Save engine config', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/engines')
  const loaded = config.loadSettings(app)
  config.saveSettings(app, loaded, true)
  expect(fs.writeFileSync).toHaveBeenCalledWith('tests/fixtures/config/engines/engines/openai.json', expect.any(String))
  expect(fs.writeFileSync).toHaveBeenLastCalledWith('tests/fixtures/config/engines/settings.json', expect.any(String))
  // @ts-expect-error mock type stuff
  const calls = (fs.writeFileSync.mock as Mock).calls
  const openai = JSON.parse(calls[0][1])
  expect(openai.models.chat).toHaveLength(1)
  const settings = JSON.parse(calls[calls.length - 1][1])
  expect(settings.engines.openai.apiKey).toBeUndefined()
  expect(settings.engines.openai.models).toBeUndefined()
})

test('Save apiKeys settings', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/unknown')
  const loaded = config.loadSettings(app)
  config.saveSettings(app, loaded, true)
  expect(fs.writeFileSync).toHaveBeenLastCalledWith('tests/fixtures/config/unknown/settings.json', expect.any(String))
  // @ts-expect-error mock type stuff
  const calls = (fs.writeFileSync.mock as Mock).calls
  expect(JSON.parse(calls[calls.length - 1][1]).engines.openai.apiKey).toBeUndefined()
  expect(Store.prototype.delete).not.toHaveBeenCalled()
  expect(Store.prototype.set).not.toHaveBeenCalled()
})

test('Save modified apiKeys settings', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/unknown')
  const loaded = config.loadSettings(app)
  loaded.engines.openai.apiKey = 'openai-api-key3'
  config.saveSettings(app, loaded, true)
  expect(Store.prototype.delete).not.toHaveBeenCalled()
  expect(Store.prototype.set).toHaveBeenCalledWith('engines.openai.apiKey', 'encrypted-openai-api-key3')
})

test('Save removed apiKeys settings', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/unknown')
  const loaded = config.loadSettings(app)
  loaded.engines.openai.apiKey = ''
  config.saveSettings(app, loaded, true)
  expect(Store.prototype.delete).toHaveBeenCalledWith('engines.openai.apiKey')
  expect(Store.prototype.set).not.toHaveBeenCalled()
})

test('Save apiKeys settings with safeKeys disabled', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/unknown')
  const loaded = config.loadSettings(app)
  vi.clearAllMocks()
  loaded.general.safeKeys = false
  config.saveSettings(app, loaded, true)
  expect(fs.writeFileSync).toHaveBeenLastCalledWith('tests/fixtures/config/unknown/settings.json', expect.any(String))
  // @ts-expect-error mock type stuff
  const calls = (fs.writeFileSync.mock as Mock).calls
  const settings = JSON.parse(calls[calls.length - 1][1])
  expect(settings.engines.openai.apiKey).toBe('openai-api-key')
  expect(Store.prototype.delete).toHaveBeenCalledWith('engines.openai.apiKey')
  expect(Store.prototype.set).not.toHaveBeenCalled()
})

test('Backwards compatibility: Python plugin with binpath', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/python-binpath')
  const loaded = config.loadSettings(app)
  expect(loaded.plugins.python.runtime).toBe('native')
  expect(loaded.plugins.python.binpath).toBe('/usr/bin/python3')
})

test('Backwards compatibility: Python plugin without binpath', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/python-no-binpath')
  const loaded = config.loadSettings(app)
  expect(loaded.plugins.python.runtime).toBe('embedded')
})

test('Python plugin with runtime already set', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/python-with-runtime')
  const loaded = config.loadSettings(app)
  expect(loaded.plugins.python.runtime).toBe('native')
  expect(loaded.plugins.python.binpath).toBe('/opt/python3')
})

test('Backwards compatibility: old codeExecution object format', () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/old-code-execution')
  const loaded = config.loadSettings(app)
  expect(loaded.llm.codeExecution).toBe('disabled')
})

test('Migration: MCP tool name old suffix format', async () => {
  vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/mcp-old-tool-names')

  // First load settings (migration not yet run)
  config.clearAppSettingsCache()
  const loaded = config.loadSettings(app)

  // Before migration, tools still have old suffixes
  expect(loaded.llm.defaults[0].tools).toContain('tool1___90ab')
  expect(loaded.prompt.tools).toContain('search___1234')
  expect(loaded.realtime.tools).toContain('voice___abcd')

  // Run the migration function (this is called from main.ts at startup)
  // The migration modifies and saves settings
  const migrated = await migrateMcpToolNames(app)
  expect(migrated).toBe(6)

  // The migration function loads its own copy of settings, migrates, and saves
  // It returns the count of migrated tool names
  // The fixture has: 3 with suffix in llm.defaults, 2 with suffix in prompt, 1 with suffix in realtime = 6
  // Actually: tool1___90ab, tool2___0abc, browse___cdef (3), search___1234, execute___5678 (2), voice___abcd (1) = 6
})

describe('MCP secrets', () => {

  // as config.ts builds it: with the separators of the host
  const settingsFile = path.join('tests/fixtures/config/unknown', 'settings.json')

  const servers = (): any => ({
    mcp: {
      servers: [{
        uuid: 'http1', registryId: 'http1', state: 'enabled', type: 'http', url: 'https://mcp.example.com/mcp',
        env: { GITHUB_TOKEN: 'env-secret' },
        headers: { Authorization: 'Bearer header-secret' },
        oauth: { clientId: 'client-id', clientSecret: 'client-secret', tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer' } },
        toolSelection: null,
      }],
      mcpServersExtra: { claude: { oauth: { clientId: 'extra-client-id', clientSecret: 'extra-client-secret' } } },
    },
    mcpServers: { claude: { command: 'node', args: ['server.js'], env: { CLAUDE_TOKEN: 'claude-env-secret' } } },
  })

  const secrets = ['env-secret', 'header-secret', 'client-secret', 'access-secret', 'refresh-secret', 'claude-env-secret']

  const mcpOf = (settings: any) => JSON.parse(JSON.stringify({
    mcp: { servers: settings.mcp.servers, mcpServersExtra: settings.mcp.mcpServersExtra }, mcpServers: settings.mcpServers
  }))

  const savedSettings = (): string[] => vi.mocked(fs.writeFileSync).mock.calls.filter((call) => call[0] === settingsFile).map((call) => call[1] as string)

  // settings.json is not written in these tests: this gives its content to loadSettings
  const settingsFileContains = (content: string) => {
    const readFileSync = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      return file === settingsFile ? content : (readFileSync as any)(file, ...args)
    }) as any)
  }

  const loadWithServers = () => {
    const loaded = config.loadSettings(app)
    Object.assign(loaded.mcp, servers().mcp)
    loaded.mcpServers = servers().mcpServers
    return loaded
  }

  beforeEach(() => {
    vi.mocked(app.getPath).mockReturnValue('./tests/fixtures/config/unknown')
    vi.mocked(safeStorage.encryptString).mockImplementation(((data: string) => Buffer.from(`sealed-${data}`, 'utf-8')) as any)
    vi.mocked(safeStorage.decryptString).mockImplementation((data: Buffer) => data.toString('utf-8').replace(/^sealed-/, ''))
  })

  afterEach(() => {
    vi.mocked(fs.readFileSync).mockRestore?.()
    vi.mocked(safeStorage.isEncryptionAvailable).mockImplementation(() => true)
    vi.mocked(safeStorage.encryptString).mockImplementation(((data: string) => `encrypted-${data}`) as any)
    vi.mocked(safeStorage.decryptString).mockImplementation((data: Buffer) => data.toString('latin1'))
  })

  test('Save encrypts MCP secrets in the file only', () => {

    const loaded = loadWithServers()
    config.saveSettings(app, loaded)

    const text = savedSettings().at(-1)
    for (const secret of secrets) {
      expect(text, secret).not.toContain(secret)
    }
    const saved = JSON.parse(text)
    expect(saved.mcp.servers[0]).toMatchObject({ uuid: 'http1', type: 'http', url: 'https://mcp.example.com/mcp' })
    expect(saved.mcp.servers[0].env.GITHUB_TOKEN).toMatch(/^enc:v1:/)
    expect(saved.mcp.servers[0].headers.Authorization).toMatch(/^enc:v1:/)
    expect(saved.mcp.servers[0].oauth).toMatchObject({ clientId: 'client-id', tokens: { token_type: 'Bearer' } })
    expect(saved.mcp.servers[0].oauth.clientSecret).toMatch(/^enc:v1:/)
    expect(saved.mcp.servers[0].oauth.tokens.access_token).toMatch(/^enc:v1:/)
    expect(saved.mcp.servers[0].oauth.tokens.refresh_token).toMatch(/^enc:v1:/)
    expect(saved.mcp.mcpServersExtra.claude.oauth.clientSecret).toMatch(/^enc:v1:/)
    expect(saved.mcpServers.claude).toMatchObject({ command: 'node', args: ['server.js'] })
    expect(saved.mcpServers.claude.env.CLAUDE_TOKEN).toMatch(/^enc:v1:/)

    // the configuration of the running app is not modified
    expect(mcpOf(loaded)).toStrictEqual(servers())
    expect(mcpOf(config.loadSettings(app))).toStrictEqual(servers())

  })

  test('Load decrypts MCP secrets and does not save again', () => {

    config.saveSettings(app, loadWithServers())
    const text = savedSettings().at(-1)

    vi.mocked(fs.writeFileSync).mockClear()
    settingsFileContains(text)

    for (let i = 0; i < 2; i++) {
      config.clearAppSettingsCache()
      const loaded = config.loadSettings(app)
      expect(mcpOf(loaded)).toStrictEqual(servers())
      expect(JSON.stringify(loaded)).not.toContain('enc:v1:')
      config.saveSettings(app, loaded)
    }
    expect(savedSettings()).toHaveLength(0)

  })

  test('Load saves again a file with MCP secrets in clear text', () => {

    settingsFileContains(JSON.stringify(servers()))
    const loaded = config.loadSettings(app)

    expect(mcpOf(loaded)).toStrictEqual(servers())
    expect(savedSettings()).toHaveLength(1)
    for (const secret of secrets) {
      expect(savedSettings()[0], secret).not.toContain(secret)
    }
    expect(mcpOf(config.loadSettings(app))).toStrictEqual(servers())

  })

  test('Load keeps MCP secrets that cannot be decrypted and save writes them back', () => {

    config.saveSettings(app, loadWithServers())
    const text = savedSettings().at(-1)

    vi.mocked(fs.writeFileSync).mockClear()
    settingsFileContains(text)
    vi.mocked(safeStorage.decryptString).mockImplementation((data: Buffer) => {
      if (data.toString('utf-8').startsWith('sealed-')) throw new Error('Error while decrypting the ciphertext')
      return data.toString('latin1')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    config.clearAppSettingsCache()
    const loaded = config.loadSettings(app)
    expect(mcpOf(loaded)).toStrictEqual(mcpOf(JSON.parse(text)))
    expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('[mcp]'))).toHaveLength(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('enc:v1:')
    expect(savedSettings()).toHaveLength(0)

    loaded.general.locale = 'fr'
    config.saveSettings(app, loaded)
    expect(savedSettings()).toHaveLength(1)
    expect(mcpOf(JSON.parse(savedSettings()[0]))).toStrictEqual(mcpOf(JSON.parse(text)))

    warn.mockRestore()

  })

  test('Save keeps MCP secrets in clear text with safeKeys disabled', () => {

    const loaded = loadWithServers()
    loaded.general.safeKeys = false
    config.saveSettings(app, loaded)

    const text = savedSettings().at(-1)
    expect(text).not.toContain('enc:v1:')
    expect(mcpOf(JSON.parse(text))).toStrictEqual(servers())

  })

  test('Load decrypts MCP secrets and does not save clear text ones with safeKeys disabled', () => {

    // no stored API key: with safeKeys disabled a stored key is moved to the file on load (D-01), which is a save of its own
    const storedKeys = Store.prototype.store
    Store.prototype.store = {}
    onTestFinished(() => { Store.prototype.store = storedKeys })

    config.saveSettings(app, loadWithServers())
    const encrypted = JSON.parse(savedSettings().at(-1))
    vi.mocked(fs.writeFileSync).mockClear()

    settingsFileContains(JSON.stringify({ ...encrypted, general: { safeKeys: false } }))
    config.clearAppSettingsCache()
    expect(mcpOf(config.loadSettings(app))).toStrictEqual(servers())
    expect(savedSettings()).toHaveLength(0)

    vi.mocked(fs.readFileSync).mockRestore()
    settingsFileContains(JSON.stringify({ ...servers(), general: { safeKeys: false } }))
    config.clearAppSettingsCache()
    expect(mcpOf(config.loadSettings(app))).toStrictEqual(servers())
    expect(savedSettings()).toHaveLength(0)

  })

  test('Save keeps MCP secrets in clear text when encryption is not available', () => {

    const loaded = loadWithServers()
    vi.mocked(safeStorage.isEncryptionAvailable).mockImplementation(() => false)
    config.saveSettings(app, loaded)

    const text = savedSettings().at(-1)
    expect(text).not.toContain('enc:v1:')
    expect(mcpOf(JSON.parse(text))).toStrictEqual(servers())

    // and loading such a file does not save it again
    vi.mocked(fs.writeFileSync).mockClear()
    settingsFileContains(JSON.stringify(servers()))
    config.clearAppSettingsCache()
    expect(mcpOf(config.loadSettings(app))).toStrictEqual(servers())
    expect(savedSettings()).toHaveLength(0)

  })

})
