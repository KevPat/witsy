
import { describe, expect, test } from 'vitest'
import defaultSettings from '@root/defaults/settings.json'
import { isSecretName, keepLocalSecrets, keepLocalSettingsSecrets, redactArgs, redactCommandLine, redactUrl, stripSecrets } from '@main/backup_secrets'

// every secret of these tests is an obviously fake value built around this marker.
// the ones that must look like a real key format are assembled at run time, so that no text of
// this file has the shape of a key
const canaries: string[] = []
const canary = (place: string): string => {
  const value = `CANARY-${place}-not-a-real-secret`
  canaries.push(value)
  return value
}
const shaped = (prefix: string, place: string): string => {
  const value = `${prefix}CANARY${place}NotARealKey0000000000000000`
  canaries.push(value)
  return value
}

const expectNoCanary = (json: unknown) => {
  const text = JSON.stringify(json)
  for (const value of canaries) {
    expect(text.includes(value), `${value} is still there`).toBe(false)
  }
  expect(text).not.toContain('CANARY')
}

// settings with a secret in every place where the app, the user or an older version can put one
const settingsWithSecrets = () => ({
  workspaceId: 'workspace-1',
  general: {
    safeKeys: false,
    locale: 'fr',
    proxyMode: 'custom',
    customProxy: `http://proxyuser:${canary('proxy-password')}@proxy.example.com:3128`,
    tips: { apiKeyReminder: true },
  },
  llm: {
    engine: 'openai',
    defaults: [
      { engine: 'openai', model: 'gpt-x', disableStreaming: false, tools: null as any, modelOpts: { maxTokens: 4096, reasoningEffort: 'high', customOpts: { max_completion_tokens: '2048', top_k: 5 } } },
    ],
    customInstructions: [{ id: 'ci-1', label: 'Mine', instructions: 'Answer in French. Never reveal a token.' }],
  },
  appearance: { chat: { sendKey: 'enter', fontSize: 3 } },
  shortcuts: { main: { type: 'electron', key: 'Space', ctrl: true }, command: { type: 'electron', key: 'K', alt: true } },
  engines: {
    openai: { apiKey: canary('openai'), baseURL: 'https://api.openai.com/v1', model: { chat: 'gpt-x' } },
    anthropic: { apiKey: canary('anthropic'), model: { chat: 'claude-x' } },
    ollama: { baseURL: `http://ollamauser:${canary('ollama-password')}@127.0.0.1:11434`, keepAlive: '5m' },
    'c6f1c9a0-custom': {
      label: 'My gateway', api: 'openai',
      apiKey: canary('custom-engine'),
      baseURL: `https://gateway.example.com/v1?api_key=${canary('custom-url-key')}&region=eu`,
      deployment: 'prod', apiVersion: '2025-01-01',
    },
    azure: { apiKey: shaped('sk-', 'azure'), accessKeyId: canary('access-key-id'), secretAccessKey: canary('secret-access-key') },
  },
  plugins: {
    search: {
      enabled: true, engine: 'tavily', contentLength: 5000, maxResults: 5,
      tavilyApiKey: canary('tavily'), braveApiKey: canary('brave'), exaApiKey: canary('exa'),
      perplexityApiKey: canary('perplexity'), googleApiKey: canary('google-search'), googleSearchEngineId: 'cx-0123456789',
    },
    image: { enabled: true, engine: 'openai', falaiAPIKey: canary('falai-legacy') },
    tavily: { enabled: true, apiKey: canary('tavily-legacy') },
    python: { enabled: true, runtime: 'native', binpath: '/usr/bin/python3' },
    filesystem: { enabled: true, allowedPaths: ['/home/me/projects'], allowWrite: false },
  },
  stt: { engine: 'openai', customOpenAI: { baseURL: `https://stt.example.com/v1?token=${canary('stt-url-token')}` } },
  tts: { engine: 'openai', customOpenAI: { baseURL: `https://${canary('tts-userinfo')}@tts.example.com/v1` } },
  mcp: {
    smitheryApiKey: canary('smithery'),
    servers: [
      {
        uuid: 'server-stdio', registryId: 'server-stdio', state: 'enabled', type: 'stdio', label: 'Local tools',
        command: 'npx',
        url: `-y @example/server --key ${canary('args-key')} --api-key=${canary('args-api-key')} --token ${canary('args-token')} --header "Authorization: Bearer ${canary('args-header')}" SERVICE_API_KEY=${canary('args-variable')} postgresql://dbuser:${canary('args-db-password')}@db.example.com/main --profile work`,
        cwd: '/home/me/tools',
        env: { GITHUB_TOKEN: canary('env-github'), NODE_ENV: canary('env-plain-name'), DEBUG: '1' },
        toolSelection: ['get_access_token', 'list_secrets'],
        toolMappings: { get_access_token: 'get_access_token_1', list_secrets: 'list_secrets_1' },
      },
      {
        uuid: 'server-http', registryId: 'server-http', state: 'enabled', type: 'http', label: 'Remote',
        url: `https://mcp.example.com/mcp?access_token=${canary('http-url-token')}&version=2`,
        headers: { Authorization: `Bearer ${canary('header-authorization')}`, 'X-Api-Key': canary('header-api-key'), 'X-Tenant': canary('header-plain-name') },
        oauth: {
          tokens: { access_token: canary('oauth-access'), refresh_token: canary('oauth-refresh'), token_type: 'Bearer', expires_in: 3600, scope: 'read' },
          clientId: 'client-123',
          clientSecret: canary('oauth-client-secret'),
          scope: 'read write',
        },
        toolSelection: null as any,
      },
      {
        uuid: 'server-sse', registryId: 'server-sse', state: 'disabled', type: 'sse',
        url: `https://sseuser:${canary('sse-password')}@sse.example.com/events`,
        oauth: null as any,
        toolSelection: null as any,
      },
    ],
    mcpServersExtra: {
      s1: { state: 'disabled', label: 'S1', oauth: { tokens: { access_token: canary('extra-oauth-access') }, clientId: 'client-s1', clientSecret: canary('extra-client-secret') } },
      secrets: { state: 'enabled', toolSelection: ['read_secret'] },
    },
  },
  mcpServers: {
    s1: {
      command: 'npx',
      args: ['-y', '@example/s1', '--token', canary('claude-args-token'), `--password=${canary('claude-args-password')}`, '-H', `X-Api-Key: ${canary('claude-args-header')}`, '--verbose'],
      cwd: '/home/me',
      env: { EXAMPLE_API_KEY: canary('claude-env') },
      headers: { Cookie: canary('claude-header') },
    },
    secrets: { command: 'node', args: ['secrets-server.js'] },
  },
  features: {
    experimental: true,
    somethingNew: { password: canary('feature-password'), credentials: { user: 'me', pass: canary('feature-credentials') }, note: shaped('ghp_', 'feature') },
  },
})

