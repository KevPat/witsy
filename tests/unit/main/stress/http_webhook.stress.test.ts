import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installAgentWebhook } from '@main/agent_webhook'
import { generateWebhookToken } from '@main/agent_utils'
import { HttpServer } from '@main/http_server'
import { getAgentRun, listAgents } from '@main/agents'
import { listWorkspaces } from '@main/workspace'
import * as config from '@main/config'
import Agent from '@models/agent'
import { bug } from './bug'

// The agent webhook lets anything that knows an 8-character token start an agent. These tests drive
// the real HttpServer request listener (captured from a mocked createServer, so no socket is opened)
// with the real webhook handlers installed on it. The agent executor is mocked: no agent or model runs.

const mockRunAgent = vi.hoisted(() => vi.fn())

vi.mock('portfinder', () => ({
  default: { getPortPromise: vi.fn(async () => 8090) },
  getPortPromise: vi.fn(async () => 8090),
}))

vi.mock('@main/config', () => ({ loadSettings: vi.fn() }))
vi.mock('@main/agents', () => ({ listAgents: vi.fn(), getAgentRun: vi.fn() }))
vi.mock('@main/workspace', () => ({ listWorkspaces: vi.fn() }))

vi.mock('@main/agent_utils', async () => {
  const actual = await vi.importActual<any>('@main/agent_utils')
  return {
    ...actual,
    AgentExecutor: vi.fn(() => ({ runAgent: mockRunAgent })),
  }
})

const kToken = 'tok12345'
const mockApp = {} as any

let listener: (req: any, res: any) => void
let pending: Promise<unknown>[]

const response = () => {
  const res: any = { statusCode: 0, body: '', headersSent: false }
  res.writeHead = vi.fn((status: number) => { res.statusCode = status; res.headersSent = true })
  res.write = vi.fn((chunk: any) => { res.body += String(chunk) })
  res.end = vi.fn((chunk?: any) => { if (chunk) res.body += String(chunk) })
  return res
}

// sends a request through the real request listener and waits for the webhook handler it reached;
// a Host header is added as any HTTP/1.1 client does, unless the test sets its own
const send = async (method: string, url: string, headers: Record<string, string> = {}) => {
  const res = response()
  listener({ url, method, headers: { host: 'localhost:8090', ...headers } }, res)
  await Promise.all(pending.splice(0))
  return res
}

const get = (url: string, headers: Record<string, string> = {}) => send('GET', url, headers)

// small deterministic PRNG so a failing fuzz case can be reproduced from its seed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: true } } as any)
  vi.mocked(listWorkspaces).mockReturnValue([{ uuid: 'w1' }] as any)
  vi.mocked(listAgents).mockReturnValue([
    { uuid: 'no-webhook', webhookToken: null, invocationValues: {} },
    { uuid: 'legacy-without-the-field', invocationValues: {} },
    { uuid: 'a1', webhookToken: kToken, invocationValues: { topic: 'default' } },
  ] as any)
  mockRunAgent.mockResolvedValue({ uuid: 'run-1' })

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
    register: (route: string, handler: (...args: any[]) => any, options?: any) => server.register(route, (req, res, url) => {
      const done = Promise.resolve(handler(req, res, url))
      pending.push(done)
      return done
    }, options),
  }
  installAgentWebhook(recording as any, mockApp, {} as any, {} as any)
  await server.ensureServerRunning(8090)
})

afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error resetting the singleton
  HttpServer.instance = null
})

