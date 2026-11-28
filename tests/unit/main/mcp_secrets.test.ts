
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app, safeStorage } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as config from '@main/config'
import { hasUnprotectedMcpSecrets, MCP_SECRET_PREFIX, protectMcpSecrets, revealMcpSecrets } from '@main/mcp_secrets'

let userData: string

// reversible stand-in for the OS keychain: the output differs on every call, as with the real one,
// and what was encrypted with one keychain cannot be decrypted with another one
const { keychain, keyStore } = vi.hoisted(() => {
  const keychain = {
    id: 'A',
    nonce: 0,
    encrypt: (data: string): Buffer => {
      return Buffer.from(`sealed:${keychain.id}:${keychain.nonce++}:${Buffer.from(data, 'utf-8').toString('hex')}`, 'latin1')
    },
    decrypt: (data: Buffer): string => {
      const [marker, id, , hex] = data.toString('latin1').split(':')
      if (marker !== 'sealed' || id !== keychain.id) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      }
      return Buffer.from(hex, 'hex').toString('utf-8')
    },
  }
  return { keychain, keyStore: new Map<string, string>() }
})

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    }
  }
})

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

const SECRETS = ['env-secret', 'other-env-secret', 'header-secret', 'client-secret', 'access-secret', 'refresh-secret', 'id-secret', 'claude-env-secret', 'claude-header-secret', 'extra-client-secret', 'extra-access-secret']

const sampleServers = (): any => ({
  mcp: {
    servers: [
      {
        uuid: 'stdio1', registryId: 'stdio1', state: 'enabled', type: 'stdio',
        command: 'npx', url: '-y @modelcontextprotocol/server-github', cwd: '/tmp/work',
        env: { GITHUB_TOKEN: 'env-secret', OTHER: 'other-env-secret', EMPTY: '' },
        toolSelection: null,
      },
      {
        uuid: 'http1', registryId: 'http1', state: 'enabled', type: 'http', url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer header-secret' },
        oauth: {
          clientId: 'client-id', clientSecret: 'client-secret', scope: 'read write',
          tokens: { access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: 'id-secret', token_type: 'Bearer', expires_in: 3600, scope: 'read write' },
        },
        timeout: 30,
        toolSelection: ['tool1'],
      },
    ],
    mcpServersExtra: {
      '@claude': {
        label: 'Claude style', state: 'disabled',
        oauth: { clientId: 'extra-client-id', clientSecret: 'extra-client-secret', tokens: { access_token: 'extra-access-secret', token_type: 'Bearer' } },
      },
    },
  },
  mcpServers: {
    '@claude': {
      command: 'node', args: ['server.js', '--port', '3000'], cwd: '/tmp/claude',
      env: { CLAUDE_SECRET: 'claude-env-secret' },
      headers: { 'X-Token': 'claude-header-secret' },
    },
  },
})

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const expectNoSecret = (text: string) => {
  for (const secret of SECRETS) {
    expect(text, secret).not.toContain(secret)
  }
}

const breakKeychain = () => {
  keychain.id = 'B'
}