describe('names', () => {

  test.each([
    'apiKey', 'APIKey', 'api_key', 'tavilyApiKey', 'falaiAPIKey', 'X-Api-Key', 'smitheryApiKey',
    'clientSecret', 'client_secret', 'secretAccessKey', 'accessKeyId', 'privateKey',
    'webhookToken', 'accessToken', 'access_token', 'refresh_token', 'GITHUB_TOKEN', 'tokens',
    'password', 'passwd', 'passphrase', 'credentials', 'Authorization', 'Cookie',
  ])('%s holds a credential', (name) => {
    expect(isSecretName(name)).toBe(true)
  })

  test.each([
    'maxTokens', 'max_tokens', 'maxOutputTokens', 'max_completion_tokens', 'reasoningTokens', 'totalTokens',
    'tokenLimit', 'token_type', 'tokenizer', 'contextWindowTokens', 'tokenEndpoint', 'token_url',
    'key', 'sendKey', 'label', 'model', 'engine', 'googleSearchEngineId', 'clientId', 'scope', 'safeKeys',
  ])('%s does not', (name) => {
    expect(isSecretName(name)).toBe(false)
  })

})

describe('stripSecrets', () => {

  test('removes every secret of the settings', () => {
    expectNoCanary(stripSecrets(settingsWithSecrets()))
  })

  test('keeps what is not a secret', () => {
    const settings = settingsWithSecrets()
    const clean = stripSecrets(settings) as any

    expect(clean.workspaceId).toBe('workspace-1')
    expect(clean.general).toEqual({ safeKeys: false, locale: 'fr', proxyMode: 'custom', customProxy: 'http://proxy.example.com:3128', tips: { apiKeyReminder: true } })
    expect(clean.llm).toEqual(settings.llm)
    expect(clean.appearance).toEqual(settings.appearance)
    expect(clean.shortcuts).toEqual(settings.shortcuts)

    expect(clean.engines.openai).toEqual({ apiKey: '', baseURL: 'https://api.openai.com/v1', model: { chat: 'gpt-x' } })
    expect(clean.engines.ollama).toEqual({ baseURL: 'http://127.0.0.1:11434', keepAlive: '5m' })
    expect(clean.engines['c6f1c9a0-custom']).toEqual({
      label: 'My gateway', api: 'openai', apiKey: '',
      baseURL: 'https://gateway.example.com/v1?api_key=&region=eu',
      deployment: 'prod', apiVersion: '2025-01-01',
    })

    expect(clean.plugins.search).toEqual({
      enabled: true, engine: 'tavily', contentLength: 5000, maxResults: 5,
      tavilyApiKey: '', braveApiKey: '', exaApiKey: '', perplexityApiKey: '', googleApiKey: '', googleSearchEngineId: 'cx-0123456789',
    })
    expect(clean.plugins.python).toEqual(settings.plugins.python)
    expect(clean.plugins.filesystem).toEqual(settings.plugins.filesystem)

    expect(clean.stt.customOpenAI.baseURL).toBe('https://stt.example.com/v1?token=')
    expect(clean.tts.customOpenAI.baseURL).toBe('https://tts.example.com/v1')
  })

  test('MCP servers keep their definition, the names of their variables and headers, and nothing of their values', () => {
    const clean = stripSecrets(settingsWithSecrets()) as any
    const [stdio, http, sse] = clean.mcp.servers

    expect(stdio).toEqual({
      uuid: 'server-stdio', registryId: 'server-stdio', state: 'enabled', type: 'stdio', label: 'Local tools',
      command: 'npx',
      url: '-y @example/server --key --api-key= --token --header "Authorization: " SERVICE_API_KEY= postgresql://db.example.com/main --profile work',
      cwd: '/home/me/tools',
      env: { GITHUB_TOKEN: '', NODE_ENV: '', DEBUG: '' },
      toolSelection: ['get_access_token', 'list_secrets'],
      toolMappings: { get_access_token: 'get_access_token_1', list_secrets: 'list_secrets_1' },
    })

    expect(http).toEqual({
      uuid: 'server-http', registryId: 'server-http', state: 'enabled', type: 'http', label: 'Remote',
      url: 'https://mcp.example.com/mcp?access_token=&version=2',
      headers: { Authorization: '', 'X-Api-Key': '', 'X-Tenant': '' },
      oauth: { clientId: 'client-123', clientSecret: '', scope: 'read write' },
      toolSelection: null,
    })

    expect(sse).toEqual({
      uuid: 'server-sse', registryId: 'server-sse', state: 'disabled', type: 'sse',
      url: 'https://sse.example.com/events',
      oauth: null,
      toolSelection: null,
    })

    expect(clean.mcp.smitheryApiKey).toBe('')
    expect(clean.mcp.mcpServersExtra.s1).toEqual({ state: 'disabled', label: 'S1', oauth: { clientId: 'client-s1', clientSecret: '' } })
    expect(clean.mcpServers.s1).toEqual({
      command: 'npx',
      args: ['-y', '@example/s1', '--token', '', '--password=', '-H', 'X-Api-Key: ', '--verbose'],
      cwd: '/home/me',
      env: { EXAMPLE_API_KEY: '' },
      headers: { Cookie: '' },
    })
  })

  test('a server or an engine whose name looks like a secret is still a server or an engine', () => {
    const clean = stripSecrets(settingsWithSecrets()) as any
    expect(clean.mcpServers.secrets).toEqual({ command: 'node', args: ['secrets-server.js'] })
    expect(clean.mcp.mcpServersExtra.secrets).toEqual({ state: 'enabled', toolSelection: ['read_secret'] })
    expect(stripSecrets({ engines: { tokens: { label: 'Tokens Inc', api: 'openai', apiKey: canary('engine-called-tokens') } } })).toEqual({
      engines: { tokens: { label: 'Tokens Inc', api: 'openai', apiKey: '' } },
    })
  })

  test('unknown sections are searched too', () => {
    const clean = stripSecrets(settingsWithSecrets()) as any
    expect(clean.features).toEqual({ experimental: true, somethingNew: { password: '', note: '' } })
  })

  test('the default settings have nothing to remove', () => {
    expect(stripSecrets(defaultSettings)).toEqual(defaultSettings)
  })

  test('the input is not modified', () => {
    const settings = settingsWithSecrets()
    const copy = JSON.parse(JSON.stringify(settings))
    stripSecrets(settings)
    expect(settings).toEqual(copy)
  })

  test('an agent loses its webhook token, and nothing else', () => {
    const agent = {
      uuid: 'agent-1', source: 'witsy', name: 'Basic Internationalization', description: 'Basic helper',
      type: 'runnable', engine: 'openai', model: 'gpt-x', modelOpts: { maxTokens: 1000 },
      instructions: 'Use the token budget wisely', parameters: [{ name: 'token', type: 'string', description: 'A word', required: true }],
      steps: [{ prompt: 'Summarize {{token}}', tools: ['get_access_token'], agents: [] as string[] }],
      schedule: '0 9 * * *',
      webhookToken: canary('webhook'),
      invocationValues: { topic: 'news', apiKey: canary('invocation-value') },
    }
    const clean = stripSecrets(agent)
    expectNoCanary(clean)
    expect(clean).toEqual({ ...agent, webhookToken: null, invocationValues: { topic: 'news', apiKey: '' } })
  })

  test('an agent without a webhook stays as it is', () => {
    const agent = { uuid: 'agent-2', name: 'Plain', webhookToken: null as string | null, invocationValues: {} }
    expect(stripSecrets(agent)).toEqual(agent)
  })

  test('the web apps of a workspace lose the credentials of their url', () => {
    const workspace = {
      uuid: 'workspace-1', name: 'Work', models: [{ id: 'm1', engine: 'openai', model: 'gpt-x' }],
      webapps: [
        { id: 'app-1', name: 'Intranet', url: `https://me:${canary('webapp-password')}@intranet.example.com/home`, enabled: true },
        { id: 'app-2', name: 'Board', url: `https://board.example.com/b/42?token=${canary('webapp-token')}&view=list`, enabled: true },
        { id: 'app-3', name: 'Plain', url: 'https://example.com/docs?page=2', enabled: false },
      ],
    }
    const clean = stripSecrets(workspace) as any
    expectNoCanary(clean)
    expect(clean.webapps.map((app: any) => app.url)).toEqual([
      'https://intranet.example.com/home',
      'https://board.example.com/b/42?token=&view=list',
      'https://example.com/docs?page=2',
    ])
    expect(clean.models).toEqual(workspace.models)
  })

  test.each([
    ['http://proxy.example.com:3128', 'http://proxy.example.com:3128'],
    ['proxy.example.com:3128', 'proxy.example.com:3128'],
    ['socks5://me:pw@proxy.example.com:1080', 'socks5://proxy.example.com:1080'],
    ['me:pw@proxy.example.com:3128', 'proxy.example.com:3128'],
    ['http://proxy.example.com/proxy.pac?for=me@example.com', 'http://proxy.example.com/proxy.pac?for=me@example.com'],
    ['', ''],
  ])('the address of a proxy %s loses its user and password, with or without a scheme', (proxy, expected) => {
    expect(stripSecrets({ general: { proxyMode: 'custom', customProxy: proxy } })).toEqual({ general: { proxyMode: 'custom', customProxy: expected } })
  })

  test('values that are not objects come back as they are', () => {
    expect(stripSecrets(null)).toBeNull()
    expect(stripSecrets(12)).toBe(12)
    expect(stripSecrets('text')).toBe('text')
    expect(stripSecrets([1, 'two', { apiKey: canary('in-a-list') }])).toEqual([1, 'two', { apiKey: '' }])
  })

})

