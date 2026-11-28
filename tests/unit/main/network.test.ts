
import { vi, test, expect, beforeEach, afterEach } from 'vitest'
import { BrowserWindow } from 'electron'
import { debugWindow } from '@main/windows/debug'
import interceptNetwork, {
  clearNetworkHistory, getNetworkHistory, maskHeaders, maskUrl,
  HIDDEN, MAX_BODY_LENGTH, MAX_FRAME_PAYLOAD_LENGTH, MAX_REQUESTS_PER_WINDOW, MAX_WEBSOCKET_FRAMES
} from '@main/network'

global.MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://localhost:3000/'
global.MAIN_WINDOW_VITE_NAME = 'vite'

vi.mock('electron', () => {
  const BrowserWindow = vi.fn()
  BrowserWindow.prototype.webContents = {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async (command) => {
        if (command === 'Network.getResponseBody') {
          return { body: 'response', base64encoded: false }
        }
      }),
      on: vi.fn(),
    }
  }
  BrowserWindow.prototype.on = vi.fn()
  return { BrowserWindow }
})

vi.mock('@main/windows/debug.ts', () => {
  return {
    debugWindow: {
      webContents: {
        send: vi.fn()
      }
    }
  }
})

// the mocked windows share their spies: the handlers of a window are the last ones registered when it was attached
const attach = () => {
  const window = new BrowserWindow()
  interceptNetwork(window)
  const lastHandler = (spy: any, event: string) => vi.mocked(spy).mock.calls.filter((call: any[]) => call[0] === event).at(-1)[1] as (...args: any[]) => any
  const message = lastHandler(window.webContents.debugger.on, 'message')
  return {
    window,
    emit: (method: string, params: any) => message({}, method, params),
    detach: lastHandler(window.webContents.debugger.on, 'detach'),
    close: lastHandler(window.on, 'closed'),
  }
}

const httpRequest = (requestId: string, headers: Record<string, string> = {}, url = 'https://api.example.com/v1/chat', postData = '{}') => ({
  requestId, request: { url, method: 'POST', headers, postData }
})

const frame = (requestId: string, payloadData: string, timestamp = 1) => ({
  requestId, timestamp, response: { opcode: 1, mask: true, payloadData }
})

beforeEach(() => {
  vi.clearAllMocks()
  clearNetworkHistory()
})

afterEach(() => {
  vi.useRealTimers()
})

test('attaches debugger', async () => {

  const window = new BrowserWindow()
  interceptNetwork(window)

  expect(window.webContents.debugger.attach).toHaveBeenLastCalledWith('1.3')
  expect(window.webContents.debugger.sendCommand).toHaveBeenLastCalledWith('Network.enable')
  expect(window.webContents.debugger.on).toHaveBeenCalledWith('message', expect.any(Function))
  expect(window.webContents.debugger.on).toHaveBeenCalledWith('detach', expect.any(Function))

  expect(window.on).toHaveBeenLastCalledWith('closed', expect.any(Function))

})

