
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { debugWindow } from '@main/windows/debug'
import interceptNetwork, { clearNetworkHistory, getNetworkHistory } from '@main/network'
import { bug } from './bug'

global.MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://localhost:3000/'

vi.mock('electron', () => {
  const BrowserWindow = vi.fn(function(this: any) {
    this.webContents = {
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(async (command: string) => {
          if (command === 'Network.getResponseBody') {
            return { body: 'response', base64Encoded: false }
          }
        }),
        on: vi.fn(),
      }
    }
    this.on = vi.fn()
  })
  return { BrowserWindow }
})

vi.mock('@main/windows/debug.ts', () => {
  return { debugWindow: { webContents: { send: vi.fn() } } }
})

vi.mock('@main/http_server', () => ({
  HttpServer: { getInstance: () => ({ getPort: () => 8090 }) }
}))

type Handler = (event: any, method: string, params: any) => Promise<void>

const attach = (): { window: any, emit: Handler, close: () => void } => {
  const window: any = new BrowserWindow()
  interceptNetwork(window)
  const emit = window.webContents.debugger.on.mock.calls[0][1]
  const close = () => window.on.mock.calls.find((call: any[]) => call[0] === 'closed')[1]()
  return { window, emit, close }
}

const request = (requestId: string, headers: Record<string, string> = {}, url = 'https://api.example.com/v1/chat') => ({
  requestId, request: { url, method: 'POST', headers, postData: '{}' }
})