describe('webhook token generation', () => {

  beforeEach(() => {
    vi.mocked(listAgents).mockReturnValue([])
  })

  bug('tokens do not come from Math.random', () => {
    // fails today: the token is built from Math.random(), so a fixed PRNG yields the same token twice
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const first = generateWebhookToken(mockApp, 'w1', 'agent-1')
    const second = generateWebhookToken(mockApp, 'w1', 'agent-2')
    expect(first).not.toBe(second)
  })

  bug('a token is long enough to carry 128 bits', () => {
    // fails today: 8 characters of [a-z0-9] is about 41 bits; 22 base64url characters is the shortest 128-bit form
    expect(generateWebhookToken(mockApp, 'w1', 'agent-1').length).toBeGreaterThanOrEqual(22)
  })

  test('a token already used by another agent is never handed out', () => {
    // first candidate is 'aaaaaaaa' (taken), the next one is different
    const random = vi.spyOn(Math, 'random')
    for (let i = 0; i < 8; i++) random.mockReturnValueOnce(0)
    random.mockReturnValue(0.5)
    vi.mocked(listAgents).mockReturnValue([{ uuid: 'other', webhookToken: 'aaaaaaaa' }] as any)
    expect(generateWebhookToken(mockApp, 'w1', 'agent-1')).not.toBe('aaaaaaaa')
  })

  bug('duplicating an agent does not give the copy the same webhook token', () => {
    // fails today: Agent.duplicate() copies webhookToken, so two agents answer to one token and the
    // copy's webhook url runs whichever agent is listed first
    // NOTE: tests/unit/models/agent_duplicate.test.ts currently asserts the copy keeps the token
    const original = new Agent()
    original.webhookToken = kToken
    expect(original.duplicate().webhookToken).not.toBe(kToken)
  })

})

describe('webhook run endpoint', () => {

  test('a valid token starts the agent once and answers before the run finishes', async () => {
    mockRunAgent.mockReturnValue(new Promise(() => {}))
    const res = await get(`/api/agent/run/${kToken}?topic=cats`)
    expect(res.statusCode).toBe(200)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(mockRunAgent.mock.calls[0][3]).toEqual({ topic: 'cats' })
    expect(JSON.parse(res.body).runId).toBe(mockRunAgent.mock.calls[0][4])
  })

  bug('a rejected agent run has a rejection handler attached', async () => {
    // fails today: executor.runAgent(...) is neither awaited nor given a .catch, so a failing run is an
    // unhandled promise rejection in the main process while the caller is told success: true
    const run: any = { handled: false }
    const reject = (onRejected: any) => {
      if (typeof onRejected === 'function') { run.handled = true; onRejected(new Error('agent failed')) }
      return run
    }
    run.then = vi.fn((_: any, onRejected: any) => reject(onRejected))
    run.catch = vi.fn((onRejected: any) => reject(onRejected))
    mockRunAgent.mockReturnValue(run)

    await get(`/api/agent/run/${kToken}`)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(run.handled, 'the promise returned by runAgent was dropped without a rejection handler').toBe(true)
  })

  bug('the request log does not contain the webhook token', async () => {
    // fails today: the listener logs `${req.method} ${req.url}` and main.ts routes console.log to the
    // electron-log file, so the only credential of the webhook is written to disk in clear text
    await get(`/api/agent/run/${kToken}?topic=cats`)
    const logged = vi.mocked(console.log).mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).not.toContain(kToken)
  })

  // the token is the authentication of these routes and callers reach them through tunnels or from
  // other services, so the loopback Host, Origin and Sec-Fetch-Site checks of the local API do not apply
  test.each([
    ['a tunnel Host', { host: 'witsy.tunnel.example' }],
    ['an Origin header', { host: 'witsy.tunnel.example', origin: 'https://automation.example' }],
    ['a cross-site fetch', { host: 'localhost:8090', origin: 'https://automation.example', 'sec-fetch-site': 'cross-site' }],
  ])('a valid token starts the agent for a request with %s', async (_, headers) => {
    const res = await get(`/api/agent/run/${kToken}`, headers)
    expect(res.statusCode).toBe(200)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
  })

  test('a wrong token starts nothing whatever the Host', async () => {
    const res = await get('/api/agent/run/tok12346', { host: 'witsy.tunnel.example' })
    expect(res.statusCode).toBe(404)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  test('a preflight starts nothing', async () => {
    const res = await send('OPTIONS', `/api/agent/run/${kToken}`, { host: 'witsy.tunnel.example', origin: 'https://automation.example' })
    expect(res.statusCode).toBe(403)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  test('endpoints disabled: the run endpoint answers 404 and starts nothing', async () => {
    vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: false } } as any)
    const res = await get(`/api/agent/run/${kToken}`)
    expect(res.statusCode).toBe(404)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

})

describe('webhook status endpoint', () => {

  const kRun = { uuid: 'run-1', agentId: 'a1', status: 'success', createdAt: 1, updatedAt: 2, trigger: 'webhook', messages: [{ content: 'private output' }] }

  test('a valid token and run id return the run output', async () => {
    vi.mocked(getAgentRun).mockReturnValue(kRun as any)
    const res = await get(`/api/agent/status/${kToken}/run-1`)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).output).toBe('private output')
    expect(getAgentRun).toHaveBeenCalledWith(mockApp, 'w1', 'a1', 'run-1')
  })

  test('the status is readable through a tunnel Host', async () => {
    vi.mocked(getAgentRun).mockReturnValue(kRun as any)
    const res = await get(`/api/agent/status/${kToken}/run-1`, { host: 'witsy.tunnel.example' })
    expect(res.statusCode).toBe(200)
  })

  bug('endpoints disabled: the status endpoint answers 404 like every other endpoint', async () => {
    // fails today: the status handler is the only /api handler that never calls isHttpEndpointsEnabled
    vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: false } } as any)
    vi.mocked(getAgentRun).mockReturnValue(kRun as any)
    const res = await get(`/api/agent/status/${kToken}/run-1`)
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('private output')
  })

  test.each([
    ['an encoded slash', '..%2F..%2Fsecret'],
    ['encoded dots and slash', '%2e%2e%2fsecret'],
    ['an encoded backslash', '..%5C..%5Csecret'],
    ['a null byte', 'run%00'],
  ])('a run id with %s reaches the run lookup as one undecoded segment', async (_, runId) => {
    // the handler never decodes the segment, so it cannot name a file outside the agent's folder
    await get(`/api/agent/status/${kToken}/${runId}`)
    expect(getAgentRun).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(getAgentRun).mock.calls[0][3]
    expect(passed).toBe(runId)
    expect(passed).not.toMatch(/[/\\\0]/)
  })

  test.each([
    ['dot segments', `/api/agent/status/${kToken}/../../x`],
    ['backslash dot segments', `/api/agent/status/${kToken}/..\\..\\x`],
    ['encoded dot segments', `/api/agent/status/${kToken}/%2e%2e/%2e%2e/x`],
  ])('a path with %s is normalised away from the handler', async (_, url) => {
    const res = await get(url)
    expect(res.statusCode).toBe(404)
    expect(getAgentRun).not.toHaveBeenCalled()
  })

})

