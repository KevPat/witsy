
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, shell } from 'electron'
import { HttpServer } from '@main/http_server'
import McpOAuthManager from '@main/mcp_auth'
import { bug } from './bug'

vi.mock('portfinder', () => ({
  default: { getPortPromise: vi.fn(async () => 8090) },
  getPortPromise: vi.fn(async () => 8090),
}))

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US'), getPath: vi.fn(() => '') },
  shell: { openExternal: vi.fn() },
}))

vi.mock('@main/i18n', () => ({
  useI18n: vi.fn(() => (key: string) => key)
}))

vi.mock('@main/config', () => ({
  loadSettings: vi.fn(() => ({ general: {} })),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ UnauthorizedError: class extends Error {} }))

type Listener = (req: IncomingMessage, res: ServerResponse) => void

let listeners: Listener[]
let servers: any[]

const newServer = (): HttpServer => {
  // @ts-expect-error resetting the singleton
  HttpServer.instance = null
  listeners = []
  servers = []
  const createServer = vi.fn((listener: Listener) => {
    listeners.push(listener)
    const server = { listen: vi.fn((port: number, host: string, cb: () => void) => cb()), on: vi.fn(), close: vi.fn() }
    servers.push(server)
    return server
  })
  return HttpServer.getInstance(createServer as any)
}

const response = () => {
  const res: any = { headersSent: false, statusCode: 0, body: '' }
  res.writeHead = vi.fn((status: number) => { res.statusCode = status; res.headersSent = true })
  res.write = vi.fn((chunk: any) => { res.body += chunk.toString() })
  res.end = vi.fn((chunk?: any) => { if (chunk) res.body += chunk.toString() })
  return res
}

const get = (url: string) => {
  const res = response()
  // a local client: the server refuses requests whose Host is not a loopback address
  listeners[0]({ url, method: 'GET', headers: { host: 'localhost:8090' } } as IncomingMessage, res)
  return res
}

describe('local http server', () => {

  let resources: string
  const env = { ...process.env }
  const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

  beforeEach(() => {
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'http-stress-'))
    delete process.env.DEBUG
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...env }
    if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
    else delete (process as any).resourcesPath
    fs.rmSync(resources, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  test('binds to the loopback interface only', async () => {
    const server = newServer()
    await server.ensureServerRunning(8090)
    expect(servers[0].listen).toHaveBeenCalledWith(8090, '127.0.0.1', expect.any(Function))
  })

  test('fuzz: odd request urls always get an answer and never throw', async () => {
    const server = newServer()
    server.register('/exact', (req, res) => { res.writeHead(200); res.end('ok') })
    server.register('/prefix/*', (req, res) => { res.writeHead(200); res.end('ok') })
    server.register('/throws', () => { throw new Error('handler failure') })
    server.register('/rejects', async () => { throw new Error('handler failure') })
    await server.ensureServerRunning(8090)
    const urls = ['/', '', '//', '///x', '/%', '/%zz', '/exact?x=%', '/exact/../exact', '/prefix/', '/prefix/a/b?c=d#e', '/throws', '/rejects',
      'http://evil.example.com/exact', '/\u0000', '/' + 'a'.repeat(20000), '/exact?' + 'a=b&'.repeat(5000), '\\exact', '/EXACT', '*', undefined as unknown as string]
    for (const url of urls) {
      let res: any
      expect(() => res = get(url), String(url).slice(0, 40)).not.toThrow()
      await vi.waitFor(() => expect(res.end, String(url).slice(0, 40)).toHaveBeenCalled())
    }
  })

  bug('the logo request is answered when the icon file is not in the resources folder', async () => {
    // assets/icon.png is not listed in forge extraResource, so this is every packaged build;
    // readFileSync runs outside the try block: the exception escapes the request listener and the request is never answered
    const server = newServer()
    await server.ensureServerRunning(8090)
    let res: any
    expect(() => res = get('/logo.png')).not.toThrow()
    expect(res.end).toHaveBeenCalled()
  })

  bug('concurrent startup requests create a single server', async () => {
    // the "already running" check happens before an await
    const server = newServer()
    await Promise.all([server.ensureServerRunning(8090), server.ensureServerRunning(8090), server.ensureServerRunning(8090)])
    expect(servers).toHaveLength(1)
  })

})

describe('MCP OAuth callback page', () => {

  const callback = (query: string) => {
    newServer()
    const manager = new McpOAuthManager(app)
    const res = response()
    ;(manager as any).handleCallback({}, res, new URL(`http://localhost:8090/mcp/callback?${query}`))
    return res
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('an unknown state with a code is rejected', () => {
    const res = callback('code=abc&state=unknown')
    expect(res.statusCode).toBe(400)
  })

  test.each([
    ['<script>alert(document.domain)</script>'],
    ['<img src=x onerror=alert(1)>'],
    ['</p><iframe src="https://evil.example.com"></iframe>'],
  ])('the error parameter is escaped in the page: %s', (payload) => {
    // any web page can navigate the browser to http://localhost:<port>/mcp/callback?error=...
    const res = callback(`error=${encodeURIComponent(payload)}`)
    expect(res.body).not.toContain(payload)
  })

  test('flow identifiers are not derived from Math.random', async () => {
    // the identifier doubles as the OAuth state parameter, i.e. the CSRF token of the flow
    newServer()
    const manager = new McpOAuthManager(app)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    // the state is now created when the browser is sent to the authorization server (one per request):
    // the stubbed connection asks for that redirect and the state is read from the url the browser gets
    ;(manager as any).attemptConnection = async (provider: any) => {
      provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
    }
    const metadata = { client_name: 'x', redirect_uris: ['http://localhost:8090/mcp/callback'] }
    await HttpServer.getInstance().ensureServerRunning(8090)
    await manager.startOAuthFlow('http', 'https://mcp.example.com', metadata)
    await manager.startOAuthFlow('http', 'https://mcp.example.com', metadata)
    random.mockRestore()
    now.mockRestore()
    const ids = vi.mocked(shell.openExternal).mock.calls.map(([url]) => new URL(url).searchParams.get('state'))
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^[0-9a-f]{32,}$/)
    expect(ids[0]).not.toBe(ids[1])
  })

})
