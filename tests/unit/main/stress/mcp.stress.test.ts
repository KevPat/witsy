
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import Mcp from '@main/mcp'
import { Configuration } from '@/types/config'
import { McpServer } from '@/types/mcp'
import { bug, isPosix } from './bug'

vi.mock('electron', async () => {
  return {
    app: {
      getPath: () => './tests/fixtures',
      getLocale: () => 'en-US'
    },
    shell: {
      openExternal: vi.fn(),
    },
  }
})

vi.mock('@main/i18n', () => ({
  useI18n: vi.fn(() => (key: string) => key)
}))

vi.mock('@main/windows', () => ({
  emitIpcEventToAll: vi.fn(),
}))

vi.mock('@main/http_server', () => ({
  HttpServer: {
    getInstance: vi.fn(() => ({
      register: vi.fn(),
      unregister: vi.fn(),
      ensureServerRunning: vi.fn(() => Promise.resolve()),
      getBaseUrl: vi.fn(() => 'http://localhost:8090'),
    }))
  }
}))

// installer process double: tests drive it through `installer`
type FakeChild = EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill: () => void }
let installer: FakeChild | null = null
const execCalls: string[] = []
vi.mock('child_process', async () => {
  return { default: {
    exec: vi.fn((cmd: string) => {
      execCalls.push(cmd)
      const child = new EventEmitter() as FakeChild
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      installer = child
      return child
    })
  }}
})

let config: Configuration

vi.mock('@main/config', async () => {
  return {
    settingsFilePath: vi.fn(() => './tests/fixtures/config1.json'),
    saveSettings: vi.fn((_, cfg) => config = JSON.parse(JSON.stringify(cfg))),
    loadSettings: vi.fn(() => JSON.parse(JSON.stringify(config)))
  }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const StdioClientTransport = vi.fn()
  StdioClientTransport.prototype.start = vi.fn()
  StdioClientTransport.prototype.close = vi.fn()
  StdioClientTransport.prototype.send = vi.fn()
  return { StdioClientTransport, getDefaultEnvironment: vi.fn(() => ({ PATH: '/tmp' })) }
})

vi.mock('@modelcontextprotocol/sdk/client/sse.js', async () => {
  const SSEClientTransport = vi.fn(function(this: any, url: URL, options: any) {
    this.options = options
  })
  return { SSEClientTransport }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async () => {
  const StreamableHTTPClientTransport = vi.fn(function(this: any, url: URL, options: any) {
    this.options = options
  })
  return { StreamableHTTPClientTransport }
})

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async () => {
  return { UnauthorizedError: class extends Error {} }
})

// every server exposes the tools listed in toolsByUrl for its url (default: none)
const toolsByUrl: Record<string, string[]> = {}
let openClients = 0
vi.mock('@modelcontextprotocol/sdk/client/index.js', async () => {
  const Client = vi.fn(function(this: any) {
    this.url = null
    this.closed = false
  })
  Client.prototype.connect = vi.fn(async function(this: any, transport: any) {
    this.transport = transport
    this.url = transport?.url ?? null
    openClients++
  })
  Client.prototype.close = vi.fn(async function(this: any) {
    if (!this.closed) {
      this.closed = true
      openClients--
    }
  })
  Client.prototype.listTools = vi.fn(async function(this: any) {
    const names = toolsByUrl[this.transport?.serverKey] ?? ['tool1']
    return { tools: names.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }
  })
  Client.prototype.callTool = vi.fn(async function(this: any, params: any) {
    return { content: [{ type: 'text', text: `${this.transport?.serverKey}:${params.name}` }] }
  })
  return { Client }
})

const stdioServer = (uuid: string, url: string = 'script.js'): McpServer => ({
  uuid, registryId: uuid, state: 'enabled', type: 'stdio', command: 'node', url, toolSelection: null,
} as McpServer)

const baseConfig = (servers: McpServer[] = [], mcpServers: Record<string, any> = {}): Configuration => ({
  mcp: { servers, mcpServersExtra: {} },
  mcpServers,
} as unknown as Configuration)