beforeEach(() => {
  vi.clearAllMocks()
  keychain.id = 'A'
  keychain.nonce = 0
  keyStore.clear()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReset().mockReturnValue(true)
  vi.mocked(safeStorage.encryptString).mockReset().mockImplementation(keychain.encrypt)
  vi.mocked(safeStorage.decryptString).mockReset().mockImplementation(keychain.decrypt)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('protectMcpSecrets', () => {

  test('encrypts the secrets of every kind of server entry', () => {

    const settings = sampleServers()
    protectMcpSecrets(settings)

    expectNoSecret(JSON.stringify(settings))

    const [stdio, http] = settings.mcp.servers
    expect(stdio.env.GITHUB_TOKEN).toMatch(/^enc:v1:[A-Za-z0-9+/]+=*$/)
    expect(stdio.env.OTHER).toMatch(/^enc:v1:/)
    expect(http.headers.Authorization).toMatch(/^enc:v1:/)
    expect(http.oauth.clientSecret).toMatch(/^enc:v1:/)
    expect(http.oauth.tokens.access_token).toMatch(/^enc:v1:/)
    expect(http.oauth.tokens.refresh_token).toMatch(/^enc:v1:/)
    expect(http.oauth.tokens.id_token).toMatch(/^enc:v1:/)
    expect(settings.mcp.mcpServersExtra['@claude'].oauth.clientSecret).toMatch(/^enc:v1:/)
    expect(settings.mcp.mcpServersExtra['@claude'].oauth.tokens.access_token).toMatch(/^enc:v1:/)
    expect(settings.mcpServers['@claude'].env.CLAUDE_SECRET).toMatch(/^enc:v1:/)
    expect(settings.mcpServers['@claude'].headers['X-Token']).toMatch(/^enc:v1:/)

  })

  test('leaves everything else readable', () => {

    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)

    const [stdio, http] = settings.mcp.servers
    expect({ ...stdio, env: null }).toStrictEqual({ ...original.mcp.servers[0], env: null })
    expect(Object.keys(stdio.env)).toStrictEqual(['GITHUB_TOKEN', 'OTHER', 'EMPTY'])
    expect(stdio.env.EMPTY).toBe('')
    expect({ ...http, headers: null, oauth: null }).toStrictEqual({ ...original.mcp.servers[1], headers: null, oauth: null })
    expect(http.oauth.clientId).toBe('client-id')
    expect(http.oauth.scope).toBe('read write')
    expect(http.oauth.tokens.token_type).toBe('Bearer')
    expect(http.oauth.tokens.expires_in).toBe(3600)
    expect(http.oauth.tokens.scope).toBe('read write')
    expect(settings.mcp.mcpServersExtra['@claude'].label).toBe('Claude style')
    expect(settings.mcp.mcpServersExtra['@claude'].oauth.clientId).toBe('extra-client-id')
    expect(settings.mcp.mcpServersExtra['@claude'].oauth.tokens.token_type).toBe('Bearer')
    expect({ ...settings.mcpServers['@claude'], env: null, headers: null }).toStrictEqual({ ...original.mcpServers['@claude'], env: null, headers: null })

  })

  test('revealMcpSecrets restores the original settings', () => {
    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)
    expect(settings).not.toStrictEqual(original)
    revealMcpSecrets(JSON.parse(JSON.stringify(settings)))
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('handles secrets with any character', () => {
    const settings = { mcp: { servers: [{ env: { A: 'pässwörd 🔑\n"quoted"', B: ' ', C: 'x'.repeat(10000) } }] } }
    const original = copy(settings)
    protectMcpSecrets(settings)
    expect(Object.values(settings.mcp.servers[0].env).every((value) => value.startsWith(MCP_SECRET_PREFIX))).toBe(true)
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

  test('handles tokens stored as a string and servers of the old plugin configuration', () => {
    const original = {
      mcp: { servers: [{ oauth: { tokens: '{"access_token":"access-secret"}' } }] },
      plugins: { mcp: { servers: [{ env: { KEY: 'env-secret' } }] } },
    }
    const settings = copy(original)
    protectMcpSecrets(settings)
    expectNoSecret(JSON.stringify(settings))
    expect(settings.mcp.servers[0].oauth.tokens).toMatch(/^enc:v1:/)
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

  test('never encrypts a value twice', () => {
    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)
    const once = copy(settings)
    const calls = vi.mocked(safeStorage.encryptString).mock.calls.length
    protectMcpSecrets(settings)
    expect(settings).toStrictEqual(once)
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(calls)
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

  test('leaves empty and non string values alone', () => {
    const original = { mcp: { servers: [{ env: { EMPTY: '', NUMBER: 1, NULL: null, FLAG: true, LIST: ['a'], NESTED: { a: 'b' } }, oauth: { clientSecret: '', tokens: { access_token: '', expires_in: 10 } } }] } }
    const settings = copy(original)
    protectMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  test('leaves to the API key store the values it takes out of settings.json', () => {
    const settings = {
      mcp: { servers: [{ env: { OPENAI_APIKEY: 'env-secret' } }] },
      mcpServers: { claude: { command: 'node', args: [] as string[], env: { OPENAI_APIKEY: 'in-key-store', OTHER: 'claude-env-secret' }, headers: { apiKey: 'in-key-store' } } },
    }
    protectMcpSecrets(settings)
    expect(settings.mcp.servers[0].env.OPENAI_APIKEY).toMatch(/^enc:v1:/)
    expect(settings.mcpServers.claude.env.OTHER).toMatch(/^enc:v1:/)
    expect(settings.mcpServers.claude.env.OPENAI_APIKEY).toBe('in-key-store')
    expect(settings.mcpServers.claude.headers.apiKey).toBe('in-key-store')
    expect(hasUnprotectedMcpSecrets({ mcpServers: { claude: { env: { OPENAI_APIKEY: 'in-key-store' } } } })).toBe(false)
  })

  test('keeps clear text when encryption is not available', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  test('keeps clear text when the availability check throws', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockImplementation(() => { throw new Error('safeStorage cannot be used before app is ready') })
    const original = sampleServers()
    const settings = copy(original)
    expect(() => protectMcpSecrets(settings)).not.toThrow()
    expect(settings).toStrictEqual(original)
    expect(hasUnprotectedMcpSecrets(settings)).toBe(false)
  })

  test('keeps in clear text a value that fails to encrypt', () => {
    vi.mocked(safeStorage.encryptString).mockImplementation((data: string) => {
      if (data.includes('header-secret')) throw new Error('encryption failed for Bearer header-secret')
      return keychain.encrypt(data)
    })
    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)
    expect(settings.mcp.servers[1].headers.Authorization).toBe('Bearer header-secret')
    expect(settings.mcp.servers[0].env.GITHUB_TOKEN).toMatch(/^enc:v1:/)
    expect(settings.mcp.servers[1].oauth.clientSecret).toMatch(/^enc:v1:/)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expectNoSecret(JSON.stringify(vi.mocked(console.warn).mock.calls))
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

  test.each([
    ['is not a buffer', () => 'not a buffer'],
    ['is empty', () => Buffer.alloc(0)],
    ['cannot be read back', () => Buffer.from('sealed:A:0:00', 'latin1')],
  ])('keeps clear text when the encrypted value %s', (_, encryptString) => {
    vi.mocked(safeStorage.encryptString).mockImplementation(encryptString as any)
    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

})

describe('revealMcpSecrets', () => {

  test('keeps the encrypted value when it cannot be decrypted', () => {

    const original = sampleServers()
    const settings = copy(original)
    protectMcpSecrets(settings)
    const encrypted = copy(settings)

    breakKeychain()
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(encrypted)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expectNoSecret(JSON.stringify(vi.mocked(console.warn).mock.calls))
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(MCP_SECRET_PREFIX)

    // saved back as it is
    protectMcpSecrets(settings)
    expect(settings).toStrictEqual(encrypted)

    // and readable again when the keychain is back
    keychain.id = 'A'
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)

  })

  test('keeps the encrypted value when decryption returns something else than what was encrypted', () => {
    const settings = sampleServers()
    protectMcpSecrets(settings)
    const encrypted = copy(settings)
    vi.mocked(safeStorage.decryptString).mockImplementation(() => 'garbage from another key')
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(encrypted)
  })

  test('keeps a value that only looks encrypted', () => {
    const original = { mcp: { servers: [{ env: { A: 'enc:v1:', B: 'enc:v1:not base64 !', C: 'enc:v1:aGVsbG8=', D: 'enc:v2:aGVsbG8=' } }] } }
    const settings = copy(original)
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
    protectMcpSecrets(settings)
    expect(settings.mcp.servers[0].env).toMatchObject({ A: 'enc:v1:', B: 'enc:v1:not base64 !', C: 'enc:v1:aGVsbG8=' })
    expect(settings.mcp.servers[0].env.D).toMatch(/^enc:v1:/)
  })

  test('decrypts whatever the safe keys option says and when encryption is reported unavailable', () => {
    const original = { general: { safeKeys: false }, ...sampleServers() }
    const settings = copy(original)
    protectMcpSecrets(settings)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    revealMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

  test('only looks where secrets are stored', () => {
    const settings = sampleServers()
    protectMcpSecrets(settings)
    const encrypted = settings.mcp.servers[0].env.GITHUB_TOKEN
    const original = { general: { name: encrypted }, mcp: { servers: [{ command: encrypted, url: encrypted, label: encrypted, oauth: { clientId: encrypted } }] } }
    const other = copy(original)
    revealMcpSecrets(other)
    expect(other).toStrictEqual(original)
  })

})

describe('unexpected shapes', () => {

  test.each([
    [null],
    [42],
    ['text'],
    [[]],
    [[{ env: { A: 'b' } }]],
    [{}],
    [{ mcp: null }],
    [{ mcp: 'text' }],
    [{ mcp: [] }],
    [{ mcp: { servers: null } }],
    [{ mcp: { servers: 'text' } }],
    [{ mcp: { servers: [null, 1, 'text', [], [{ env: { A: 'b' } }]] } }],
    [{ mcp: { servers: [{ env: null, headers: 'text', oauth: [] }] } }],
    [{ mcp: { servers: [{ env: ['a', 'b'], headers: 12, oauth: 'text' }] } }],
    [{ mcp: { servers: [{ oauth: { clientSecret: 12, tokens: 34 } }] } }],
    [{ mcp: { servers: [{ oauth: { clientSecret: null, tokens: null } }] } }],
    [{ mcp: { servers: [{ oauth: { tokens: ['access-secret'] } }] } }],
    [{ mcp: { mcpServersExtra: null } }],
    [{ mcp: { mcpServersExtra: { a: null, b: 'text', c: { oauth: null } } } }],
    [{ mcpServers: null }],
    [{ mcpServers: 'text' }],
    [{ mcpServers: { a: null, b: 1, c: { env: 'text' } } }],
    [{ plugins: null }],
    [{ plugins: { mcp: null } }],
    [{ plugins: { mcp: { servers: {} } } }],
    [{ general: null, mcp: { servers: [] } }],
  ])('%j is left untouched without an error', (settings) => {
    const original = copy(settings)
    expect(() => protectMcpSecrets(settings)).not.toThrow()
    expect(() => revealMcpSecrets(settings)).not.toThrow()
    expect(() => hasUnprotectedMcpSecrets(settings)).not.toThrow()
    expect(settings).toStrictEqual(original)
    expect(hasUnprotectedMcpSecrets(settings)).toBe(false)
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  test('undefined is accepted', () => {
    expect(() => protectMcpSecrets(undefined)).not.toThrow()
    expect(() => revealMcpSecrets(undefined)).not.toThrow()
    expect(hasUnprotectedMcpSecrets(undefined)).toBe(false)
  })

  test('objects that cannot be modified do not throw', () => {
    const settings = { mcp: { servers: [{ env: Object.freeze({ A: 'env-secret' }) }] } }
    expect(() => protectMcpSecrets(settings)).not.toThrow()
    expect(settings.mcp.servers[0].env.A).toBe('env-secret')
  })

})

describe('hasUnprotectedMcpSecrets', () => {

  test('tells when clear text secrets should be encrypted', () => {
    expect(hasUnprotectedMcpSecrets(sampleServers())).toBe(true)
    expect(hasUnprotectedMcpSecrets({ general: {}, ...sampleServers() })).toBe(true)
    expect(hasUnprotectedMcpSecrets({ general: { safeKeys: true }, ...sampleServers() })).toBe(true)
    expect(hasUnprotectedMcpSecrets({ mcp: { servers: [{ env: { A: 'env-secret' } }] } })).toBe(true)
    expect(hasUnprotectedMcpSecrets({ mcpServers: { a: { env: { A: 'env-secret' } } } })).toBe(true)
    expect(hasUnprotectedMcpSecrets({ mcp: { mcpServersExtra: { a: { oauth: { clientSecret: 'client-secret' } } } } })).toBe(true)
  })

  test('does not modify the settings', () => {
    const original = sampleServers()
    const settings = copy(original)
    hasUnprotectedMcpSecrets(settings)
    expect(settings).toStrictEqual(original)
  })

  test('is false when there is nothing to encrypt', () => {
    expect(hasUnprotectedMcpSecrets({ mcp: { servers: [], mcpServersExtra: {} }, mcpServers: {} })).toBe(false)
    expect(hasUnprotectedMcpSecrets({ mcp: { servers: [{ command: 'npx', url: 'server', env: { EMPTY: '' } }] } })).toBe(false)
    const settings = sampleServers()
    protectMcpSecrets(settings)
    expect(hasUnprotectedMcpSecrets(settings)).toBe(false)
  })

  test('is false when safe keys are off', () => {
    expect(hasUnprotectedMcpSecrets({ general: { safeKeys: false }, ...sampleServers() })).toBe(false)
  })

  test('is false when encryption is not available', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(hasUnprotectedMcpSecrets(sampleServers())).toBe(false)
  })

  test('is false when a value cannot be encrypted', () => {
    vi.mocked(safeStorage.encryptString).mockImplementation((data: string) => {
      if (data.includes('refresh-secret')) throw new Error('encryption failed')
      return keychain.encrypt(data)
    })
    expect(hasUnprotectedMcpSecrets(sampleServers())).toBe(false)
  })

})

describe('settings.json', () => {

  const settingsFile = () => path.join(userData, 'settings.json')
  const readSettingsText = () => fs.readFileSync(settingsFile(), 'utf-8')
  const writeSettings = (content: any) => fs.writeFileSync(settingsFile(), JSON.stringify(content, null, 2))
  const reload = () => {
    config.clearAppSettingsCache()
    return config.loadSettings(app) as any
  }
  const mcpOf = (settings: any) => copy({ mcp: { servers: settings.mcp.servers, mcpServersExtra: settings.mcp.mcpServersExtra }, mcpServers: settings.mcpServers })

  const saveSample = () => {
    const loaded = reload()
    Object.assign(loaded.mcp, sampleServers().mcp)
    loaded.mcpServers = sampleServers().mcpServers
    config.saveSettings(app, loaded)
    return loaded
  }

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-secrets-'))
    config.setSaveConfigInTests()
    config.clearAppSettingsCache()
  })

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true })
  })

  test('secrets are encrypted in the file and come back on load', () => {

    const saved = saveSample()

    // the configuration given to saveSettings is the one used by the app
    expect(mcpOf(saved)).toStrictEqual(sampleServers())
    expect(JSON.stringify(config.loadSettings(app))).not.toContain(MCP_SECRET_PREFIX)

    const text = readSettingsText()
    expectNoSecret(text)
    const onDisk = JSON.parse(text)
    expect(onDisk.mcp.servers[0]).toMatchObject({ uuid: 'stdio1', command: 'npx', url: '-y @modelcontextprotocol/server-github', cwd: '/tmp/work' })
    expect(onDisk.mcp.servers[0].env.GITHUB_TOKEN).toMatch(/^enc:v1:/)
    expect(onDisk.mcp.servers[1]).toMatchObject({ uuid: 'http1', url: 'https://mcp.example.com/mcp' })
    expect(onDisk.mcp.servers[1].oauth).toMatchObject({ clientId: 'client-id', scope: 'read write', tokens: { token_type: 'Bearer', expires_in: 3600 } })
    expect(onDisk.mcpServers['@claude']).toMatchObject({ command: 'node', args: ['server.js', '--port', '3000'], cwd: '/tmp/claude' })

    const reloaded = reload()
    expect(mcpOf(reloaded)).toStrictEqual(sampleServers())
    expect(JSON.stringify(reloaded)).not.toContain(MCP_SECRET_PREFIX)
    expect(console.warn).not.toHaveBeenCalled()

  })

  test('loading does not rewrite a file that is already encrypted', () => {
    saveSample()
    const text = readSettingsText()
    reload()
    reload()
    expect(readSettingsText()).toBe(text)
    const reloaded = reload()
    config.saveSettings(app, reloaded)
    expect(readSettingsText()).toBe(text)
  })

  test('a file with clear text secrets is encrypted on load, once', () => {

    writeSettings({ general: { locale: 'fr' }, ...sampleServers() })

    const loaded = reload()
    expect(mcpOf(loaded)).toStrictEqual(sampleServers())
    expect(loaded.general.locale).toBe('fr')

    const text = readSettingsText()
    expectNoSecret(text)
    expect(JSON.parse(text).general.locale).toBe('fr')

    expect(mcpOf(reload())).toStrictEqual(sampleServers())
    reload()
    expect(readSettingsText()).toBe(text)

  })

  test('a secret added by hand in an encrypted file is encrypted on the next load', () => {
    saveSample()
    const onDisk = JSON.parse(readSettingsText())
    onDisk.mcp.servers[0].env.ADDED = 'added-by-hand'
    writeSettings(onDisk)
    const loaded = reload()
    expect(loaded.mcp.servers[0].env).toStrictEqual({ ...sampleServers().mcp.servers[0].env, ADDED: 'added-by-hand' })
    expect(readSettingsText()).not.toContain('added-by-hand')
    expect(reload().mcp.servers[0].env.ADDED).toBe('added-by-hand')
  })

  test('secrets that cannot be decrypted survive saves and come back with the keychain', () => {

    saveSample()
    const encrypted = JSON.parse(readSettingsText())

    breakKeychain()
    const loaded = reload()
    expect(mcpOf(loaded)).toStrictEqual(mcpOf(encrypted))
    expect(loaded.mcp.servers[0].command).toBe('npx')

    // a save of something else writes them back byte for byte
    loaded.general.locale = 'fr'
    loaded.mcp.servers[0].env.ADDED = 'added-later'
    config.saveSettings(app, loaded)
    const onDisk = JSON.parse(readSettingsText())
    expect(onDisk.general.locale).toBe('fr')
    expect(onDisk.mcp.servers[0].env.ADDED).toMatch(/^enc:v1:/)
    delete onDisk.mcp.servers[0].env.ADDED
    expect(mcpOf(onDisk)).toStrictEqual(mcpOf(encrypted))

    // loading again changes nothing either
    const text = readSettingsText()
    reload()
    expect(readSettingsText()).toBe(text)

    keychain.id = 'A'
    const recovered = reload()
    delete recovered.mcp.servers[0].env.ADDED
    expect(mcpOf(recovered)).toStrictEqual(sampleServers())

  })

  test('secrets stay in clear text when encryption is not available', () => {

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    saveSample()
    const text = readSettingsText()
    expect(mcpOf(JSON.parse(text))).toStrictEqual(sampleServers())
    expect(text).not.toContain(MCP_SECRET_PREFIX)

    expect(mcpOf(reload())).toStrictEqual(sampleServers())
    expect(readSettingsText()).toBe(text)

    // and are encrypted as soon as it is
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(mcpOf(reload())).toStrictEqual(sampleServers())
    expectNoSecret(readSettingsText())

  })

  test('a secret that fails to encrypt stays in clear text and loading does not rewrite the file', () => {

    vi.mocked(safeStorage.encryptString).mockImplementation((data: string) => {
      if (data.includes('header-secret')) throw new Error('encryption failed')
      return keychain.encrypt(data)
    })

    saveSample()
    const text = readSettingsText()
    const onDisk = JSON.parse(text)
    expect(onDisk.mcp.servers[1].headers.Authorization).toBe('Bearer header-secret')
    expect(onDisk.mcp.servers[0].env.GITHUB_TOKEN).toMatch(/^enc:v1:/)

    expect(mcpOf(reload())).toStrictEqual(sampleServers())
    expect(mcpOf(reload())).toStrictEqual(sampleServers())
    expect(readSettingsText()).toBe(text)

  })

  test('secrets are written in clear text when safe keys are off', () => {

    const loaded = saveSample()
    expectNoSecret(readSettingsText())

    // turning the option off decrypts what was encrypted
    loaded.general.safeKeys = false
    config.saveSettings(app, loaded)
    let text = readSettingsText()
    expect(text).not.toContain(MCP_SECRET_PREFIX)
    expect(mcpOf(JSON.parse(text))).toStrictEqual(sampleServers())
    expect(mcpOf(reload())).toStrictEqual(sampleServers())
    expect(readSettingsText()).toBe(text)

    // encrypted values are still decrypted when the option is off
    const onDisk = JSON.parse(text)
    protectMcpSecrets(onDisk)
    writeSettings(onDisk)
    text = readSettingsText()
    expectNoSecret(text)
    const reloaded = reload()
    expect(reloaded.general.safeKeys).toBe(false)
    expect(mcpOf(reloaded)).toStrictEqual(sampleServers())
    expect(readSettingsText()).toBe(text)

  })

  test('values that go to the API key store are not encrypted in place', () => {

    const loaded = reload()
    loaded.mcpServers = { claude: { command: 'node', args: ['server.js'], env: { OPENAI_APIKEY: 'in-key-store', OTHER: 'claude-env-secret' } } }
    config.saveSettings(app, loaded)

    const onDisk = JSON.parse(readSettingsText())
    expect(onDisk.mcpServers.claude.env.OPENAI_APIKEY).toBeUndefined()
    expect(onDisk.mcpServers.claude.env.OTHER).toMatch(/^enc:v1:/)
    expect([...keyStore.keys()]).toContain('mcpServers.claude.env.OPENAI_APIKEY')

    const text = readSettingsText()
    const reloaded = reload()
    expect(reloaded.mcpServers.claude.env).toStrictEqual({ OPENAI_APIKEY: 'in-key-store', OTHER: 'claude-env-secret' })
    expect(readSettingsText()).toBe(text)

  })

  test('settings of the wrong shape load as before', () => {
    writeSettings({ mcp: { servers: [null, 'text', { env: 'text', oauth: 12 }] }, mcpServers: { a: { env: null } } })
    const loaded = reload()
    expect(loaded.mcp.servers).toStrictEqual([null, 'text', { env: 'text', oauth: 12 }])
    expect(loaded.mcpServers).toStrictEqual({ a: { env: null } })
  })

})