test('processes http requests', async () => {

  const window = new BrowserWindow()
  interceptNetwork(window)
  const messageHandler = window.webContents.debugger.on.mock.calls[0][1]

  messageHandler({}, 'Network.requestWillBeSent', {
    requestId: '123',
    request: {
      url: 'http://example.com',
      method: 'GET',
      headers: {
        'header': 'request',
        'authorization': '123',
        'Authorization': '123',
        'x-goog-api-key': '123',
        'x-api-key': '123'
      },
      postData: 'data'
    }
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: '123',
    startTime: expect.any(Number),
    type: 'http',
    url: 'http://example.com',
    method: 'GET',
    headers: {
      'header': 'request',
      'authorization': '*** hidden ***',
      'Authorization': '*** hidden ***',
      'x-goog-api-key': '*** hidden ***',
      'x-api-key': '*** hidden ***'
    },
    postData: 'data'
  })

  await messageHandler({}, 'Network.responseReceived', {
    requestId: '123',
    response: {
      status: 200,
      statusText: 'OK',
      headers: {
        'header': 'response'
      },
      mimeType: 'application/json',
    }
  })

  // expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
  //   id: '123',
  //   url: 'http://example.com',
  //   method: 'GET',
  //   headers: {
  //     'header': 'request',
  //     'authorization': '*** hidden ***',
  //     'Authorization': '*** hidden ***',
  //     'x-goog-api-key': '*** hidden ***',
  //     'x-api-key': '*** hidden ***'
  //   },
  //   postData: 'data',
  //   mimeType: 'application/json',
  //   statusCode: 200,
  //   statusText: 'OK',
  //   responseHeaders: {
  //     'header': 'response'
  //   }
  // })

  expect(debugWindow.webContents.send).toHaveBeenCalledTimes(1)

  await messageHandler({}, 'Network.loadingFinished', {
    requestId: '123',
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: '123',
    startTime: expect.any(Number),
    endTime: expect.any(Number),
    type: 'http',
    url: 'http://example.com',
    method: 'GET',
    headers: {
      'header': 'request',
      'authorization': '*** hidden ***',
      'Authorization': '*** hidden ***',
      'x-goog-api-key': '*** hidden ***',
      'x-api-key': '*** hidden ***'
    },
    postData: 'data',
    mimeType: 'application/json',
    statusCode: 200,
    statusText: 'OK',
    responseBody: 'response',
    responseHeaders: {
      'header': 'response'
    }
  })


})

test('discards invalid requests', async () => {

  const window = new BrowserWindow()
  interceptNetwork(window)
  const messageHandler = window.webContents.debugger.on.mock.calls[0][1]

  messageHandler({}, 'Network.requestWillBeSent', {
    requestId: '123',
    request: {
      url: 'file://file.text',
    }
  })

  messageHandler({}, 'Network.requestWillBeSent', {
    requestId: '123',
    request: {
      url: 'blob://binary',
    }
  })

  messageHandler({}, 'Network.requestWillBeSent', {
    requestId: '123',
    request: {
      url: 'chrome-extension://binary',
    }
  })

  expect(debugWindow.webContents.send).not.toHaveBeenCalled()

})