describe('urls and command lines', () => {

  test.each([
    ['https://example.com/v1', 'https://example.com/v1'],
    ['https://user:pass@example.com/v1', 'https://example.com/v1'],
    ['https://token@example.com/v1', 'https://example.com/v1'],
    ['https://example.com/v1?key=abc&model=x', 'https://example.com/v1?key=&model=x'],
    ['https://example.com/v1?api-key=abc', 'https://example.com/v1?api-key='],
    ['https://example.com/cb#access_token=abc&state=1', 'https://example.com/cb#access_token=&state=1'],
    ['https://example.com/v1?max_tokens=10&page_token=abc', 'https://example.com/v1?max_tokens=10&page_token=abc'],
    ['https://example.com/a@b', 'https://example.com/a@b'],
    ['not a url with key=abc', 'not a url with key=abc'],
    ['', ''],
  ])('redactUrl(%s)', (url, expected) => {
    expect(redactUrl(url)).toBe(expected)
  })

  test.each([
    ['-y @scope/server /some/path', '-y @scope/server /some/path'],
    ['run   server.js  --port 8080', 'run   server.js  --port 8080'],
    ['-y @smithery/cli@latest run @x/y --key abc123 --profile work', '-y @smithery/cli@latest run @x/y --key --profile work'],
    ['--api-key=abc --model x', '--api-key= --model x'],
    ['--token -starts-with-a-dash', '--token'],
    ['--header "Authorization: Bearer abc" --header \'X-Key: def\'', '--header "Authorization: " --header \'X-Key: \''],
    ['-H X-Api-Key:abc', '-H X-Api-Key: '],
    ['OPENAI_API_KEY=abc SMITHERY_KEY=def NODE_ENV=production server.js', 'OPENAI_API_KEY= SMITHERY_KEY= NODE_ENV=production server.js'],
    ['--url https://user:pw@example.com/x?token=abc', '--url https://example.com/x?token='],
    ['--db=postgresql://user:pw@db/main', '--db=postgresql://db/main'],
  ])('redactCommandLine(%s)', (line, expected) => {
    expect(redactCommandLine(line)).toBe(expected)
  })

  test('a key in a well-known format is removed wherever it stands', () => {
    const key = shaped('sk-', 'command')
    expect(redactCommandLine(`server.js ${key} --fast`)).toBe('server.js --fast')
    expect(redactCommandLine(`server.js "${key}" --fast`)).toBe('server.js --fast')
    expect(redactArgs(['server.js', key, '--fast'])).toEqual(['server.js', '', '--fast'])
  })

  test('redactArgs keeps the length of the list', () => {
    expect(redactArgs(['-y', 'pkg', '--key', 'abc', '--secret=def', '--verbose'])).toEqual(['-y', 'pkg', '--key', '', '--secret=', '--verbose'])
    expect(redactArgs(['--key'])).toEqual(['--key'])
    expect(redactArgs([])).toEqual([])
  })

})

