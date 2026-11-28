import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as portfinder from 'portfinder'
import { installApiEndpoints } from '@main/http_api'
import { HttpServer } from '@main/http_server'
import LlmFactory from '@services/llms/llm'
import AssistantApi from '@main/assistant_api'
import * as config from '@main/config'
import { saveHistory } from '@main/history'
import { kDefaultHttpPort } from '@/consts'
import { state as cliState } from '@/cli/state'
import { bug } from './bug'

// The API server listens on loopback and enableHttpEndpoints defaults to true. These tests drive the
// real HttpServer request listener (captured from a mocked createServer, so no socket is opened) with
// the real API handlers installed on it and inert req/res objects: the Origin, Host and Sec-Fetch-Site
// guard lives in the listener, in front of every handler. The assistant is mocked, so nothing reaches
// a model or the filesystem.

vi.mock('portfinder', () => ({
  default: { getPortPromise: vi.fn(async () => 8090) },
  getPortPromise: vi.fn(async () => 8090),
}))

vi.mock('@main/config')
vi.mock('@main/assistant_api')
vi.mock('@main/history', () => ({
  loadHistory: vi.fn(async () => ({ chats: [] })),
  saveHistory: vi.fn(),
}))
vi.mock('@services/llms/llm', () => ({
  default: { manager: vi.fn() },
}))

type Handler = (req: any, res: any, url?: URL) => Promise<void> | void

const mockApp = { getPath: vi.fn(() => '/mock/userdata') } as any

let listener: (req: any, res: any) => void
let pending: Promise<unknown>[]
let assistantInstance: any

const enabledSettings = () => ({
  general: { enableHttpEndpoints: true },
  llm: { engine: 'openai' },
  engines: { openai: { model: { chat: 'gpt-4' }, models: { chat: [] } } },
  workspaceId: 'w',
})

const response = () => {
  const res: any = { statusCode: 0, headers: {}, body: '', headersSent: false }
  res.writeHead = vi.fn((status: number, headers?: any) => { res.statusCode = status; if (headers) res.headers = headers; res.headersSent = true })
  res.write = vi.fn((chunk: any) => { res.body += String(chunk) })
  res.end = vi.fn((chunk?: any) => { if (chunk) res.body += String(chunk) })
  return res
}

const request = (method: string, headers: Record<string, string>, body?: string, chunks?: string[]) => {
  const req: any = { method, headers }
  req.on = (event: string, cb: (arg?: any) => void) => {
    if (event === 'data' && body !== undefined) (chunks ?? [body]).forEach((c) => cb(Buffer.from(c)))
    if (event === 'end') cb()
    return req
  }
  return req
}

// sends the request through the real request listener and waits for the handler it reached;
// a Host header is added as any HTTP/1.1 client does, unless the test sets its own
const call = async (path: string, req: any, url: URL) => {
  const res = response()
  req.url = url.pathname + url.search
  req.headers = { host: 'localhost:8090', ...req.headers }
  listener(req, res)
  await Promise.all(pending.splice(0))
  return res
}

const complete = async (headers: Record<string, string>, payload: object) => {
  const body = JSON.stringify(payload)
  return call('/api/complete', request('POST', { 'content-type': 'application/json', ...headers }, body), new URL('http://localhost:8090/api/complete'))
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  vi.mocked(config.loadSettings).mockReturnValue(enabledSettings() as any)
  vi.mocked(LlmFactory.manager).mockReturnValue({
    getChatEngines: vi.fn(() => ['openai']),
    isEngineConfigured: vi.fn(() => true),
    getChatModels: vi.fn(() => [{ id: 'gpt-4', name: 'GPT-4' }]),
  } as any)

  assistantInstance = {
    initializeChat: vi.fn(),
    addMessages: vi.fn(),
    prompt: vi.fn(async () => {}),
    getLastMessage: vi.fn(() => ({ content: 'ok', usage: {} })),
  }
  vi.mocked(AssistantApi).mockImplementation(() => assistantInstance)

  // @ts-expect-error resetting the singleton
  HttpServer.instance = null
  const createServer = vi.fn((l: any) => {
    listener = l
    return { listen: vi.fn((port: number, host: string, cb: () => void) => cb()), on: vi.fn(), close: vi.fn() }
  })
  const server = HttpServer.getInstance(createServer as any)

  // register the real handlers on the real server, remembering each invocation so tests can await it
  pending = []
  const recording = {
    register: (route: string, handler: Handler, options?: any) => server.register(route, (req, res, url) => {
      const done = Promise.resolve(handler(req, res, url))
      pending.push(done)
      return done
    }, options),
  }
  installApiEndpoints(recording as any, mockApp, {} as any, {} as any)
  await server.ensureServerRunning(8090)
})

afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error resetting the singleton
  HttpServer.instance = null
})

describe('/api/complete: authentication, Origin and Host', () => {

  const validBody = { stream: 'false', thread: [{ role: 'user', content: 'Hello' }] }

  test('a request with a foreign Origin header does not reach the assistant', async () => {
    const res = await complete({ origin: 'https://evil.example' }, validBody)
    expect(res.statusCode).toBe(403)
    expect(AssistantApi).not.toHaveBeenCalled()
  })

  test('a request with a non-loopback Host header (DNS rebinding) does not reach the assistant', async () => {
    const res = await complete({ host: 'evil.example' }, validBody)
    expect(res.statusCode).toBe(403)
    expect(AssistantApi).not.toHaveBeenCalled()
  })

  test('a cross-origin request cannot obtain read-write filesystem access through workDir', async () => {
    const res = await complete({ origin: 'https://evil.example' }, { ...validBody, workDir: { path: '/', access: 'rw' } })
    expect(res.statusCode).toBe(403)
    expect(AssistantApi).not.toHaveBeenCalled()
  })

  test('a client-supplied read-write workDir is refused without the API token', async () => {
    // whatever path/access the body carries would reach CliPlugin: only a caller that can read the token file gets it
    const res = await complete({}, { ...validBody, workDir: { path: '/', access: 'rw' } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('API token')
    expect(AssistantApi).not.toHaveBeenCalled()
  })

  // Per the Fetch standard a Content-Type whose MIME essence is text/plain is CORS-safelisted, so a
  // cross-site fetch(..., { mode: 'no-cors' }) sends it WITHOUT a preflight. A substring match on
  // 'application/json' accepts these values while their essence is text/plain.
  const kSafelisted = [
    'text/plain;application/json',
    'text/plain; charset=application/json',
    'text/plain; x=application/json',
  ]

  test.each(kSafelisted)('a no-preflight body sent as "%s" is not parsed as JSON', async (contentType) => {
    // (no Origin header and no workDir on purpose: this isolates the content-type parsing from the other checks)
    const req = request('POST', { 'content-type': contentType }, JSON.stringify(validBody))
    const res = await call('/api/complete', req, new URL('http://localhost:8090/api/complete'))
    expect(res.statusCode).toBe(415)
    expect(AssistantApi).not.toHaveBeenCalled()
  })

  test('a genuine application/json body is parsed', async () => {
    // the legitimate CLI request shape must keep working after a fix
    const res = await complete({}, validBody)
    expect(res.statusCode).toBe(200)
    expect(assistantInstance.prompt).toHaveBeenCalledTimes(1)
  })

})

describe('endpoints that change state require POST', () => {

  // a GET needs no preflight and browsers exist that send neither Origin nor Sec-Fetch-Site with it
  test('a GET cannot save a chat to the history', async () => {
    const res = await call('/api/conversations', request('GET', {}), new URL('http://localhost:8090/api/conversations?chat=injected'))
    expect(res.statusCode).toBe(405)
    expect(res.headers.Allow).toBe('POST')
    expect(saveHistory).not.toHaveBeenCalled()
  })

  test('a POST saves the chat', async () => {
    const body = JSON.stringify({ chat: { uuid: '', title: 'CLI Session', messages: [] } })
    const res = await call('/api/conversations', request('POST', { 'content-type': 'application/json' }, body), new URL('http://localhost:8090/api/conversations'))
    expect(res.statusCode).toBe(200)
    expect(saveHistory).toHaveBeenCalledTimes(1)
  })

  test('a GET cannot run a completion', async () => {
    const res = await call('/api/complete', request('GET', {}), new URL('http://localhost:8090/api/complete?thread=x'))
    expect(res.statusCode).toBe(405)
    expect(res.headers.Allow).toBe('POST')
    expect(AssistantApi).not.toHaveBeenCalled()
  })

})

describe('the enableHttpEndpoints gate', () => {

  const gated: [string, URL][] = [
    ['/api/engines', new URL('http://localhost:8090/api/engines')],
    ['/api/models/*', new URL('http://localhost:8090/api/models/openai')],
    ['/api/complete', new URL('http://localhost:8090/api/complete')],
    ['/api/conversations', new URL('http://localhost:8090/api/conversations')],
  ]

  test.each(gated)('%s answers 404 when endpoints are disabled', async (path, url) => {
    vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: false } } as any)
    const res = await call(path, request('POST', { 'content-type': 'application/json' }, '{}'), url)
    expect(res.statusCode).toBe(404)
    expect(AssistantApi).not.toHaveBeenCalled()
  })

  test('/api/cli/config stays readable when endpoints are disabled (by design)', async () => {
    vi.mocked(config.loadSettings).mockReturnValue({
      general: { enableHttpEndpoints: false }, llm: { engine: 'openai' }, engines: { openai: { model: { chat: 'gpt-4' } } },
    } as any)
    const res = await call('/api/cli/config', request('GET', {}), new URL('http://localhost:8090/api/cli/config'))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).enableHttpEndpoints).toBe(false)
  })

})