test('processes websocket requests', async () => {

  const window = new BrowserWindow()
  interceptNetwork(window)
  const messageHandler = window.webContents.debugger.on.mock.calls[0][1]

  // Create WebSocket connection
  messageHandler({}, 'Network.webSocketCreated', {
    requestId: 'ws-123',
    url: 'wss://api.example.com/stream',
    initiator: {}
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: 'ws-123',
    startTime: expect.any(Number),
    type: 'websocket',
    url: 'wss://api.example.com/stream',
    method: 'OPEN',
    headers: {},
    postData: '',
    frames: [],
  })

  // Handle handshake response
  await messageHandler({}, 'Network.webSocketHandshakeResponseReceived', {
    requestId: 'ws-123',
    response: {
      status: 101,
      statusText: 'Switching Protocols',
      headers: {
        'upgrade': 'websocket',
        'connection': 'Upgrade',
        'authorization': 'Bearer secret123'
      }
    }
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: 'ws-123',
    startTime: expect.any(Number),
    type: 'websocket',
    url: 'wss://api.example.com/stream',
    method: 'OPEN',
    headers: {},
    postData: '',
    frames: [],
    statusCode: 101,
    statusText: 'Switching Protocols',
    responseHeaders: {
      'upgrade': 'websocket',
      'connection': 'Upgrade',
      'authorization': '*** hidden ***'
    }
  })

  // Send frame
  await messageHandler({}, 'Network.webSocketFrameSent', {
    requestId: 'ws-123',
    timestamp: 1234567890,
    response: {
      opcode: 1,
      mask: true,
      payloadData: 'Hello WebSocket!'
    }
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: 'ws-123',
    startTime: expect.any(Number),
    type: 'websocket',
    url: 'wss://api.example.com/stream',
    method: 'OPEN',
    headers: {},
    postData: '',
    frames: [{
      type: 'sent',
      timestamp: 1234567890,
      opcode: 1,
      mask: true,
      payloadData: 'Hello WebSocket!',
      payloadLength: 16
    }],
    statusCode: 101,
    statusText: 'Switching Protocols',
    responseHeaders: {
      'upgrade': 'websocket',
      'connection': 'Upgrade',
      'authorization': '*** hidden ***'
    }
  })

  // Receive frame
  await messageHandler({}, 'Network.webSocketFrameReceived', {
    requestId: 'ws-123',
    timestamp: 1234567891,
    response: {
      opcode: 1,
      mask: false,
      payloadData: 'Hello from server!'
    }
  })

  // Send another frame
  await messageHandler({}, 'Network.webSocketFrameSent', {
    requestId: 'ws-123',
    timestamp: 1234567892,
    response: {
      opcode: 1,
      mask: true,
      payloadData: 'How are you?'
    }
  })

  // Receive another frame
  await messageHandler({}, 'Network.webSocketFrameReceived', {
    requestId: 'ws-123',
    timestamp: 1234567893,
    response: {
      opcode: 1,
      mask: false,
      payloadData: 'I am doing well, thanks!'
    }
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: 'ws-123',
    startTime: expect.any(Number),
    type: 'websocket',
    url: 'wss://api.example.com/stream',
    method: 'OPEN',
    headers: {},
    postData: '',
    frames: [
      {
        type: 'sent',
        timestamp: 1234567890,
        opcode: 1,
        mask: true,
        payloadData: 'Hello WebSocket!',
        payloadLength: 16
      },
      {
        type: 'received',
        timestamp: 1234567891,
        opcode: 1,
        mask: false,
        payloadData: 'Hello from server!',
        payloadLength: 18
      },
      {
        type: 'sent',
        timestamp: 1234567892,
        opcode: 1,
        mask: true,
        payloadData: 'How are you?',
        payloadLength: 12
      },
      {
        type: 'received',
        timestamp: 1234567893,
        opcode: 1,
        mask: false,
        payloadData: 'I am doing well, thanks!',
        payloadLength: 24
      }
    ],
    statusCode: 101,
    statusText: 'Switching Protocols',
    responseHeaders: {
      'upgrade': 'websocket',
      'connection': 'Upgrade',
      'authorization': '*** hidden ***'
    }
  })

  // Close WebSocket
  await messageHandler({}, 'Network.webSocketClosed', {
    requestId: 'ws-123',
    timestamp: 1234567894
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: 'ws-123',
    startTime: expect.any(Number),
    endTime: expect.any(Number),
    type: 'websocket',
    url: 'wss://api.example.com/stream',
    method: 'OPEN',
    headers: {},
    postData: '',
    frames: [
      {
        type: 'sent',
        timestamp: 1234567890,
        opcode: 1,
        mask: true,
        payloadData: 'Hello WebSocket!',
        payloadLength: 16
      },
      {
        type: 'received',
        timestamp: 1234567891,
        opcode: 1,
        mask: false,
        payloadData: 'Hello from server!',
        payloadLength: 18
      },
      {
        type: 'sent',
        timestamp: 1234567892,
        opcode: 1,
        mask: true,
        payloadData: 'How are you?',
        payloadLength: 12
      },
      {
        type: 'received',
        timestamp: 1234567893,
        opcode: 1,
        mask: false,
        payloadData: 'I am doing well, thanks!',
        payloadLength: 24
      }
    ],
    statusCode: 101,
    statusText: 'Switching Protocols',
    responseHeaders: {
      'upgrade': 'websocket',
      'connection': 'Upgrade',
      'authorization': '*** hidden ***'
    },
  })

})

test('handles websocket errors', async () => {

  const window = new BrowserWindow()
  interceptNetwork(window)
  const messageHandler = window.webContents.debugger.on.mock.calls[0][1]

  // Create WebSocket connection
  messageHandler({}, 'Network.webSocketCreated', {
    requestId: 'ws-error-123',
    url: 'wss://api.example.com/stream'
  })

  // WebSocket error
  await messageHandler({}, 'Network.webSocketFrameError', {
    requestId: 'ws-error-123',
    timestamp: 1234567890,
    errorMessage: 'Connection failed'
  })

  expect(debugWindow.webContents.send).toHaveBeenLastCalledWith('network', {
    id: 'ws-error-123',
    startTime: expect.any(Number),
    endTime: expect.any(Number),
    type: 'websocket',
    url: 'wss://api.example.com/stream',
    method: 'OPEN',
    headers: {},
    postData: '',
    frames: [],
    errorMessage: 'Connection failed',
  })

})

