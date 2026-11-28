import { vi, test, expect, beforeEach, afterEach, describe } from 'vitest'
import { app, shell } from 'electron'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import McpOAuthManager, { McpOAuthClientProvider } from '@main/mcp_auth'

// Mock Electron
vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en-US'),
    getPath: vi.fn(() => '')
  },
  shell: {
    openExternal: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString())
  }
}))

// Mock node:http
const mockServer = {
  listen: vi.fn(),
  close: vi.fn(),
  on: vi.fn()
}

// Mock HttpServer
const mockHttpServerInstance = {
  port: 8090,
  registerRoute: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  listen: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  ensureServerRunning: vi.fn(() => Promise.resolve()),
  getBaseUrl: vi.fn(() => 'http://localhost:8090')
}

vi.mock('@main/http_server', () => ({
  HttpServer: {
    getInstance: vi.fn(() => mockHttpServerInstance)
  }
}))

// Mock portfinder
vi.mock('portfinder', () => ({
  default: {
    getPortPromise: vi.fn(() => Promise.resolve(8090))
  },
  getPortPromise: vi.fn(() => Promise.resolve(8090))
}))

vi.mock('@main/i18n', () => ({
  useI18n: vi.fn(() => (key: string) => key)
}))

// Mock MCP SDK
const mockClient = {
  connect: vi.fn(),
  close: vi.fn()
}

const mockTransport = {
  finishAuth: vi.fn(),
  start: vi.fn(),
  send: vi.fn()
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => mockClient)
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => mockTransport)
}))

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  UnauthorizedError: class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
}))

vi.mock('@modelcontextprotocol/sdk/shared/auth.js', () => ({
  OAuthClientInformation: {},
  OAuthClientInformationFull: {},
  OAuthClientMetadata: {},
  OAuthTokens: {}
}))