describe('keepLocalSecrets', () => {

  test('nothing is ever imported from the file that is restored', () => {
    const restored = { uuid: 'agent-1', name: 'Agent', webhookToken: canary('restored-webhook') }
    expect(keepLocalSecrets(restored, null)).toEqual({ uuid: 'agent-1', name: 'Agent', webhookToken: null })
    expect(keepLocalSecrets(restored, { uuid: 'agent-1', name: 'Agent', webhookToken: null })).toEqual({ uuid: 'agent-1', name: 'Agent', webhookToken: null })
    expectNoCanary(keepLocalSecrets(restored, { uuid: 'agent-1', name: 'Agent', webhookToken: 'local-token' }))
  })

  test('an agent keeps the webhook token it has on this computer', () => {
    const restored = { uuid: 'agent-1', name: 'Renamed in the backup', webhookToken: null as string | null }
    const local = { uuid: 'agent-1', name: 'Agent', webhookToken: 'local-token' }
    expect(keepLocalSecrets(restored, local)).toEqual({ uuid: 'agent-1', name: 'Renamed in the backup', webhookToken: 'local-token' })
  })

  test('another agent in the same file does not give its token', () => {
    const restored = { uuid: 'agent-1', name: 'Agent', webhookToken: null as string | null }
    const local = { uuid: 'agent-2', name: 'Other', webhookToken: 'local-token' }
    expect(keepLocalSecrets(restored, local)).toEqual(restored)
  })

  test('a web app keeps its credentials when it is the same web app', () => {
    const restored = { uuid: 'w', webapps: [
      { id: 'app-1', name: 'Intranet', url: 'https://intranet.example.com/home' },
      { id: 'app-2', name: 'Moved', url: 'https://elsewhere.example.com/home' },
      { id: 'app-9', name: 'New', url: 'https://new.example.com/' },
    ] }
    const local = { uuid: 'w', webapps: [
      { id: 'app-2', name: 'Board', url: 'https://me:pw2@board.example.com/home' },
      { id: 'app-1', name: 'Intranet', url: 'https://me:pw1@intranet.example.com/home' },
    ] }
    expect((keepLocalSecrets(restored, local) as any).webapps.map((app: any) => app.url)).toEqual([
      'https://me:pw1@intranet.example.com/home',
      'https://elsewhere.example.com/home',
      'https://new.example.com/',
    ])
  })

  const localServer = () => ({
    uuid: 'server-1', registryId: 'server-1', state: 'enabled', type: 'stdio', command: 'npx',
    url: '-y @example/server --key local-args-key',
    env: { GITHUB_TOKEN: 'local-github', ONLY_HERE: 'local-only' },
    headers: { Authorization: 'Bearer local-header' },
    oauth: { tokens: { access_token: 'local-access', refresh_token: 'local-refresh' }, clientId: 'client-1', clientSecret: 'local-client-secret', scope: 'read' },
  })

  const restoredServer = () => ({
    uuid: 'server-1', registryId: 'server-1', state: 'disabled', type: 'stdio', command: 'npx',
    url: '-y @example/server --key',
    env: { GITHUB_TOKEN: '', ONLY_IN_BACKUP: '' },
    headers: { Authorization: '' },
    oauth: { clientId: 'client-1', clientSecret: '', scope: 'read' },
  })

  test('the same MCP server gets back its values, for the names the backup has', () => {
    const result = keepLocalSecrets({ mcp: { servers: [restoredServer()] } }, { mcp: { servers: [localServer()] } }) as any
    expect(result.mcp.servers[0]).toEqual({
      uuid: 'server-1', registryId: 'server-1', state: 'disabled', type: 'stdio', command: 'npx',
      url: '-y @example/server --key local-args-key',
      env: { GITHUB_TOKEN: 'local-github', ONLY_IN_BACKUP: '' },
      headers: { Authorization: 'Bearer local-header' },
      oauth: { tokens: { access_token: 'local-access', refresh_token: 'local-refresh' }, clientId: 'client-1', clientSecret: 'local-client-secret', scope: 'read' },
    })
  })

  test.each([
    ['another command', { command: 'node' }],
    ['other arguments', { url: '-y @evil/server --key' }],
    ['another folder', { cwd: '/tmp/elsewhere' }],
    ['another kind of server', { type: 'http', url: 'https://evil.example.com/mcp' }],
  ])('a server with %s gets nothing: a credential is for what it was entered for', (_, change) => {
    const restored = { ...restoredServer(), ...change }
    const result = keepLocalSecrets({ mcp: { servers: [restored] } }, { mcp: { servers: [localServer()] } }) as any
    expect(result.mcp.servers[0]).toEqual(restored)
    expect(JSON.stringify(result)).not.toContain('local-')
  })

  test('a server with another id gets nothing', () => {
    const restored = { ...restoredServer(), uuid: 'server-2', registryId: 'server-2' }
    const result = keepLocalSecrets({ mcp: { servers: [restored] } }, { mcp: { servers: [localServer()] } }) as any
    expect(JSON.stringify(result)).not.toContain('local-')
  })

  test('the secret and the tokens of an OAuth client only come back for the same client', () => {
    const restored = restoredServer()
    restored.oauth.clientId = 'client-2'
    const result = keepLocalSecrets({ mcp: { servers: [restored] } }, { mcp: { servers: [localServer()] } }) as any
    expect(result.mcp.servers[0].oauth).toEqual({ clientId: 'client-2', clientSecret: '', scope: 'read' })
    expect(result.mcp.servers[0].env).toEqual({ GITHUB_TOKEN: 'local-github', ONLY_IN_BACKUP: '' })
    expect(JSON.stringify(result)).not.toContain('local-access')
    expect(JSON.stringify(result)).not.toContain('local-client-secret')
  })

  test('servers in the other format: same command and same arguments', () => {
    const local = { mcpServers: { s1: { command: 'npx', args: ['-y', 's1', '--token', 'local-token'], env: { KEY: 'local-env' } } } }
    const same = { mcpServers: { s1: { command: 'npx', args: ['-y', 's1', '--token', ''], env: { KEY: '' } } } }
    const other = { mcpServers: { s1: { command: 'npx', args: ['-y', 'evil', '--token', ''], env: { KEY: '' } } } }
    expect(keepLocalSecrets(same, local)).toEqual(local)
    expect(keepLocalSecrets(other, local)).toEqual(other)
  })

})