test('discards invalid websocket requests', async () => {

  const window = new BrowserWindow()
  interceptNetwork(window)
  const messageHandler = window.webContents.debugger.on.mock.calls[0][1]

  // Try to create WebSocket with dev server URL (should be filtered)
  messageHandler({}, 'Network.webSocketCreated', {
    requestId: 'ws-invalid-123',
    url: 'ws://localhost:3000/socket'
  })

  expect(debugWindow.webContents.send).not.toHaveBeenCalled()

})

test.each([
  ['authorization'],
  ['AUTHORIZATION'],
  ['Proxy-Authorization'],
  ['Cookie'],
  ['Set-Cookie'],
  ['x-api-key'],
  ['api-key'],
  ['xi-api-key'],
  ['X-Goog-Api-Key'],
  ['OpenAI-Api-Key'],
  ['apikey'],
  ['X-Subscription-Token'],
  ['Ocp-Apim-Subscription-Key'],
  ['x-auth-token'],
  ['x-client-secret'],
  ['x-password'],
  ['x-amz-security-token'],
])('hides the %s header in requests and responses', async (header) => {

  const { emit } = attach()

  await emit('Network.requestWillBeSent', httpRequest('1', { [header]: 'secret-value', accept: '*/*' }))
  await emit('Network.responseReceived', {
    requestId: '1',
    response: { status: 200, statusText: 'OK', headers: { [header]: 'secret-value', 'content-type': 'text/plain' }, mimeType: 'text/plain' }
  })
  await emit('Network.webSocketCreated', { requestId: 'ws', url: 'wss://api.example.com/stream' })
  await emit('Network.webSocketHandshakeResponseReceived', {
    requestId: 'ws',
    response: { status: 101, statusText: 'Switching Protocols', headers: { [header]: 'secret-value', upgrade: 'websocket' } }
  })

  const [http, websocket] = getNetworkHistory()
  expect(http.headers).toStrictEqual({ [header]: HIDDEN, accept: '*/*' })
  expect(http.responseHeaders).toStrictEqual({ [header]: HIDDEN, 'content-type': 'text/plain' })
  expect(websocket.responseHeaders).toStrictEqual({ [header]: HIDDEN, upgrade: 'websocket' })
  expect(JSON.stringify(getNetworkHistory())).not.toContain('secret-value')
  expect(JSON.stringify(vi.mocked(debugWindow.webContents.send).mock.calls)).not.toContain('secret-value')

})

test('keeps headers that only look like credentials', () => {
  const headers = {
    'content-type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="example"',
    'x-ratelimit-remaining-tokens': '149984',
    'anthropic-ratelimit-input-tokens-limit': '400000',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'x-request-id': 'req_123',
  }
  expect(maskHeaders(headers)).toStrictEqual(headers)
  expect(maskHeaders(undefined)).toStrictEqual({})
})

test('does not modify the headers reported by the debugger', async () => {
  const { emit } = attach()
  const headers = { authorization: 'Bearer secret-value' }
  await emit('Network.requestWillBeSent', httpRequest('1'))
  await emit('Network.responseReceived', { requestId: '1', response: { status: 200, statusText: 'OK', headers, mimeType: 'text/plain' } })
  expect(headers.authorization).toBe('Bearer secret-value')
  expect(getNetworkHistory()[0].responseHeaders.authorization).toBe(HIDDEN)
})