describe('McpOAuthClientProvider', () => {
  let provider: McpOAuthClientProvider
  let mockOnRedirect: ReturnType<typeof vi.fn>
  let mockOnTokensUpdated: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockOnRedirect = vi.fn()
    mockOnTokensUpdated = vi.fn()
    provider = new McpOAuthClientProvider(
      'http://localhost:8090/callback',
      {
        client_name: 'Test Client',
        redirect_uris: ['http://localhost:8090/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code']
      },
      mockOnRedirect,
      mockOnTokensUpdated
    )
  })

  test('constructor initializes properties correctly', () => {
    expect(provider.redirectUrl).toBe('http://localhost:8090/callback')
    expect(provider.clientMetadata).toEqual({
      client_name: 'Test Client',
      redirect_uris: ['http://localhost:8090/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    })
  })

  test('clientInformation returns undefined initially', () => {
    expect(provider.clientInformation()).toBeUndefined()
  })

  test('saveClientInformation stores client info', () => {
    const clientInfo = {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8090/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Test Client'
    }
    
    provider.saveClientInformation(clientInfo)
    expect(provider.clientInformation()).toEqual(clientInfo)
  })

  test('tokens returns undefined initially', () => {
    expect(provider.tokens()).toBeUndefined()
  })

  test('saveTokens stores tokens and calls callback', () => {
    const tokens = {
      access_token: 'test-access-token',
      token_type: 'bearer',
      refresh_token: 'test-refresh-token'
    }
    
    provider.saveTokens(tokens)
    expect(provider.tokens()).toEqual(tokens)
    expect(mockOnTokensUpdated).toHaveBeenCalledWith(tokens, '')
  })

  test('redirectToAuthorization calls redirect callback', () => {
    const authUrl = new URL('https://auth.example.com/oauth/authorize?client_id=test')
    provider.redirectToAuthorization(authUrl)
    expect(mockOnRedirect).toHaveBeenCalledWith(authUrl)
  })

  test('saveCodeVerifier stores code verifier', () => {
    const codeVerifier = 'test-code-verifier'
    provider.saveCodeVerifier(codeVerifier)
    expect(provider.codeVerifier()).toBe(codeVerifier)
  })

  test('codeVerifier throws error when not set', () => {
    expect(() => provider.codeVerifier()).toThrow('No code verifier saved')
  })
})

describe('McpOAuthManager', () => {
  let manager: McpOAuthManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.connect.mockClear()
    mockClient.close.mockClear()
    mockTransport.finishAuth.mockClear()
    mockServer.listen.mockClear()
    mockServer.close.mockClear()
    mockServer.on.mockClear()
    manager = new McpOAuthManager(app)
  })

  test('constructor initializes with app', () => {
    expect(manager).toBeDefined()
  })


  test('detectOAuth detects no OAuth required', async () => {
    mockClient.connect.mockResolvedValue(undefined)
    mockClient.close.mockResolvedValue(undefined)

    const result = await manager.detectOAuth('http', 'http://localhost:3000', {})

    expect(result).toEqual({ requiresOAuth: false })
    expect(mockClient.connect).toHaveBeenCalled()
    expect(mockClient.close).toHaveBeenCalled()
  })

  test('detectOAuth detects OAuth required for SSE (401 error)', async () => {
    const sseError = new Error('SSE error: Non-200 status code (401)')
    mockClient.connect.mockRejectedValue(sseError)

    const result = await manager.detectOAuth('sse', 'https://mcp.asana.com/sse', {})

    expect(result.requiresOAuth).toBe(true)
    expect(result.metadata).toBeDefined()
    expect(mockClient.connect).toHaveBeenCalled()
  })

  test('detectOAuth throws non-OAuth errors', async () => {
    const networkError = new Error('Network connection failed')
    mockClient.connect.mockRejectedValue(networkError)

    await expect(manager.detectOAuth('http', 'http://localhost:3000', {})).rejects.toThrow('Network connection failed')
  })

  describe('isOAuthRequiredError', () => {
    test('returns true for UnauthorizedError', async () => {
      const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
      const error = new UnauthorizedError('Unauthorized')
      expect(manager.isOAuthRequiredError(error)).toBe(true)
    })

    test('returns true for dynamic client registration errors', () => {
      const error1 = new Error('Dynamic client registration required')
      const error2 = new Error('Server does not support dynamic client registration')

      expect(manager.isOAuthRequiredError(error1)).toBe(true)
      expect(manager.isOAuthRequiredError(error2)).toBe(true)
    })

    test('returns true for HTTP 401 with OAuth indicators', () => {
      const error1 = new Error('HTTP 401: invalid_token')
      const error2 = new Error('HTTP 401: missing authorization')
      const error3 = new Error('HTTP 401: authentication required')

      expect(manager.isOAuthRequiredError(error1)).toBe(true)
      expect(manager.isOAuthRequiredError(error2)).toBe(true)
      expect(manager.isOAuthRequiredError(error3)).toBe(true)
    })

    test('returns true for 401 via error.code property', () => {
      const error = { code: 401, message: 'Some error' }
      expect(manager.isOAuthRequiredError(error)).toBe(true)
    })

    test('returns true for 401 via error.status property', () => {
      const error = { status: 401, message: 'Some error' }
      expect(manager.isOAuthRequiredError(error)).toBe(true)
    })

    test('returns true for 401 via error.statusCode property', () => {
      const error = { statusCode: 401, message: 'Some error' }
      expect(manager.isOAuthRequiredError(error)).toBe(true)
    })

    test('returns true for SSE 401 errors', () => {
      const error = new Error('SSE error: Non-200 status code (401)')
      expect(manager.isOAuthRequiredError(error)).toBe(true)
    })

    test('returns true for OAuth error responses', () => {
      const error1 = new Error('invalid_token')
      const error2 = new Error('access_denied')
      const error3 = new Error('insufficient_scope')
      const error4 = new Error('missing required authorization header')

      expect(manager.isOAuthRequiredError(error1)).toBe(true)
      expect(manager.isOAuthRequiredError(error2)).toBe(true)
      expect(manager.isOAuthRequiredError(error3)).toBe(true)
      expect(manager.isOAuthRequiredError(error4)).toBe(true)
    })

    test('returns true for generic unauthorized message', () => {
      const error = new Error('Request unauthorized')
      expect(manager.isOAuthRequiredError(error)).toBe(true)
    })

    test('returns false for non-OAuth errors', () => {
      const error1 = new Error('Network timeout')
      const error2 = new Error('HTTP 500: Internal server error')
      const error3 = new Error('Connection refused')
      const error4 = { code: 500, message: 'Server error' }

      expect(manager.isOAuthRequiredError(error1)).toBe(false)
      expect(manager.isOAuthRequiredError(error2)).toBe(false)
      expect(manager.isOAuthRequiredError(error3)).toBe(false)
      expect(manager.isOAuthRequiredError(error4)).toBe(false)
    })

    test('handles null and undefined errors gracefully', () => {
      expect(manager.isOAuthRequiredError(null)).toBe(false)
      expect(manager.isOAuthRequiredError(undefined)).toBe(false)
    })

    test('handles error without message property', () => {
      const error = { code: 401 }
      expect(manager.isOAuthRequiredError(error)).toBe(true)

      const error2 = { code: 500 }
      expect(manager.isOAuthRequiredError(error2)).toBe(false)
    })
  })


  test('createOAuthProvider creates provider with custom metadata', async () => {
    const customMetadata = {
      client_name: 'Custom Client',
      redirect_uris: ['http://localhost:9000/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    }
    
    const provider = await manager.createOAuthProvider(customMetadata, () => {}, () => {})
    
    expect(provider.clientMetadata).toEqual(customMetadata)
  })

  test('startOAuthFlow handles UnauthorizedError', async () => {
    const clientMetadata = {
      client_name: 'Test Client',
      redirect_uris: ['http://localhost:8090/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    }
    
    mockServer.listen.mockImplementation((port, callback) => {
      callback()
    })
    
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
    const unauthorizedError = new UnauthorizedError('OAuth required')
    mockClient.connect.mockRejectedValueOnce(unauthorizedError).mockResolvedValueOnce(undefined)
    mockTransport.finishAuth.mockResolvedValue(undefined)
    
    // Mock the waitForCallback method on the manager itself
    const originalWaitForCallback = manager.waitForCallback
    manager.waitForCallback = vi.fn(() => Promise.resolve('test-auth-code'))
    
    await manager.startOAuthFlow('http', 'http://localhost:3000', clientMetadata)
    expect(mockTransport.finishAuth).toHaveBeenCalledWith('test-auth-code')
    
    // Restore original method
    manager.waitForCallback = originalWaitForCallback
  })

  test('completeOAuthFlow returns false (legacy method)', async () => {
    const result = await manager.completeOAuthFlow('server-uuid', 'auth-code')
    expect(result).toBe(false)
  })

  test('shutdown method exists', () => {
    expect(() => manager.shutdown()).not.toThrow()
  })
})

describe('McpOAuthManager - Callback Functionality', () => {
  let manager: McpOAuthManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockHttpServerInstance.registerRoute.mockClear()
    mockHttpServerInstance.listen.mockClear()
    mockHttpServerInstance.close.mockClear()

    manager = new McpOAuthManager(app)
  })

  test('waitForCallback resolves with authorization code', async () => {
    const flowId = 'test-flow'
    
    // Start the promise
    const callbackPromise = manager.waitForCallback(flowId)
    
    // Wait a tick for the promise to set up the pending callback
    await new Promise(resolve => setImmediate(resolve))
    
    // Simulate receiving a callback by resolving the stored promise
    const pendingCallback = (manager as any).pendingCallbacks.get(flowId)
    if (pendingCallback) {
      clearTimeout(pendingCallback.timeout)
      pendingCallback.resolve('test-auth-code')
    }
    
    const result = await callbackPromise
    expect(result).toBe('test-auth-code')
  })

  test('waitForCallback times out after 5 minutes', async () => {
    const flowId = 'test-timeout-flow'
    
    // Mock setTimeout to immediately trigger timeout
    const originalSetTimeout = global.setTimeout
    global.setTimeout = vi.fn((callback) => {
      // Immediately call the timeout callback
      callback()
      return {} as NodeJS.Timeout
    })
    
    await expect(manager.waitForCallback(flowId)).rejects.toThrow('OAuth callback timeout')
    
    // Restore original setTimeout
    global.setTimeout = originalSetTimeout
  })

  test('handleCallback processes successful OAuth callback', async () => {
    const flowId = 'test-flow'
    
    // Set up a pending callback
    const mockResolve = vi.fn()
    const mockReject = vi.fn()
    const mockTimeout = setTimeout(() => {}, 1000)
    ;(manager as any).pendingCallbacks.set(flowId, {
      resolve: mockResolve,
      reject: mockReject,
      timeout: mockTimeout
    })
    
    // Mock request and response
    const mockReq = {}
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    }
    const mockParsedUrl = new URL('http://localhost:8090/callback?code=test-auth-code&state=' + flowId)
    
    // Call the handleCallback method
    ;(manager as any).handleCallback(mockReq, mockRes, mockParsedUrl)
    
    // Verify response
    expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    })
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('mcp.oauth.success.title'))
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('mcp.oauth.success.message'))
    
    // Verify callback was resolved
    expect(mockResolve).toHaveBeenCalledWith('test-auth-code')
    expect((manager as any).pendingCallbacks.has(flowId)).toBe(false)
    
    clearTimeout(mockTimeout)
  })

  test('handleCallback processes OAuth error callback', async () => {
    const flowId = 'test-error-flow'
    
    // Set up a pending callback
    const mockResolve = vi.fn()
    const mockReject = vi.fn()
    const mockTimeout = setTimeout(() => {}, 1000)
    ;(manager as any).pendingCallbacks.set(flowId, {
      resolve: mockResolve,
      reject: mockReject,
      timeout: mockTimeout
    })
    
    // Mock request and response
    const mockReq = {}
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    }
    const mockParsedUrl = new URL('http://localhost:8090/callback?error=access_denied&state=' + flowId)
    
    // Call the handleCallback method
    ;(manager as any).handleCallback(mockReq, mockRes, mockParsedUrl)
    
    // Verify response
    expect(mockRes.writeHead).toHaveBeenCalledWith(400, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': expect.stringContaining("default-src 'none'"),
    })
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Authorization Failed'))
    
    // Verify callback was rejected
    expect(mockReject).toHaveBeenCalledWith(new Error('OAuth authorization failed: access_denied'))
    expect((manager as any).pendingCallbacks.has(flowId)).toBe(false)
    
    clearTimeout(mockTimeout)
  })

  test('handleCallback processes invalid callback requests', async () => {
    const flowId = 'test-invalid-flow'
    
    // Set up a pending callback
    const mockResolve = vi.fn()
    const mockReject = vi.fn()
    const mockTimeout = setTimeout(() => {}, 1000)
    ;(manager as any).pendingCallbacks.set(flowId, {
      resolve: mockResolve,
      reject: mockReject,
      timeout: mockTimeout
    })
    
    // Mock request and response with no code or error
    const mockReq = {}
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    }
    const mockParsedUrl = new URL('http://localhost:8090/callback?state=' + flowId)
    
    // Call the handleCallback method
    ;(manager as any).handleCallback(mockReq, mockRes, mockParsedUrl)
    
    // Verify response
    expect(mockRes.writeHead).toHaveBeenCalledWith(400)
    expect(mockRes.end).toHaveBeenCalledWith('Bad request')
    
    // Verify callback was rejected
    expect(mockReject).toHaveBeenCalledWith(new Error('No authorization code provided'))
    expect((manager as any).pendingCallbacks.has(flowId)).toBe(false)
    
    clearTimeout(mockTimeout)
  })

  test('handleCallback handles missing pending callback gracefully', async () => {
    // Mock request and response
    const mockReq = {}
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    }
    const mockParsedUrl = new URL('http://localhost:8090/callback?code=test-auth-code&state=nonexistent-flow')
    
    // Call the handleCallback method with no pending callback
    ;(manager as any).handleCallback(mockReq, mockRes, mockParsedUrl)
    
    // Should send 400 response when there's a code but no pending callback (falls through to else block)
    expect(mockRes.writeHead).toHaveBeenCalledWith(400)
    expect(mockRes.end).toHaveBeenCalledWith('Bad request')
  })

  test('multiple pending callbacks are handled independently', async () => {
    const flowId1 = 'test-flow-1'
    const flowId2 = 'test-flow-2'
    
    // Set up two pending callbacks
    const mockResolve1 = vi.fn()
    const mockResolve2 = vi.fn()
    const mockReject1 = vi.fn()
    const mockReject2 = vi.fn()
    
    ;(manager as any).pendingCallbacks.set(flowId1, {
      resolve: mockResolve1,
      reject: mockReject1,
      timeout: setTimeout(() => {}, 1000)
    })
    
    ;(manager as any).pendingCallbacks.set(flowId2, {
      resolve: mockResolve2,
      reject: mockReject2,
      timeout: setTimeout(() => {}, 1000)
    })
    
    // Mock first callback response
    const mockRes1 = { writeHead: vi.fn(), end: vi.fn() }
    const mockParsedUrl1 = new URL('http://localhost:8090/callback?code=auth-code-1&state=' + flowId1)
    ;(manager as any).handleCallback({}, mockRes1, mockParsedUrl1)
    
    // Verify first callback resolved, second still pending
    expect(mockResolve1).toHaveBeenCalledWith('auth-code-1')
    expect(mockResolve2).not.toHaveBeenCalled()
    expect((manager as any).pendingCallbacks.has(flowId1)).toBe(false)
    expect((manager as any).pendingCallbacks.has(flowId2)).toBe(true)
    
    // Mock second callback response  
    const mockRes2 = { writeHead: vi.fn(), end: vi.fn() }
    const mockParsedUrl2 = new URL('http://localhost:8090/callback?code=auth-code-2&state=' + flowId2)
    ;(manager as any).handleCallback({}, mockRes2, mockParsedUrl2)
    
    // Verify second callback resolved
    expect(mockResolve2).toHaveBeenCalledWith('auth-code-2')
    expect((manager as any).pendingCallbacks.has(flowId2)).toBe(false)
  })
})