// tags each stdio transport with the server it was created for (args[0]) so that the Client double can serve per-server tools
const tagTransports = () => {
  vi.mocked(StdioClientTransport).mockImplementation(function(this: any, params: any) {
    this.params = params
    // on Windows a stdio server is started through cmd /C "<command> <url>"
    this.serverKey = params.command === 'cmd' ? String(params.args?.[1] ?? '').split(' ').pop() : params.args?.[0]
  } as any)
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  installer = null
  execCalls.length = 0
  openClients = 0
  for (const key of Object.keys(toolsByUrl)) delete toolsByUrl[key]
  config = baseConfig()
  tagTransports()
})

describe('stdio command line', () => {

  test.runIf(isPosix)('unquoted arguments are split on whitespace', async () => {
    config = baseConfig([stdioServer('s1', '-y   @scope/pkg --flag=value  /tmp/dir')])
    const mcp = new Mcp(app)
    await mcp.connect()
    expect(StdioClientTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      command: 'node',
      args: ['-y', '@scope/pkg', '--flag=value', '/tmp/dir'],
    }))
  })

  bug.runIf(isPosix)('quoted arguments are passed without their quotes', async () => {
    // spawn does not go through a shell, so the server receives the literal quote characters
    config = baseConfig([stdioServer('s1', `-y pkg "/Users/me/My Documents" 'two words'`)])
    const mcp = new Mcp(app)
    await mcp.connect()
    expect(StdioClientTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      args: ['-y', 'pkg', '/Users/me/My Documents', 'two words'],
    }))
  })

  bug.runIf(isPosix)('mcpServers arguments containing spaces survive the round trip', async () => {
    config = baseConfig([], { fs: { command: 'npx', args: ['-y', 'server-filesystem', '/Users/me/My Documents'] } })
    const mcp = new Mcp(app)
    await mcp.connect()
    expect(StdioClientTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      args: ['-y', 'server-filesystem', '/Users/me/My Documents'],
    }))
  })

  bug('an mcpServers entry without args does not break the server list', () => {
    // "args" is optional in the common mcpServers format
    config = baseConfig([stdioServer('s1')], { bare: { command: 'my-mcp-server' } })
    const mcp = new Mcp(app)
    expect(() => mcp.getServers()).not.toThrow()
    expect(mcp.getServers().map(s => s.uuid)).toEqual(['s1', 'bare'])
  })

})

describe('http servers with OAuth', () => {

  bug('a server with client credentials but no tokens yet can connect', async () => {
    // connectToStreamableHttpServer reads server.oauth.tokens.scope without a guard (the SSE variant has one)
    config = baseConfig([{
      uuid: 'h1', registryId: 'h1', state: 'enabled', type: 'http', url: 'http://localhost:3002',
      oauth: { clientId: 'id', clientSecret: 'secret' }, toolSelection: null,
    } as McpServer])
    const mcp = new Mcp(app)
    await mcp.connect()
    expect(mcp.clients).toHaveLength(1)
    expect(mcp.logs['h1'].join('\n')).not.toContain('Cannot read properties of undefined')
  })

  test('the same configuration over SSE connects', async () => {
    config = baseConfig([{
      uuid: 'e1', registryId: 'e1', state: 'enabled', type: 'sse', url: 'http://localhost:3002',
      oauth: { clientId: 'id', clientSecret: 'secret' }, toolSelection: null,
    } as McpServer])
    const mcp = new Mcp(app)
    await mcp.connect()
    expect(mcp.clients).toHaveLength(1)
  })

})