test.each([
  ['https://user:secret-value@api.example.com/v1/models?limit=10', `https://${HIDDEN}@api.example.com/v1/models?limit=10`],
  ['https://secret-value@api.example.com/v1/models', `https://${HIDDEN}@api.example.com/v1/models`],
  ['wss://user:secret-value@rt.example.com:8443/v2', `wss://${HIDDEN}@rt.example.com:8443/v2`],
  ['https://generativelanguage.googleapis.com/v1beta/models?key=secret-value', `https://generativelanguage.googleapis.com/v1beta/models?key=${HIDDEN}`],
  ['https://api.example.com/search?q=cats&api_key=secret-value&page=2', `https://api.example.com/search?q=cats&api_key=${HIDDEN}&page=2`],
  ['https://api.example.com/search?apikey=secret-value', `https://api.example.com/search?apikey=${HIDDEN}`],
  ['https://api.example.com/search?API-KEY=secret-value', `https://api.example.com/search?API-KEY=${HIDDEN}`],
  ['https://api.example.com/me?access_token=secret-value', `https://api.example.com/me?access_token=${HIDDEN}`],
  ['https://api.example.com/me?token=secret-value', `https://api.example.com/me?token=${HIDDEN}`],
  ['https://api.example.com/me?refresh_token=secret-value', `https://api.example.com/me?refresh_token=${HIDDEN}`],
  ['https://auth.example.com/token?client_id=abc&client_secret=secret-value', `https://auth.example.com/token?client_id=abc&client_secret=${HIDDEN}`],
  ['http://localhost:8090/callback?code=secret-value&state=xyz', `http://localhost:8090/callback?code=${HIDDEN}&state=xyz`],
  ['https://bucket.s3.amazonaws.com/file.png?X-Amz-Signature=secret-value&X-Amz-Expires=300', `https://bucket.s3.amazonaws.com/file.png?X-Amz-Signature=${HIDDEN}&X-Amz-Expires=300`],
  ['https://account.blob.core.windows.net/c/file?sv=2022&sig=secret-value', `https://account.blob.core.windows.net/c/file?sv=2022&sig=${HIDDEN}`],
  ['wss://eu2.rt.speechmatics.com/v2?jwt=secret-value', `wss://eu2.rt.speechmatics.com/v2?jwt=${HIDDEN}`],
  ['https://api.example.com/login?user=me&password=secret-value', `https://api.example.com/login?user=me&password=${HIDDEN}`],
  ['https://api.example.com/v1?subscription-key=secret-value', `https://api.example.com/v1?subscription-key=${HIDDEN}`],
  ['https://api.example.com/v1?access%5Ftoken=secret-value', `https://api.example.com/v1?access%5Ftoken=${HIDDEN}`],
  ['https://app.example.com/callback#access_token=secret-value&token_type=bearer', `https://app.example.com/callback#access_token=${HIDDEN}&token_type=bearer`],
  ['https://app.example.com/page?x=1#key=secret-value', `https://app.example.com/page?x=1#key=${HIDDEN}`],
])('hides the credentials of %s', (url, expected) => {
  expect(maskUrl(url)).toBe(expected)
})

test.each([
  ['https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/search?q=cats&author=me&max_tokens=100&pageToken=abc&keyword=x'],
  ['https://api.example.com/docs/a@b?email=me@example.com#section-2'],
  ['https://api.example.com/v1?token=&flag'],
  ['http://[::1]:8080/path?a=1&a=2'],
  ['not a url'],
  [''],
])('leaves %s as it is', (url) => {
  expect(maskUrl(url)).toBe(url)
})

test('tolerates urls that are not strings', () => {
  expect(maskUrl(undefined)).toBeUndefined()
  expect(maskUrl(null)).toBeNull()
})

test('hides url credentials wherever the url is stored or sent', async () => {

  const { emit } = attach()

  await emit('Network.requestWillBeSent', httpRequest('1', { Referer: 'https://app.example.com/?token=secret-value' }, 'https://user:secret-value@api.example.com/v1/models?key=secret-value&alt=sse'))
  await emit('Network.responseReceived', {
    requestId: '1',
    response: { status: 302, statusText: 'Found', headers: { Location: 'https://app.example.com/callback?code=secret-value&state=xyz' }, mimeType: 'text/plain' }
  })
  await emit('Network.loadingFinished', { requestId: '1' })
  await emit('Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2?jwt=secret-value&lang=en' })
  await emit('Network.webSocketFrameSent', frame('ws', 'hello'))
  await emit('Network.webSocketClosed', { requestId: 'ws' })

  const [http, websocket] = getNetworkHistory()
  expect(http.url).toBe(`https://${HIDDEN}@api.example.com/v1/models?key=${HIDDEN}&alt=sse`)
  expect(http.headers.Referer).toBe(`https://app.example.com/?token=${HIDDEN}`)
  expect(http.responseHeaders.Location).toBe(`https://app.example.com/callback?code=${HIDDEN}&state=xyz`)
  expect(websocket.url).toBe(`wss://rt.example.com/v2?jwt=${HIDDEN}&lang=en`)
  expect(JSON.stringify(getNetworkHistory())).not.toContain('secret-value')
  expect(JSON.stringify(vi.mocked(debugWindow.webContents.send).mock.calls)).not.toContain('secret-value')

})