describe('McpOAuthManager - Callback page escaping', () => {
  let manager: McpOAuthManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new McpOAuthManager(app)
  })

  // answers the callback of a flow that is waiting for it, the way the browser would
  const errorPage = (error: string): { status: number, headers: Record<string, string>, body: string } => {
    const state = 'pending-flow'
    const timeout = setTimeout(() => {}, 1000)
    ;(manager as any).pendingCallbacks.set(state, { resolve: vi.fn(), reject: vi.fn(), timeout })
    const res = { writeHead: vi.fn(), end: vi.fn() }
    const url = new URL(`http://localhost:8090/mcp/callback?state=${state}&error=${encodeURIComponent(error)}`)
    ;(manager as any).handleCallback({}, res, url)
    clearTimeout(timeout)
    return { status: res.writeHead.mock.calls[0][0], headers: res.writeHead.mock.calls[0][1], body: res.end.mock.calls[0][0] }
  }

  test.each([
    ['<script>alert(document.domain)</script>', '&lt;script&gt;alert(document.domain)&lt;/script&gt;'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['</p><iframe src="https://evil.example.com"></iframe>', '&lt;/p&gt;&lt;iframe src=&quot;https://evil.example.com&quot;&gt;&lt;/iframe&gt;'],
    ['"><svg onload=alert(1)>', '&quot;&gt;&lt;svg onload=alert(1)&gt;'],
    ['\' onmouseover=\'alert(1)', '&#39; onmouseover=&#39;alert(1)'],
    ['&lt;script&gt;alert(1)&lt;/script&gt;', '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;'],
  ])('error page escapes %s', (payload, escaped) => {
    const { status, body } = errorPage(payload)
    expect(status).toBe(400)
    expect(body).not.toContain(payload)
    expect(body).toContain(`<p>Error: ${escaped}</p>`)
    // the payload only exists as text: no element comes from it (the page has a logo and no script)
    expect(body.match(/<img/g)).toHaveLength(1)
    expect(body).not.toMatch(/<script|<iframe|<svg/i)
    const markup = body.replace(`<p>Error: ${escaped}</p>`, '')
    expect(markup).not.toMatch(/alert\(|onerror=|onload=|onmouseover=/i)
  })

  test('error page shows a plain error code as is', () => {
    const { body } = errorPage('access_denied')
    expect(body).toContain('<p>Error: access_denied</p>')
  })

  test('error page truncates an oversized error', () => {
    const { body } = errorPage('a'.repeat(5000) + '<script>alert(1)</script>')
    expect(body).toContain(`<p>Error: ${'a'.repeat(256)}</p>`)
    expect(body).not.toContain('alert(1)')
  })

  test('error page is served as html that cannot be sniffed or run scripts', () => {
    const { headers } = errorPage('<script>alert(1)</script>')
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'")
    expect(headers['Content-Security-Policy']).not.toContain('script-src')
  })
})