describe('keepLocalSettingsSecrets', () => {

  const keep = (restored: any, local: any, opts: { localKeys?: { name: string, apiKey: string }[], stored?: string[] } = {}) => {
    return keepLocalSettingsSecrets(restored, local, opts.localKeys ?? [], opts.stored ?? [], defaultSettings)
  }

  test('the keys of the local settings file are kept, also where the backup has no place for them', () => {
    const local = { general: { safeKeys: false }, engines: { openai: { apiKey: 'local-openai' }, groq: { apiKey: 'local-groq' } }, plugins: { search: { tavilyApiKey: 'local-tavily' } }, mcp: { smitheryApiKey: 'local-smithery' } }
    const restored = { general: { locale: 'fr' }, engines: { openai: { apiKey: canary('backup-openai'), model: { chat: 'gpt-x' } } } }
    const result = keep(restored, local, { localKeys: [
      { name: 'engines.openai.apiKey', apiKey: 'local-openai' },
      { name: 'engines.groq.apiKey', apiKey: 'local-groq' },
      { name: 'plugins.search.tavilyApiKey', apiKey: 'local-tavily' },
      { name: 'mcp.smitheryApiKey', apiKey: 'local-smithery' },
      { name: 'engines.anthropic.apiKey', apiKey: '' },
    ] })
    expectNoCanary(result)
    expect(result).toEqual({
      general: { locale: 'fr', safeKeys: false },
      engines: { openai: { apiKey: 'local-openai', model: { chat: 'gpt-x' } }, groq: { apiKey: 'local-groq' } },
      plugins: { search: { tavilyApiKey: 'local-tavily' } },
      mcp: { smitheryApiKey: 'local-smithery' },
    })
  })

  test('where the keys are stored is decided by this computer, not by the backup', () => {
    expect(keep({ general: { safeKeys: false } }, { general: { safeKeys: true } }).general.safeKeys).toBe(true)
    expect(keep({ general: { safeKeys: false } }, { general: { locale: 'fr' } }).general.safeKeys).toBe(true)
    expect(keep({ general: { safeKeys: false } }, {}).general.safeKeys).toBe(true)
    expect(keep({ general: { safeKeys: true } }, { general: { safeKeys: false } }).general.safeKeys).toBe(false)
    expect(keep({}, { general: { safeKeys: false } }).general.safeKeys).toBe(false)
    // nothing is written when both agree
    expect(keep({ general: { locale: 'fr' } }, { general: { locale: 'en' } })).toEqual({ general: { locale: 'fr' } })
    expect(keep({}, {})).toEqual({})
  })

  test('a custom engine that exists only here and has a key in the key store is kept', () => {
    const local = { engines: { openai: {}, 'custom-1': { label: 'Mine', api: 'openai', baseURL: 'https://mine.example.com/v1' }, 'custom-2': { label: 'No key', api: 'openai' } } }
    const restored = { engines: { openai: { model: { chat: 'gpt-x' } }, 'custom-3': { label: 'From the backup', api: 'openai' } } }
    const result = keep(restored, local, { stored: ['engines.openai.apiKey', 'engines.custom-1.apiKey', 'engines.gone.apiKey'] })
    expect(result.engines).toEqual({
      openai: { model: { chat: 'gpt-x' } },
      'custom-3': { label: 'From the backup', api: 'openai' },
      'custom-1': { label: 'Mine', api: 'openai', baseURL: 'https://mine.example.com/v1' },
    })
  })

  test('same with a key that is in the local settings file', () => {
    const local = { general: { safeKeys: false }, engines: { 'custom-1': { label: 'Mine', api: 'openai', apiKey: 'local-custom' } } }
    const result = keep({ engines: {} }, local, { localKeys: [{ name: 'engines.custom-1.apiKey', apiKey: 'local-custom' }] })
    expect(result.engines).toEqual({ 'custom-1': { label: 'Mine', api: 'openai', apiKey: 'local-custom' } })
  })

  test('a standard engine is not copied: its key finds it again', () => {
    const local = { engines: { openai: { baseURL: 'https://local.example.com/v1' } } }
    const result = keep({ engines: {} }, local, { stored: ['engines.openai.apiKey'] })
    expect(result.engines).toEqual({})
  })

  test('a server that exists only here and owns a stored key is kept with its state', () => {
    const local = {
      mcp: { mcpServersExtra: { s1: { state: 'disabled' }, s2: { state: 'disabled' } } },
      mcpServers: { s1: { command: 'npx', args: ['-y', 's1'], env: { MY_APIKEY: '' } }, s2: { command: 'npx', args: ['-y', 's2'] } },
    }
    const result = keep({ mcp: { mcpServersExtra: {} }, mcpServers: {} }, local, { stored: ['mcpServers.s1.env.MY_APIKEY'] })
    expect(result.mcpServers).toEqual({ s1: { command: 'npx', args: ['-y', 's1'], env: { MY_APIKEY: '' } } })
    expect(result.mcp.mcpServersExtra).toEqual({ s1: { state: 'disabled' } })
  })

  test('a key of the local file that sits in a server entry follows the rule of servers', () => {
    const local = { general: { safeKeys: false }, mcpServers: { s1: { command: 'npx', args: ['-y', 's1'], env: { MY_APIKEY: 'local-env' } } } }
    const localKeys = [{ name: 'mcpServers.s1.env.MY_APIKEY', apiKey: 'local-env' }]
    const same = keep({ mcpServers: { s1: { command: 'npx', args: ['-y', 's1'], env: { MY_APIKEY: '' } } } }, local, { localKeys })
    const other = keep({ mcpServers: { s1: { command: 'npx', args: ['-y', 'evil'], env: { MY_APIKEY: '' } } } }, local, { localKeys })
    expect(same.mcpServers.s1.env).toEqual({ MY_APIKEY: 'local-env' })
    expect(other.mcpServers.s1.env).toEqual({ MY_APIKEY: '' })
  })

  test('the OAuth configuration kept apart from a server follows that server', () => {
    const local = {
      mcp: { mcpServersExtra: { s1: { state: 'enabled', oauth: { tokens: { access_token: 'local-access' }, clientId: 'c1', clientSecret: 'local-secret' } } } },
      mcpServers: { s1: { command: 'npx', args: ['-y', 's1'] } },
    }
    const extra = { s1: { state: 'enabled', oauth: { clientId: 'c1', clientSecret: '' } } }
    const same = keep({ mcp: { mcpServersExtra: extra }, mcpServers: { s1: { command: 'npx', args: ['-y', 's1'] } } }, local)
    const other = keep({ mcp: { mcpServersExtra: extra }, mcpServers: { s1: { command: 'npx', args: ['-y', 'evil'] } } }, local)
    expect(same.mcp.mcpServersExtra.s1.oauth).toEqual({ tokens: { access_token: 'local-access' }, clientId: 'c1', clientSecret: 'local-secret' })
    expect(other.mcp.mcpServersExtra.s1.oauth).toEqual({ clientId: 'c1', clientSecret: '' })
  })

  test('the settings of the backup with their own secrets on a computer that has none', () => {
    const result = keep(settingsWithSecrets(), {})
    expectNoCanary(result)
    expect(result.general.safeKeys).toBe(true)
    expect(result.engines.openai.model).toEqual({ chat: 'gpt-x' })
  })

})