describe('malformed and oversized POST bodies answer 4xx without throwing', () => {

  const bad: [string, string][] = [
    ['not json at all', 'this is not json'],
    ['a truncated object', '{"thread":'],
    ['a thread that is not an array', '{"thread":123}'],
    ['a top-level array', '[1,2,3]'],
    ['an empty object', '{}'],
    ['a one megabyte invalid blob', 'a'.repeat(1024 * 1024)],
    ['a deeply nested array', '['.repeat(5000) + ']'.repeat(5000)],
    ['a lone null byte', '\u0000'],
  ]

  test.each(bad)('/api/complete with %s', async (_, body) => {
    const res = await call('/api/complete', request('POST', { 'content-type': 'application/json' }, body), new URL('http://localhost:8090/api/complete'))
    expect(res.end).toHaveBeenCalled()
    expect(AssistantApi).not.toHaveBeenCalled()
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })

  test.each(bad)('/api/conversations with %s', async (_, body) => {
    const res = await call('/api/conversations', request('POST', { 'content-type': 'application/json' }, body), new URL('http://localhost:8090/api/conversations'))
    expect(res.end).toHaveBeenCalled()
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })

  test('a body split across many data chunks is still handled', async () => {
    const chunks = ['{"thr', 'ead":', '"nope"}']
    const res = await call('/api/complete', request('POST', { 'content-type': 'application/json' }, chunks.join(''), chunks), new URL('http://localhost:8090/api/complete'))
    expect(res.statusCode).toBe(400)
  })

})

describe('server port fallback vs the port clients assume', () => {

  let servers: any[]

  const newServer = (): HttpServer => {
    // @ts-expect-error resetting the singleton
    HttpServer.instance = null
    servers = []
    const createServer = vi.fn(() => {
      const server = { listen: vi.fn((port: number, host: string, cb: () => void) => cb()), on: vi.fn(), close: vi.fn() }
      servers.push(server)
      return server
    })
    return HttpServer.getInstance(createServer as any)
  }

  test('portfinder is asked for the configured port and its answer is used as is', async () => {
    const server = newServer()
    await server.ensureServerRunning(kDefaultHttpPort)
    expect(portfinder.getPortPromise).toHaveBeenCalledWith({ port: kDefaultHttpPort })
    expect(servers[0].listen).toHaveBeenCalledWith(kDefaultHttpPort, '127.0.0.1', expect.any(Function))
    expect(server.getPort()).toBe(kDefaultHttpPort)
  })

  bug('after a port fallback the port the CLI defaults to is still the port the server is on', async () => {
    // fails today: portfinder silently moves the server when the port is taken and nothing tells the CLI,
    // whose state.port stays at kDefaultHttpPort (the user has to find the new port and pass --port)
    vi.mocked(portfinder.getPortPromise).mockResolvedValueOnce(8099 as any)
    const server = newServer()
    await server.ensureServerRunning(kDefaultHttpPort)
    expect(cliState.port).toBe(server.getPort())
  })

})
