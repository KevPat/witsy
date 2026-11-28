import { vi, expect, test, describe, beforeEach, afterEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { HttpServer } from '@main/http_server'

// Mock portfinder
vi.mock('portfinder', () => ({
  default: {
    getPortPromise: vi.fn().mockResolvedValue(8090)
  },
  getPortPromise: vi.fn().mockResolvedValue(8090)
}))

let httpServer: HttpServer
let mockServer: any
let requestListener: (req: IncomingMessage, res: ServerResponse) => void

beforeEach(async () => {
  // Reset singleton
  // @ts-expect-error accessing private property for testing
  HttpServer.instance = null

  // Create mock server
  mockServer = {
    listen: vi.fn((port: number, hostname: string, callback: () => void) => {
      callback()
    }),
    on: vi.fn(),
    close: vi.fn()
  }

  // Mock createServer to capture the request listener
  const mockCreateServer = vi.fn((listener: any) => {
    requestListener = listener
    return mockServer
  })

  // Get instance with mocked createServer
  httpServer = HttpServer.getInstance(mockCreateServer as any)
  await httpServer.ensureServerRunning()
})

afterEach(() => {
  // Clean up
  // @ts-expect-error accessing private method for testing
  httpServer.shutdown()
  // @ts-expect-error reset singleton
  HttpServer.instance = null
})

test('routes with exact match take precedence', () => {
  const exactHandler = vi.fn()
  const wildcardHandler = vi.fn()

  httpServer.register('/api/test', exactHandler)
  httpServer.register('/api/*', wildcardHandler)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/api/test'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(exactHandler).toHaveBeenCalled()
  expect(wildcardHandler).not.toHaveBeenCalled()
})

test('wildcard routes match prefixes', () => {
  const handler = vi.fn()

  httpServer.register('/api/agent/run/*', handler)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/api/agent/run/abc12345'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(handler).toHaveBeenCalled()
})

test('wildcard routes match any suffix', () => {
  const handler = vi.fn()

  httpServer.register('/files/*', handler)

  const paths = [
    'http://localhost:8090/files/document.pdf',
    'http://localhost:8090/files/folder/subfolder/file.txt',
    'http://localhost:8090/files/123/456/789'
  ]

  for (const url of paths) {
    const mockReq = { method: 'GET', headers: { host: 'localhost:8090' }, url } as IncomingMessage
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false
    } as any as ServerResponse

    requestListener(mockReq, mockRes)
  }

  expect(handler).toHaveBeenCalledTimes(3)
})

test('returns 404 for unmatched routes', () => {
  httpServer.register('/api/test', vi.fn())

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/api/notfound'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'text/plain' })
  expect(mockRes.end).toHaveBeenCalledWith('Not Found')
})

test('multiple wildcard routes - first match wins', () => {
  const handler1 = vi.fn()
  const handler2 = vi.fn()

  httpServer.register('/api/*', handler1)
  httpServer.register('/api/users/*', handler2)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/api/users/123'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  // First registered wildcard should match
  expect(handler1).toHaveBeenCalled()
  expect(handler2).not.toHaveBeenCalled()
})

test('wildcard at root matches all paths', () => {
  const handler = vi.fn()

  httpServer.register('/*', handler)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/anything/here/works'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(handler).toHaveBeenCalled()
})

test('exact match preferred even when wildcard exists', () => {
  const exactHandler = vi.fn()
  const wildcardHandler = vi.fn()

  httpServer.register('/*', wildcardHandler)
  httpServer.register('/specific', exactHandler)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/specific'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(exactHandler).toHaveBeenCalled()
  expect(wildcardHandler).not.toHaveBeenCalled()
})

test('wildcard does not match if prefix does not match', () => {
  const handler = vi.fn()

  httpServer.register('/api/users/*', handler)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/api/products/123'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(handler).not.toHaveBeenCalled()
  expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'text/plain' })
})

test('handler receives correct parsedUrl for wildcard routes', () => {
  let receivedUrl: URL | undefined

  const handler = vi.fn((req: IncomingMessage, res: ServerResponse, parsedUrl: URL) => {
    receivedUrl = parsedUrl
    res.writeHead(200)
    res.end()
  })

  httpServer.register('/api/agent/run/*', handler)

  const mockReq = {
    method: 'GET',
    headers: { host: 'localhost:8090' },
    url: 'http://localhost:8090/api/agent/run/abc12345?param=value'
  } as IncomingMessage

  const mockRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false
  } as any as ServerResponse

  requestListener(mockReq, mockRes)

  expect(handler).toHaveBeenCalled()
  expect(receivedUrl).toBeDefined()
  expect(receivedUrl?.pathname).toBe('/api/agent/run/abc12345')
  expect(receivedUrl?.searchParams.get('param')).toBe('value')
})