describe('McpOAuthManager - Flow isolation', () => {
  let manager: McpOAuthManager

  const metadata = () => ({
    client_name: 'Test Client',
    redirect_uris: ['http://localhost:8090/mcp/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code']
  })

  // a server that needs an authorization: connecting sends the browser to its authorization
  // endpoint until the transport was given a code, which becomes the access token
  const authorizationEndpoint = (serverUrl: URL) => `https://auth.example.com/authorize?server=${serverUrl.hostname}`
  const transports: { url: URL, options: any, finishAuth: ReturnType<typeof vi.fn> }[] = []

  const pending = (): Map<string, unknown> => (manager as any).pendingCallbacks

  const openedUrls = (): URL[] => vi.mocked(shell.openExternal).mock.calls.map(([url]) => new URL(url))

  const stateFor = (serverUrl: string): string => {
    const opened = openedUrls().filter((url) => url.searchParams.get('server') === new URL(serverUrl).hostname)
    return opened[opened.length - 1].searchParams.get('state')!
  }

  const callback = (query: string) => {
    const res = { writeHead: vi.fn(), end: vi.fn() }
    ;(manager as any).handleCallback({}, res, new URL(`http://localhost:8090/mcp/callback?${query}`))
    return res
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    transports.length = 0
    mockHttpServerInstance.getBaseUrl.mockReturnValue('http://localhost:8090')
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
    vi.mocked(StreamableHTTPClientTransport).mockImplementation(((url: URL, options: any) => {
      const transport = {
        url, options,
        finishAuth: vi.fn(async (code: string) => options.authProvider.saveTokens({ access_token: `token-for-${code}`, token_type: 'bearer' })),
      }
      transports.push(transport)
      return transport
    }) as any)
    mockClient.connect.mockImplementation(async (transport: any) => {
      const provider = transport.options.authProvider
      if (!provider.tokens()) {
        provider.redirectToAuthorization(new URL(authorizationEndpoint(transport.url)))
        throw new (UnauthorizedError as any)('Unauthorized')
      }
    })
    manager = new McpOAuthManager(app)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(StreamableHTTPClientTransport).mockImplementation((() => mockTransport) as any)
    mockClient.connect.mockReset()
    mockHttpServerInstance.getBaseUrl.mockReturnValue('http://localhost:8090')
  })

  test('each flow gets its own unguessable state', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata()).catch(() => {})
    manager.startOAuthFlow('http', 'https://b.example.com/mcp', metadata()).catch(() => {})
    random.mockRestore()
    now.mockRestore()
    await vi.waitFor(() => expect(pending().size).toBe(2))
    const stateA = stateFor('https://a.example.com/mcp')
    const stateB = stateFor('https://b.example.com/mcp')
    // 32 random bytes, whatever Math.random and the clock return
    expect(stateA).toMatch(/^[0-9a-f]{64}$/)
    expect(stateB).toMatch(/^[0-9a-f]{64}$/)
    expect(stateA).not.toBe(stateB)
    expect([...pending().keys()].sort()).toEqual([stateA, stateB].sort())
  })

  test('concurrent flows complete with their own callback, server and tokens', async () => {
    const flowA = manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata())
    const flowB = manager.startOAuthFlow('http', 'https://b.example.com/mcp', metadata())
    await vi.waitFor(() => expect(pending().size).toBe(2))
    const stateA = stateFor('https://a.example.com/mcp')
    const stateB = stateFor('https://b.example.com/mcp')

    // B is authorized first: A keeps waiting
    callback(`code=code-b&state=${stateB}`)
    const resultB = JSON.parse(await flowB)
    expect(resultB.tokens.access_token).toBe('token-for-code-b')
    expect(pending().has(stateA)).toBe(true)

    callback(`code=code-a&state=${stateA}`)
    const resultA = JSON.parse(await flowA)
    expect(resultA.tokens.access_token).toBe('token-for-code-a')

    // each flow only ever talked to its own server, with its own code
    expect(transports.map((t) => t.url.hostname)).toEqual(['a.example.com', 'b.example.com', 'b.example.com', 'a.example.com'])
    expect(transports[0].finishAuth).toHaveBeenCalledWith('code-a')
    expect(transports[1].finishAuth).toHaveBeenCalledWith('code-b')
    expect(transports[2].options.authProvider.tokens().access_token).toBe('token-for-code-b')
    expect(transports[3].options.authProvider.tokens().access_token).toBe('token-for-code-a')
    expect(pending().size).toBe(0)
  })

  test('a callback without a state or with an unknown state is refused and completes nothing', async () => {
    let settled = false
    manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata()).then(() => settled = true, () => settled = true)
    await vi.waitFor(() => expect(pending().size).toBe(1))

    for (const query of ['code=stolen', 'code=stolen&state=', 'code=stolen&state=default', 'code=stolen&state=unknown', `code=stolen&state=${'0'.repeat(64)}`]) {
      const res = callback(query)
      expect(res.writeHead, query).toHaveBeenCalledWith(400)
      expect(res.end, query).toHaveBeenCalledWith('Bad request')
    }

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(pending().size).toBe(1)
    expect(transports[0].finishAuth).not.toHaveBeenCalled()
  })

  test('an error callback with an unknown state shows nothing of the request', async () => {
    const res = callback('error=%3Cb%3Eplease%20call%20this%20number%3C%2Fb%3E&state=unknown')
    expect(res.writeHead).toHaveBeenCalledWith(400)
    expect(res.end).toHaveBeenCalledWith('Bad request')
  })

  test('a state completes a single callback', async () => {
    const flow = manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata())
    await vi.waitFor(() => expect(pending().size).toBe(1))
    const state = stateFor('https://a.example.com/mcp')

    expect(callback(`code=code-a&state=${state}`).writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    const replay = callback(`code=code-replayed&state=${state}`)
    expect(replay.writeHead).toHaveBeenCalledWith(400)
    expect(replay.end).toHaveBeenCalledWith('Bad request')

    expect(JSON.parse(await flow).tokens.access_token).toBe('token-for-code-a')
    expect(transports[0].finishAuth).toHaveBeenCalledTimes(1)
  })

  test('an error callback ends its flow and its state', async () => {
    const flow = manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata())
    await vi.waitFor(() => expect(pending().size).toBe(1))
    const state = stateFor('https://a.example.com/mcp')

    expect(callback(`error=access_denied&state=${state}`).writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    await expect(flow).rejects.toThrow('OAuth authorization failed: access_denied')
    expect(callback(`code=code-a&state=${state}`).end).toHaveBeenCalledWith('Bad request')
  })

  test('a new authorization request in the same flow gets a new state', async () => {
    // the server asks for an authorization again after the first code
    transports.length = 0
    let authorizations = 0
    vi.mocked(StreamableHTTPClientTransport).mockImplementation(((url: URL, options: any) => {
      const transport = {
        url, options,
        finishAuth: vi.fn(async (code: string) => {
          if (++authorizations === 2) options.authProvider.saveTokens({ access_token: `token-for-${code}`, token_type: 'bearer' })
        }),
      }
      transports.push(transport)
      return transport
    }) as any)

    const flow = manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata())
    await vi.waitFor(() => expect(pending().size).toBe(1))
    const first = stateFor('https://a.example.com/mcp')
    callback(`code=code-1&state=${first}`)

    await vi.waitFor(() => expect(openedUrls()).toHaveLength(2))
    await vi.waitFor(() => expect(pending().size).toBe(1))
    const second = stateFor('https://a.example.com/mcp')
    expect(second).not.toBe(first)
    expect(callback(`code=code-2&state=${first}`).end).toHaveBeenCalledWith('Bad request')
    callback(`code=code-2&state=${second}`)

    expect(JSON.parse(await flow).tokens.access_token).toBe('token-for-code-2')
  })

  test('a state expires', async () => {
    vi.useFakeTimers()
    const flow = manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata())
    const failure = expect(flow).rejects.toThrow('OAuth callback timeout')
    await vi.advanceTimersByTimeAsync(0)
    expect(pending().size).toBe(1)
    const state = stateFor('https://a.example.com/mcp')

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(pending().has(state)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await failure
    expect(pending().size).toBe(0)

    const late = callback(`code=code-a&state=${state}`)
    expect(late.writeHead).toHaveBeenCalledWith(400)
    expect(late.end).toHaveBeenCalledWith('Bad request')
    expect(transports[0].finishAuth).not.toHaveBeenCalled()
  })

  test('the redirect uri uses the port the callback server listens on', async () => {
    // the configured port was taken: the server fell back to another one
    mockHttpServerInstance.getBaseUrl.mockReturnValue('http://localhost:8091')
    const flow = manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata(), { client_id: 'id', client_secret: 'secret' })
    await vi.waitFor(() => expect(pending().size).toBe(1))

    expect(mockHttpServerInstance.ensureServerRunning).toHaveBeenCalled()
    const provider = transports[0].options.authProvider
    expect(provider.redirectUrl).toBe('http://localhost:8091/mcp/callback')
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://localhost:8091/mcp/callback'])
    expect(provider.clientInformation().redirect_uris).toEqual(['http://localhost:8091/mcp/callback'])

    callback(`code=code-a&state=${stateFor('https://a.example.com/mcp')}`)
    expect(JSON.parse(await flow).clientMetadata.redirect_uris).toEqual(['http://localhost:8091/mcp/callback'])
  })

  test('the authorization url is opened in the browser with the state', async () => {
    manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata()).catch(() => {})
    await vi.waitFor(() => expect(pending().size).toBe(1))
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
    const opened = openedUrls()[0]
    expect(opened.origin + opened.pathname).toBe('https://auth.example.com/authorize')
    expect(pending().has(opened.searchParams.get('state')!)).toBe(true)
  })

  test.each([
    ['javascript:alert(1)'],
    ['file:///C:/Windows/System32/calc.exe'],
    ['ms-msdt:/id PCWDiagnostic'],
    ['search-ms:query=x&crumb=location:\\\\evil.example.com\\share'],
    ['mailto:someone@example.com'],
    ['vscode://extension/install'],
  ])('an authorization url that is not a web page is not opened: %s', async (authorizationUrl) => {
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
    mockClient.connect.mockImplementation(async (transport: any) => {
      transport.options.authProvider.redirectToAuthorization(new URL(authorizationUrl))
      throw new (UnauthorizedError as any)('Unauthorized')
    })
    await expect(manager.startOAuthFlow('http', 'https://a.example.com/mcp', metadata())).rejects.toThrow('only http and https URLs can be opened')
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(pending().size).toBe(0)
  })
})