describe('webhook path fuzz', () => {

  const kPieces = ['', '/', '//', '..', '.', '%2e%2e', '%2F', '%5C', '\\', '%00', '%', '%zz', '?', '?a=b', '#', ';',
    'null', 'undefined', '__proto__', 'constructor', 'toString', ' ', '\u0000', '\u202e', '\ud83d\ude00',
    'tok1234', 'tok123456', 'TOK12345', 'a'.repeat(500)]

  test('no junk token or run id ever starts an agent, reads a run or leaves a request unanswered', async () => {
    const rand = mulberry32(0xBADC0DE)
    for (let i = 0; i < 400; i++) {
      const count = Math.floor(rand() * 6)
      let tail = ''
      for (let j = 0; j < count; j++) tail += kPieces[Math.floor(rand() * kPieces.length)]
      const url = `/api/agent/${rand() < 0.5 ? 'run' : 'status'}/${tail}`
      const res = await get(url)
      const context = `seed 0xBADC0DE iteration ${i}: ${JSON.stringify(url)}`
      expect(res.end, context).toHaveBeenCalledTimes(1)
      expect(res.statusCode, context).toBe(404)
      expect(mockRunAgent, context).not.toHaveBeenCalled()
      expect(getAgentRun, context).not.toHaveBeenCalled()
    }
  })

})