test('does not log url credentials when the response body is not available', async () => {
  const { window, emit } = attach()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(window.webContents.debugger.sendCommand).mockRejectedValueOnce(new Error('No resource with given identifier found'))
  await emit('Network.requestWillBeSent', httpRequest('1', {}, 'https://api.example.com/v1/models?key=secret-value'))
  await emit('Network.loadingFinished', { requestId: '1' })
  expect(log).toHaveBeenCalled()
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value')
  log.mockRestore()
})

test('keeps only the most recent websocket frames', async () => {

  const { emit } = attach()
  await emit('Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2' })
  for (let i = 0; i < MAX_WEBSOCKET_FRAMES + 50; i++) {
    await emit(i % 2 ? 'Network.webSocketFrameSent' : 'Network.webSocketFrameReceived', frame('ws', `frame ${i}`, i))
  }

  const frames = getNetworkHistory()[0].frames
  expect(frames).toHaveLength(MAX_WEBSOCKET_FRAMES)
  expect(frames[0].payloadData).toBe('frame 50')
  expect(frames.at(-1).payloadData).toBe(`frame ${MAX_WEBSOCKET_FRAMES + 49}`)
  expect(vi.mocked(debugWindow.webContents.send).mock.lastCall[1].frames).toHaveLength(MAX_WEBSOCKET_FRAMES)

})

test('truncates large websocket frames', async () => {

  const { emit } = attach()
  await emit('Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2' })
  await emit('Network.webSocketFrameSent', frame('ws', 'a'.repeat(MAX_FRAME_PAYLOAD_LENGTH)))
  await emit('Network.webSocketFrameReceived', frame('ws', 'b'.repeat(MAX_FRAME_PAYLOAD_LENGTH + 1000)))
  await emit('Network.webSocketFrameReceived', { requestId: 'ws', timestamp: 3, response: { opcode: 2, mask: false } })

  const frames = getNetworkHistory()[0].frames
  expect(frames[0].payloadData).toBe('a'.repeat(MAX_FRAME_PAYLOAD_LENGTH))
  expect(frames[0].payloadLength).toBe(MAX_FRAME_PAYLOAD_LENGTH)
  expect(frames[1].payloadData).toBe(`${'b'.repeat(MAX_FRAME_PAYLOAD_LENGTH)}\n*** truncated: 1000 more characters ***`)
  expect(frames[1].payloadLength).toBe(MAX_FRAME_PAYLOAD_LENGTH + 1000)
  expect(frames[2].payloadData).toBeUndefined()
  expect(frames[2].payloadLength).toBe(0)

})

test('truncates large request bodies', async () => {

  const { emit } = attach()
  await emit('Network.requestWillBeSent', httpRequest('small', {}, 'https://api.example.com/v1/chat', 'x'.repeat(MAX_BODY_LENGTH)))
  await emit('Network.requestWillBeSent', httpRequest('large', {}, 'https://api.example.com/v1/chat', 'x'.repeat(MAX_BODY_LENGTH + 5)))
  await emit('Network.requestWillBeSent', { requestId: 'none', request: { url: 'https://api.example.com/v1/models', method: 'GET', headers: {} } })

  const [small, large, none] = getNetworkHistory()
  expect(small.postData).toBe('x'.repeat(MAX_BODY_LENGTH))
  expect(large.postData).toBe(`${'x'.repeat(MAX_BODY_LENGTH)}\n*** truncated: 5 more characters ***`)
  expect(none.postData).toBeUndefined()

})