const TTL = 10 * 60 * 1000

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  clearNetworkHistory()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('network history', () => {

  test('stress: 2000 completed requests are all evicted after the retention time', async () => {
    const { emit } = attach()
    for (let i = 0; i < 2000; i++) {
      const id = `r${i}`
      await emit({}, 'Network.requestWillBeSent', request(id))
      await emit({}, 'Network.responseReceived', { requestId: id, response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' } })
      await emit({}, i % 2 ? 'Network.loadingFinished' : 'Network.loadingFailed', { requestId: id, errorText: 'net::ERR_FAILED' })
    }
    expect(getNetworkHistory()).toHaveLength(2000)
    vi.advanceTimersByTime(TTL + 1)
    expect(getNetworkHistory()).toHaveLength(0)
  })

  test('events for unknown requests and malformed events are ignored', async () => {
    const { emit } = attach()
    for (const method of ['Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Network.webSocketFrameSent',
      'Network.webSocketFrameReceived', 'Network.webSocketClosed', 'Network.webSocketFrameError', 'Network.webSocketHandshakeResponseReceived', 'Network.somethingElse']) {
      await expect(emit({}, method, { requestId: 'unknown' })).resolves.toBeUndefined()
    }
    await emit({}, 'Network.requestWillBeSent', request('data', {}, 'data:text/plain,hello'))
    await emit({}, 'Network.requestWillBeSent', request('dev', {}, 'http://localhost:3000/src/main.ts'))
    await emit({}, 'Network.requestWillBeSent', request('local', {}, 'http://localhost:8090/api'))
    expect(getNetworkHistory()).toHaveLength(0)
  })

  test('large response bodies are not kept', async () => {
    const { window, emit } = attach()
    window.webContents.debugger.sendCommand.mockResolvedValue({ body: 'x'.repeat(300 * 1024), base64Encoded: false })
    await emit({}, 'Network.requestWillBeSent', request('big'))
    await emit({}, 'Network.loadingFinished', { requestId: 'big' })
    expect(getNetworkHistory()[0].responseBody.length).toBeLessThan(1024)
  })

  bug('a websocket that failed is evicted after the retention time', async () => {
    // only the webSocketClosed handler schedules the cleanup
    const { emit } = attach()
    await emit({}, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2' })
    await emit({}, 'Network.webSocketFrameError', { requestId: 'ws', errorMessage: 'connection reset' })
    vi.advanceTimersByTime(TTL + 1)
    expect(getNetworkHistory()).toHaveLength(0)
  })

  bug('requests that were in flight when their window closed are evicted', async () => {
    // no loadingFinished/loadingFailed will ever arrive once the debugger is gone
    const { emit, close } = attach()
    for (let i = 0; i < 100; i++) await emit({}, 'Network.requestWillBeSent', request(`r${i}`))
    close()
    vi.advanceTimersByTime(TTL + 1)
    expect(getNetworkHistory()).toHaveLength(0)
  })

  bug('the frames kept for a long lived websocket are bounded', async () => {
    // realtime speech sessions send a frame per audio chunk: everything is kept until the socket closes
    const { emit } = attach()
    await emit({}, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2' })
    for (let i = 0; i < 20000; i++) {
      await emit({}, i % 2 ? 'Network.webSocketFrameSent' : 'Network.webSocketFrameReceived', { requestId: 'ws', timestamp: i, response: { opcode: 2, mask: true, payloadData: 'x'.repeat(64) } })
    }
    expect(getNetworkHistory()[0].frames.length).toBeLessThan(5000)
  })

  bug('a websocket frame does not resend the whole frame history to the debug window', async () => {
    // each frame sends the complete request, so a session costs O(n^2) serialization on the main thread
    const { emit } = attach()
    await emit({}, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://rt.example.com/v2' })
    for (let i = 0; i < 500; i++) {
      await emit({}, 'Network.webSocketFrameSent', { requestId: 'ws', timestamp: i, response: { opcode: 2, mask: true, payloadData: 'x'.repeat(64) } })
    }
    const last = vi.mocked(debugWindow.webContents.send).mock.lastCall![1]
    expect(JSON.stringify(last).length).toBeLessThan(64 * 100)
  })

})

describe('credential masking', () => {

  test('known credential headers are hidden whatever their case', async () => {
    const { emit } = attach()
    await emit({}, 'Network.requestWillBeSent', request('r', { AUTHORIZATION: 'Bearer secret', 'X-Api-Key': 'secret', 'x-goog-api-key': 'secret', accept: '*/*' }))
    const headers = getNetworkHistory()[0].headers
    expect(JSON.stringify(headers)).not.toContain('secret')
    expect(headers.accept).toBe('*/*')
  })

  bug.each([
    ['api-key'],                    // Azure OpenAI
    ['xi-api-key'],                 // ElevenLabs
    ['X-Subscription-Token'],       // Brave search
    ['Ocp-Apim-Subscription-Key'],  // Azure cognitive services
    ['Proxy-Authorization'],
    ['Cookie'],
  ])('the %s request header is hidden', async (header) => {
    const { emit } = attach()
    await emit({}, 'Network.requestWillBeSent', request('r', { [header]: 'secret-value' }))
    expect(JSON.stringify(getNetworkHistory()[0])).not.toContain('secret-value')
  })

  bug.each([
    ['https://generativelanguage.googleapis.com/v1beta/models?key=secret-value'],
    ['https://api.example.com/v1/search?q=cats&api_key=secret-value'],
    ['https://user:secret-value@api.example.com/v1/models'],
  ])('credentials carried by the url are hidden: %s', async (url) => {
    const { emit } = attach()
    await emit({}, 'Network.requestWillBeSent', request('r', {}, url))
    expect(JSON.stringify(getNetworkHistory()[0])).not.toContain('secret-value')
  })

  bug('a token in a websocket url is hidden', async () => {
    const { emit } = attach()
    await emit({}, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://eu2.rt.speechmatics.com/v2?jwt=secret-value' })
    expect(JSON.stringify(getNetworkHistory()[0])).not.toContain('secret-value')
  })

  bug('Set-Cookie response headers are hidden', async () => {
    const { emit } = attach()
    await emit({}, 'Network.requestWillBeSent', request('r'))
    await emit({}, 'Network.responseReceived', { requestId: 'r', response: { status: 200, statusText: 'OK', headers: { 'set-cookie': 'session=secret-value' }, mimeType: 'text/html' } })
    expect(JSON.stringify(getNetworkHistory()[0])).not.toContain('secret-value')
  })

})
