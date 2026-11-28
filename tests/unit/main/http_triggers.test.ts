import { vi, beforeEach, afterEach, expect, test, describe } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { App } from 'electron'
import { HttpServer } from '@main/http_server'
import { installHttpTriggers } from '@main/http_triggers'
import * as window from '@main/window'
import * as config from '@main/config'
import PromptAnywhere from '@main/automations/anywhere'
import Commander from '@main/automations/commander'
import ReadAloud from '@main/automations/readaloud'
import Dictation from '@main/automations/dictation'

// Mock window module
vi.mock('@main/window', () => ({
  openMainWindow: vi.fn(),
  openSettingsWindow: vi.fn(),
  openDesignStudioWindow: vi.fn(),
  openAgentForgeWindow: vi.fn(),
  openRealtimeChatWindow: vi.fn(),
  openPromptAnywhere: vi.fn().mockResolvedValue(undefined),
  openCommandPicker: vi.fn(),
}))

// Mock config module
vi.mock('@main/config', () => ({
  loadSettings: vi.fn().mockReturnValue({
    general: {
      enableHttpEndpoints: true
    }
  })
}))

// Mock automation modules
vi.mock('@main/automations/anywhere', () => ({
  default: {
    open: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@main/automations/commander', () => ({
  default: {
    initCommand: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@main/automations/readaloud', () => ({
  default: {
    read: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@main/automations/dictation', () => ({
  default: {
    initDictation: vi.fn().mockResolvedValue(undefined),
  },
}))

// what a local client sends: a POST, with an optional body
const postRequest = (body?: string, contentType = 'application/json') => {
  const req: any = { method: 'POST', headers: body === undefined ? {} : { 'content-type': contentType } }
  req.on = vi.fn((event: string, callback: (chunk?: Buffer) => void) => {
    if (event === 'data' && body !== undefined) callback(Buffer.from(body))
    if (event === 'end') callback()
    return req
  })
  return req as IncomingMessage
}

describe('HTTP Triggers', () => {
  let httpServer: HttpServer
  let mockRegister: any
  let mockApp: App

  beforeEach(() => {
    // Get fresh instance
    httpServer = HttpServer.getInstance()

    // Mock the register method
    mockRegister = vi.fn()
    httpServer.register = mockRegister

    // Mock app
    mockApp = {} as App
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('should install all endpoints', () => {
    installHttpTriggers(httpServer, mockApp)

    expect(mockRegister).toHaveBeenCalledWith('/api/health', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/chat', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/scratchpad', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/settings', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/studio', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/forge', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/realtime', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/prompt', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/command', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/transcribe', expect.any(Function))
    expect(mockRegister).toHaveBeenCalledWith('/api/readaloud', expect.any(Function))
  })

  test('health endpoint should return ok status', async () => {
    installHttpTriggers(httpServer, mockApp)

    const healthHandler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/health'
    )?.[1]

    const mockReq = {} as IncomingMessage
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await healthHandler(mockReq, mockRes, new URL('http://localhost:8090/api/health'))

    expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
    expect(mockRes.end).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'ok',
        server: 'witsy-http-triggers',
        version: '1.0.0'
      })
    )
  })

  test('chat endpoint should open main window with chat view', async () => {
    installHttpTriggers(httpServer, mockApp)

    const chatHandler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/chat'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await chatHandler(mockReq, mockRes, new URL('http://localhost:8090/api/chat'))

    expect(window.openMainWindow).toHaveBeenCalledWith({ queryParams: { view: 'chat' } })
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'chat' }))
  })

  test('scratchpad endpoint should open main window with scratchpad view', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/scratchpad'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/scratchpad'))

    expect(window.openMainWindow).toHaveBeenCalledWith({ queryParams: { view: 'scratchpad' } })
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'scratchpad' }))
  })

  test('endpoints should return 404 when disabled', async () => {
    // Mock config with disabled endpoints
    vi.mocked(config.loadSettings).mockReturnValueOnce({
      general: {
        enableHttpEndpoints: false
      }
    } as any)

    installHttpTriggers(httpServer, mockApp)

    const healthHandler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/health'
    )?.[1]

    const mockReq = {} as IncomingMessage
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await healthHandler(mockReq, mockRes, new URL('http://localhost:8090/api/health'))

    expect(mockRes.writeHead).toHaveBeenCalledWith(404)
    expect(mockRes.end).toHaveBeenCalled()
  })

  test('settings endpoint should open settings window', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/settings'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/settings'))

    expect(window.openSettingsWindow).toHaveBeenCalled()
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'settings' }))
  })

  test('studio endpoint should open design studio window', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/studio'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/studio'))

    expect(window.openDesignStudioWindow).toHaveBeenCalled()
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'studio' }))
  })

  test('forge endpoint should open agent forge window', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/forge'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/forge'))

    expect(window.openAgentForgeWindow).toHaveBeenCalled()
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'forge' }))
  })

  test('realtime endpoint should open realtime chat window', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/realtime'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/realtime'))

    expect(window.openRealtimeChatWindow).toHaveBeenCalled()
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'realtime' }))
  })

  test('prompt endpoint should trigger PromptAnywhere', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/prompt'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/prompt'))

    expect(PromptAnywhere.open).toHaveBeenCalled()
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'prompt' }))
  })

  test('command endpoint should trigger Commander', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/command'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/command'))

    expect(Commander.initCommand).toHaveBeenCalledWith(mockApp)
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'command' }))
  })

  test('transcribe endpoint should trigger Dictation', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/transcribe'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/transcribe'))

    expect(Dictation.initDictation).toHaveBeenCalled()
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'transcribe' }))
  })

  test('readaloud endpoint should trigger ReadAloud', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/readaloud'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/readaloud'))

    expect(ReadAloud.read).toHaveBeenCalledWith(mockApp)
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true, action: 'readaloud' }))
  })

  test('chat endpoint should handle text parameter from query string', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/chat'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/chat?text=Hello%20World'))

    expect(window.openMainWindow).toHaveBeenCalledWith({
      queryParams: { view: 'chat', text: 'Hello World' }
    })
  })

  test('prompt endpoint should pass text parameter using promptId', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/prompt'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/prompt?text=Test'))

    expect(PromptAnywhere.open).not.toHaveBeenCalled()
    expect(window.openPromptAnywhere).toHaveBeenCalledWith({ promptId: expect.any(String) })
  })

  test('prompt endpoint without text should call PromptAnywhere.open', async () => {
    installHttpTriggers(httpServer, mockApp)

    const handler = mockRegister.mock.calls.find(
      (call: any) => call[0] === '/api/prompt'
    )?.[1]

    const mockReq = postRequest()
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse

    await handler(mockReq, mockRes, new URL('http://localhost:8090/api/prompt'))

    expect(PromptAnywhere.open).toHaveBeenCalled()
    expect(window.openPromptAnywhere).not.toHaveBeenCalled()
  })

  describe('state-changing endpoints require POST', () => {
    const kTriggers = ['/api/chat', '/api/scratchpad', '/api/settings', '/api/studio', '/api/forge', '/api/realtime', '/api/prompt', '/api/command', '/api/transcribe', '/api/readaloud']

    const sideEffects = () => [
      window.openMainWindow, window.openSettingsWindow, window.openDesignStudioWindow, window.openAgentForgeWindow,
      window.openRealtimeChatWindow, window.openPromptAnywhere, window.openCommandPicker,
      PromptAnywhere.open, Commander.initCommand, Dictation.initDictation, ReadAloud.read,
    ]

    const call = async (route: string, req: IncomingMessage, query = '') => {
      const handler = mockRegister.mock.calls.find((call: any) => call[0] === route)?.[1]
      const res: any = { writeHead: vi.fn(), end: vi.fn() }
      await handler(req, res, new URL(`http://localhost:8090${route}${query}`))
      return res
    }

    beforeEach(() => {
      installHttpTriggers(httpServer, mockApp)
    })

    test('the list covers every registered endpoint but the health check', () => {
      const registered = mockRegister.mock.calls.map((call: any) => call[0]).filter((route: string) => route !== '/api/health')
      expect(registered.sort()).toEqual([...kTriggers].sort())
    })

    test.each(kTriggers.flatMap((route) => ['GET', 'HEAD', 'PUT', 'DELETE'].map((method) => [method, route])))('%s %s answers 405 and does nothing', async (method, route) => {
      const res = await call(route, { method, headers: {}, on: vi.fn() } as any, '?text=injected')
      expect(res.writeHead).toHaveBeenCalledWith(405, { 'Content-Type': 'application/json', 'Allow': 'POST' })
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ success: false, error: expect.stringContaining('POST') })
      for (const sideEffect of sideEffects()) expect(sideEffect).not.toHaveBeenCalled()
    })

    test.each(kTriggers)('POST %s triggers the action', async (route) => {
      const res = await call(route, postRequest())
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ success: true, action: route.split('/').pop() })
      expect(sideEffects().filter((sideEffect) => vi.mocked(sideEffect).mock.calls.length > 0)).toHaveLength(1)
    })

    test('POST reads its parameters from a JSON body', async () => {
      await call('/api/chat', postRequest(JSON.stringify({ text: 'Hello World' })))
      expect(window.openMainWindow).toHaveBeenCalledWith({ queryParams: { view: 'chat', text: 'Hello World' } })
    })

    test.each(['text/plain', 'text/plain;application/json', 'application/x-www-form-urlencoded'])('POST with a %s body answers 415 and does nothing', async (contentType) => {
      const res = await call('/api/chat', postRequest('{"text":"injected"}', contentType))
      expect(res.writeHead).toHaveBeenCalledWith(415, { 'Content-Type': 'application/json' })
      for (const sideEffect of sideEffects()) expect(sideEffect).not.toHaveBeenCalled()
    })

    test('GET /api/health stays available', async () => {
      const res = await call('/api/health', { method: 'GET', headers: {} } as any)
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
    })

    test.each(kTriggers)('GET %s answers 404 when endpoints are disabled', async (route) => {
      vi.mocked(config.loadSettings).mockReturnValueOnce({ general: { enableHttpEndpoints: false } } as any)
      const res = await call(route, { method: 'GET', headers: {}, on: vi.fn() } as any)
      expect(res.writeHead).toHaveBeenCalledWith(404)
    })
  })
})