test('throws error when registering duplicate route', () => {
  httpServer.register('/test', vi.fn())

  expect(() => {
    httpServer.register('/test', vi.fn())
  }).toThrow("Path conflict: Route '/test' already registered")
})

test('server binds to localhost only for security', () => {
  // Verify that the server.listen was called with localhost hostname
  expect(mockServer.listen).toHaveBeenCalledWith(
    8090,
    '127.0.0.1',
    expect.any(Function)
  )
})

describe('request guard', () => {

  const send = (url: string, headers: Record<string, string>, method = 'GET') => {
    const res: any = { headersSent: false, statusCode: 0, headers: {}, body: '' }
    res.writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
      res.statusCode = status
      res.headers = headers ?? {}
      res.headersSent = true
    })
    res.end = vi.fn((chunk?: any) => { if (chunk) res.body += String(chunk) })
    requestListener({ method, url, headers } as any as IncomingMessage, res as ServerResponse)
    return res
  }

  const expectRefused = (res: any) => {
    expect(res.statusCode).toBe(403)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(res.body)).toEqual({ success: false, error: expect.any(String) })
    expect(res.end).toHaveBeenCalledTimes(1)
  }

  let handler: ReturnType<typeof vi.fn>
  let warn: ReturnType<typeof vi.spyOn>
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // not vi.restoreAllMocks(): it would also reset the portfinder mock
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    handler = vi.fn((req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end('ok') })
    httpServer.register('/api/test', handler)
  })

  afterEach(() => {
    warn.mockRestore()
    log.mockRestore()
  })

  test.each([
    'localhost',
    'localhost:8090',
    'LocalHost:8090',
    '127.0.0.1',
    '127.0.0.1:8090',
    '[::1]',
    '[::1]:8090',
  ])('accepts the loopback Host %s', (host) => {
    const res = send('/api/test', { host })
    expect(res.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test.each([
    'evil.example',
    'evil.example:8090',
    'localhost.evil.example',
    '127.0.0.1.evil.example:8090',
    'evil.example#localhost',
    'localhost:8090@evil.example',
    'localhost:8090, evil.example',
    'localhost.',
    '127.0.0.2',
    '0.0.0.0:8090',
    '192.168.1.10:8090',
    '::1',
    '',
  ])('refuses the Host %s (dns rebinding)', (host) => {
    expectRefused(send('/api/test', { host }))
    expect(handler).not.toHaveBeenCalled()
  })

  test('refuses a request without Host', () => {
    expectRefused(send('/api/test', {}))
    expect(handler).not.toHaveBeenCalled()
  })

  test.each([
    'https://evil.example',
    'http://localhost:8090',
    'http://localhost:3000',
    'null',
    '',
  ])('refuses a request with the Origin "%s"', (origin) => {
    expectRefused(send('/api/test', { host: 'localhost:8090', origin }, 'POST'))
    expect(handler).not.toHaveBeenCalled()
  })

  test.each(['cross-site', 'same-site', 'Cross-Site'])('refuses a request with Sec-Fetch-Site: %s', (site) => {
    expectRefused(send('/api/test', { host: 'localhost:8090', 'sec-fetch-site': site }))
    expect(handler).not.toHaveBeenCalled()
  })

  test.each(['same-origin', 'none'])('accepts a request with Sec-Fetch-Site: %s', (site) => {
    const res = send('/api/test', { host: 'localhost:8090', 'sec-fetch-site': site })
    expect(res.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('accepts what a local script sends (node fetch, curl)', () => {
    const res = send('/api/test', { host: 'localhost:8090', accept: '*/*', 'sec-fetch-mode': 'cors', 'user-agent': 'node' }, 'POST')
    expect(res.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('refuses a CORS preflight and never sends CORS headers', () => {
    const preflight = {
      host: 'localhost:8090',
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
      'sec-fetch-site': 'cross-site',
    }
    const res = send('/api/test', preflight, 'OPTIONS')
    expectRefused(res)
    expect(Object.keys(res.headers).filter((name) => name.toLowerCase().startsWith('access-control'))).toEqual([])
    expect(handler).not.toHaveBeenCalled()
  })

  test('refuses OPTIONS even on a route that opted out of every check', () => {
    const open = vi.fn()
    httpServer.register('/open/*', open, { allowAnyHost: true, allowOrigin: true, allowCrossSite: true })
    expectRefused(send('/open/x', { host: 'tunnel.example', origin: 'https://evil.example' }, 'OPTIONS'))
    expect(open).not.toHaveBeenCalled()
  })

  test('refuses a web page before telling whether the path exists', () => {
    expectRefused(send('/api/unknown', { host: 'localhost:8090', origin: 'https://evil.example' }))
    expect(send('/api/unknown', { host: 'localhost:8090' }).statusCode).toBe(404)
  })

  test('a route can opt out of each check separately', () => {
    const anyHost = vi.fn()
    const anyOrigin = vi.fn()
    const crossSite = vi.fn()
    httpServer.register('/any-host', anyHost, { allowAnyHost: true })
    httpServer.register('/any-origin', anyOrigin, { allowOrigin: true })
    httpServer.register('/cross-site', crossSite, { allowCrossSite: true })

    send('/any-host', { host: 'tunnel.example' })
    send('/any-host', {})
    expect(anyHost).toHaveBeenCalledTimes(2)
    expectRefused(send('/any-host', { host: 'tunnel.example', origin: 'https://evil.example' }))
    expectRefused(send('/any-host', { host: 'tunnel.example', 'sec-fetch-site': 'cross-site' }))
    expect(anyHost).toHaveBeenCalledTimes(2)

    send('/any-origin', { host: 'localhost:8090', origin: 'https://app.example' })
    expect(anyOrigin).toHaveBeenCalledTimes(1)
    expectRefused(send('/any-origin', { host: 'evil.example', origin: 'https://app.example' }))
    expectRefused(send('/any-origin', { host: 'localhost:8090', origin: 'https://app.example', 'sec-fetch-site': 'cross-site' }))
    expect(anyOrigin).toHaveBeenCalledTimes(1)

    send('/cross-site', { host: 'localhost:8090', 'sec-fetch-site': 'cross-site' })
    expect(crossSite).toHaveBeenCalledTimes(1)
    expectRefused(send('/cross-site', { host: 'evil.example', 'sec-fetch-site': 'cross-site' }))
    expectRefused(send('/cross-site', { host: 'localhost:8090', origin: 'https://evil.example' }))
    expect(crossSite).toHaveBeenCalledTimes(1)
  })

  test('the OAuth callback is reachable by the cross-site redirect of the provider, and by nothing else cross-origin', () => {
    const callback = vi.fn()
    httpServer.register('/mcp/callback', callback)

    const redirect = { host: 'localhost:8090', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    send('/mcp/callback?code=abc&state=xyz', redirect)
    expect(callback).toHaveBeenCalledTimes(1)

    expectRefused(send('/mcp/callback?code=abc&state=xyz', { ...redirect, host: 'evil.example' }))
    expectRefused(send('/mcp/callback?code=abc&state=xyz', { ...redirect, origin: 'https://evil.example' }, 'POST'))
    expect(callback).toHaveBeenCalledTimes(1)
  })

  test('a refused request is logged without its url', () => {
    send('/api/test?text=private', { host: 'evil.example' })
    const logged = [...warn.mock.calls, ...log.mock.calls].map((args) => args.join(' ')).filter((line) => line.includes('refused'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('private')
  })

})

describe('request log', () => {

  let log: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  const send = (url: string) => {
    const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false } as any as ServerResponse
    requestListener({ method: 'GET', url, headers: { host: 'localhost:8090' } } as any as IncomingMessage, res)
    return res
  }

  const logged = () => [...log.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(' ')).join('\n')

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
    error.mockRestore()
  })

  test('logs the route instead of the url, which may hold a token and user text', () => {
    httpServer.register('/api/agent/run/*', vi.fn())
    httpServer.register('/api/chat', vi.fn())

    send('/api/agent/run/secret-token?input=private')
    send('/api/chat?text=private')

    expect(logged()).toContain('[http] GET /api/agent/run/*')
    expect(logged()).toContain('[http] GET /api/chat')
    expect(logged()).not.toContain('secret-token')
    expect(logged()).not.toContain('private')
  })

  test('logs the route of a failing handler without its url', async () => {
    httpServer.register('/api/agent/run/*', vi.fn(async () => { throw new Error('handler failure') }))

    const res = send('/api/agent/run/secret-token?input=private')
    await vi.waitFor(() => expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'text/plain' }))

    expect(logged()).toContain('handler failure')
    expect(logged()).not.toContain('secret-token')
    expect(logged()).not.toContain('private')
  })

  test('logs only the start of a path without route', () => {
    send('/api/agents/run/secret-token?input=private')
    send('/api/unknown')

    expect(logged()).toContain('[http] GET /api/agents/…')
    expect(logged()).toContain('[http] GET /api/unknown')
    expect(logged()).not.toContain('secret-token')
    expect(logged()).not.toContain('private')
  })

})