describe('installServer', () => {

  // number of shell control operators that sit outside quotes
  const unquotedOperators = (command: string): number => {
    let count = 0
    let quote: string | null = null
    for (let i = 0; i < command.length; i++) {
      const c = command[i]
      if (quote) {
        if (c === quote) quote = null
        else if (quote === '"' && (c === '`' || (c === '$' && command[i + 1] === '('))) count++
      } else if (c === '"' || c === '\'') {
        quote = c
      } else if (';&|`<>\n'.includes(c) || (c === '$' && command[i + 1] === '(')) {
        count++
      }
    }
    return count
  }

  test('resolves with success when the installer reports success', async () => {
    const mcp = new Mcp(app)
    const pending = mcp.installServer('smithery', 'server', '')
    await settle()
    installer!.stdout.emit('data', Buffer.from('server successfully installed'))
    expect(await pending).toBe('success')
  })

  test('maps known installer messages to a status', async () => {
    const mcp = new Mcp(app)
    let pending = mcp.installServer('smithery', 'server', '')
    await settle()
    installer!.stderr.emit('data', Buffer.from('Server not found'))
    expect(await pending).toBe('not_found')
    pending = mcp.installServer('smithery', 'server', '')
    await settle()
    installer!.stdout.emit('data', Buffer.from('Please enter your Smithery API key'))
    expect(await pending).toBe('api_key_missing')
  })

  bug('settles when the installer exits without printing a known message', async () => {
    // e.g. npx failing because the network is down: no handler for exit/close
    const mcp = new Mcp(app)
    let status: string = 'pending'
    mcp.installServer('smithery', 'server', '').then((s) => status = s)
    await settle()
    installer!.stderr.emit('data', Buffer.from('npm error code ENOTFOUND'))
    installer!.emit('exit', 1, null)
    installer!.emit('close', 1, null)
    await settle()
    expect(status).not.toBe('pending')
  })

  bug.each([
    ['server; echo INJECTED', ''],
    ['server && echo INJECTED', ''],
    ['$(echo INJECTED)', ''],
    ['server', 'key`echo INJECTED`'],
    ['server', 'key | echo INJECTED'],
  ])('server name and API key cannot add shell operators to the install command: %s %s', (server, apiKey) => {
    // the command line is handed to child_process.exec, i.e. to a shell
    const mcp = new Mcp(app)
    expect(unquotedOperators(mcp.getInstallCommand('smithery', server, apiKey)!)).toBe(0)
  })

})

describe('tool name collisions', () => {

  const connectWith = async (tools: Record<string, string[]>): Promise<Mcp> => {
    const servers = Object.keys(tools).map((key) => stdioServer(key, key))
    Object.assign(toolsByUrl, tools)
    config = baseConfig(servers)
    const mcp = new Mcp(app)
    await mcp.connect()
    return mcp
  }

  test('fuzz: mapped tool names are unique, at most 64 characters, and route to the right server', async () => {
    let seed = 1234
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let round = 0; round < 25; round++) {
      const pool = ['search', 'fetch', 'read_file', 'list', 'run', 'query', 'get', 'search_1', 'fetch_2']
      const tools: Record<string, string[]> = {}
      const serverCount = 2 + Math.floor(rand() * 5)
      for (let s = 0; s < serverCount; s++) {
        const picked = pool.filter(() => rand() < 0.5)
        tools[`srv${round}_${s}`] = picked.length ? picked : ['search']
      }
      const mcp = await connectWith(tools)
      const all = mcp.clients.flatMap(c => c.tools)
      expect(new Set(all).size, JSON.stringify(tools)).toBe(all.length)
      expect(all.every(name => name.length <= 64)).toBe(true)
      for (const client of mcp.clients) {
        for (let i = 0; i < client.tools.length; i++) {
          const result = await mcp.callTool(client.tools[i], {})
          expect(result.content[0].text).toBe(`${client.server.uuid}:${tools[client.server.uuid][i]}`)
        }
      }
      await mcp.shutdown()
    }
  })

  test('three servers exposing the same 64 character tool name get three distinct names', async () => {
    // the suffix search tests the untruncated candidate, the stored name is truncated
    const long = 'a'.repeat(64)
    const mcp = await connectWith({ one: [long], two: [long], three: [long] })
    const all = mcp.clients.flatMap(c => c.tools)
    expect(all).toHaveLength(3)
    expect(new Set(all).size).toBe(3)
  })

  test('a tool whose name ends with three underscores and four characters keeps its name', async () => {
    // LEGACY_SUFFIX_PATTERN strips "___xxxx" from any name, legacy or not
    const mcp = await connectWith({ one: ['fetch___data'] })
    expect(mcp.originalToolName('fetch___data')).toBe('fetch___data')
    const result = await mcp.callTool('fetch___data', {})
    expect(result.content[0].text).toBe('one:fetch___data')
  })

})