test('evicts the oldest requests of a window above the limit', async () => {

  const first = attach()
  const second = attach()

  await second.emit('Network.requestWillBeSent', httpRequest('other-window'))
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW + 10; i++) {
    await first.emit('Network.requestWillBeSent', httpRequest(`r${i}`))
  }

  const ids = getNetworkHistory().map((request) => request.id)
  expect(ids).toHaveLength(MAX_REQUESTS_PER_WINDOW + 1)
  expect(ids).toContain('other-window')
  expect(ids).not.toContain('r9')
  expect(ids).toContain('r10')
  expect(ids).toContain(`r${MAX_REQUESTS_PER_WINDOW + 9}`)

  // events of an evicted request are ignored
  await first.emit('Network.responseReceived', { requestId: 'r0', response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/plain' } })
  await first.emit('Network.loadingFinished', { requestId: 'r0' })
  expect(getNetworkHistory()).toHaveLength(MAX_REQUESTS_PER_WINDOW + 1)

})

test('the limit still holds after the history was cleared', async () => {
  const { emit } = attach()
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
    await emit('Network.requestWillBeSent', httpRequest(`before${i}`))
  }
  clearNetworkHistory()
  expect(getNetworkHistory()).toHaveLength(0)
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW + 1; i++) {
    await emit('Network.requestWillBeSent', httpRequest(`after${i}`))
  }
  expect(getNetworkHistory()).toHaveLength(MAX_REQUESTS_PER_WINDOW)
  expect(getNetworkHistory()[0].id).toBe('after1')
})

test('drops the requests of a window when it is closed', async () => {

  const first = attach()
  const second = attach()

  await first.emit('Network.requestWillBeSent', httpRequest('in-flight'))
  await first.emit('Network.requestWillBeSent', httpRequest('done'))
  await first.emit('Network.loadingFinished', { requestId: 'done' })
  await first.emit('Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2' })
  await second.emit('Network.requestWillBeSent', httpRequest('other-window'))
  expect(getNetworkHistory()).toHaveLength(4)

  first.close()

  expect(getNetworkHistory().map((request) => request.id)).toStrictEqual(['other-window'])
  expect(first.window.webContents.debugger.detach).toHaveBeenCalledTimes(1)

  second.close()
  expect(getNetworkHistory()).toHaveLength(0)

})

test('drops the requests of a window when its debugger is detached', async () => {

  const first = attach()
  const second = attach()

  await first.emit('Network.requestWillBeSent', httpRequest('in-flight'))
  await second.emit('Network.requestWillBeSent', httpRequest('other-window'))

  first.detach({}, 'target closed')

  expect(getNetworkHistory().map((request) => request.id)).toStrictEqual(['other-window'])

})

test('evicts finished and failed requests after the retention time', async () => {

  vi.useFakeTimers()
  const { emit } = attach()

  await emit('Network.requestWillBeSent', httpRequest('finished'))
  await emit('Network.loadingFinished', { requestId: 'finished' })
  await emit('Network.requestWillBeSent', httpRequest('failed'))
  await emit('Network.loadingFailed', { requestId: 'failed', errorText: 'net::ERR_FAILED' })
  await emit('Network.webSocketCreated', { requestId: 'ws-closed', url: 'wss://rt.example.com/v2' })
  await emit('Network.webSocketClosed', { requestId: 'ws-closed' })
  await emit('Network.webSocketCreated', { requestId: 'ws-error', url: 'wss://rt.example.com/v2' })
  await emit('Network.webSocketFrameError', { requestId: 'ws-error', errorMessage: 'connection reset' })
  await emit('Network.requestWillBeSent', httpRequest('in-flight'))
  expect(getNetworkHistory()).toHaveLength(5)

  vi.advanceTimersByTime(10 * 60 * 1000 + 1)
  expect(getNetworkHistory().map((request) => request.id)).toStrictEqual(['in-flight'])

})

test('a request that reuses an id is not evicted by the timer of the previous one', async () => {

  vi.useFakeTimers()
  const { emit } = attach()

  await emit('Network.requestWillBeSent', httpRequest('1'))
  await emit('Network.loadingFinished', { requestId: '1' })
  vi.advanceTimersByTime(60 * 1000)
  clearNetworkHistory()
  await emit('Network.requestWillBeSent', httpRequest('1'))

  vi.advanceTimersByTime(10 * 60 * 1000 - 60 * 1000 + 1)
  expect(getNetworkHistory()).toHaveLength(1)

})