describe('lifecycle', () => {

  test('stress: sequential reloads do not leak clients', async () => {
    config = baseConfig([stdioServer('a', 'a'), stdioServer('b', 'b'), stdioServer('c', 'c')])
    const mcp = new Mcp(app)
    await mcp.connect()
    for (let i = 0; i < 50; i++) {
      await mcp.reload()
    }
    expect(mcp.clients).toHaveLength(3)
    expect(openClients).toBe(3)
  })

  test('concurrent reloads do not create duplicate clients', async () => {
    // reload() is fired without await from the settings file monitor and has no mutex
    config = baseConfig([stdioServer('a', 'a'), stdioServer('b', 'b'), stdioServer('c', 'c')])
    const mcp = new Mcp(app)
    await mcp.connect()
    await Promise.all([mcp.reload(), mcp.reload(), mcp.reload()])
    expect(mcp.clients.map(c => c.server.uuid).sort()).toEqual(['a', 'b', 'c'])
    expect(openClients).toBe(3)
  })

  test('concurrent restarts of one server keep a single client for it', async () => {
    config = baseConfig([stdioServer('a', 'a')])
    const mcp = new Mcp(app)
    await mcp.connect()
    vi.useFakeTimers()
    const restarts = Promise.all(Array.from({ length: 10 }, () => mcp.restartServer('a')))
    await vi.runAllTimersAsync()
    await restarts
    vi.useRealTimers()
    expect(mcp.clients).toHaveLength(1)
    expect(openClients).toBe(1)
  })

  test('a server whose first tools/list call failed is asked again later', async () => {
    // the failure is cached as { tools: null, timestamp: 0 } and the null check runs before the expiry check
    config = baseConfig([stdioServer('a', 'a')])
    vi.mocked(Client.prototype.listTools).mockRejectedValueOnce(new Error('temporarily unavailable'))
    const mcp = new Mcp(app)
    await mcp.connect()
    // not at once (a server that hangs must not slow every prompt down), but after a short while
    expect(await mcp.getLlmTools()).toHaveLength(0)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31000)
    try {
      expect((await mcp.getLlmTools()).map(t => t.name)).toEqual(['tool1'])
      // and its tools can be called from then on
      expect(mcp.clients[0].tools).toEqual(['tool1'])
    } finally {
      clock.mockRestore()
    }
  })

  test('editing one server does not make the next unrelated settings change reload every server', async () => {
    // editServer saves the settings but leaves currentConfig stale
    config = baseConfig([stdioServer('a', 'a'), stdioServer('b', 'b')])
    const mcp = new Mcp(app)
    await mcp.connect()
    await mcp.editServer({ ...stdioServer('a', 'a'), label: 'renamed' })
    const reload = vi.fn()
    mcp.reload = reload
    // what the settings monitor does when settings.json changes for any reason
    ;(mcp.monitor as any).callback()
    expect(reload).not.toHaveBeenCalled()
    mcp.monitor?.stop()
  })

  test('shutdown closes every client', async () => {
    config = baseConfig([stdioServer('a', 'a'), stdioServer('b', 'b')])
    const mcp = new Mcp(app)
    await mcp.connect()
    await mcp.shutdown()
    expect(mcp.clients).toHaveLength(0)
    expect(openClients).toBe(0)
    mcp.monitor?.stop()
  })

  test('shutdown closes the remaining clients when one of them fails to close', async () => {
    config = baseConfig([stdioServer('a', 'a'), stdioServer('b', 'b')])
    const mcp = new Mcp(app)
    await mcp.connect()
    vi.mocked(Client.prototype.close).mockRejectedValueOnce(new Error('already closed'))
    await mcp.shutdown().catch(() => {})
    expect(mcp.clients).toHaveLength(0)
    mcp.monitor?.stop()
  })

})
