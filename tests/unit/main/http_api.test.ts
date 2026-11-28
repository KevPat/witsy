import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IncomingMessage } from 'http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installApiEndpoints } from '@main/http_api'
import { loadApiToken } from '@/cli/config'
import { HttpServer } from '@main/http_server'
import LlmFactory from '@services/llms/llm'
import AssistantApi from '@main/assistant_api'
import * as config from '@main/config'
import { App } from 'electron'
import Mcp from '@main/mcp'

type RouteHandler = (req: IncomingMessage, res: any, parsedUrl?: URL) => Promise<void> | void

vi.mock('@main/config')
vi.mock('@main/assistant_api')

vi.mock('@services/llms/llm', () => ({
  default: {
    manager: vi.fn()
  }
}))

describe('HTTP API Endpoints', () => {
  let httpServer: HttpServer
  let mockApp: App
  let mockMcp: Mcp
  let mockDocRepo: any
  let mockSettings: any
  let mockLlmManager: any
  let registeredRoutes: Map<string, RouteHandler>
  let userDataPath: string

  beforeEach(() => {
    registeredRoutes = new Map()
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-http-api-'))

    httpServer = {
      register: vi.fn((path: string, handler: RouteHandler) => {
        registeredRoutes.set(path, handler)
      })
    } as any

    mockApp = {
      getPath: vi.fn(() => userDataPath)
    } as any
    mockMcp = {} as Mcp
    mockDocRepo = {} as any

    mockSettings = {
      general: {
        enableHttpEndpoints: true
      },
      llm: { engine: 'openai' },
      engines: {
        openai: { model: { chat: 'gpt-4' }, models: { chat: [] } },
        anthropic: { model: { chat: 'claude-3' }, models: { chat: [] } }
      },
      workspaceId: 'test-workspace'
    }

    mockLlmManager = {
      getChatEngines: vi.fn(() => ['openai', 'anthropic']),
      isEngineConfigured: vi.fn(() => true),
      getChatModels: vi.fn(() => [
        { id: 'gpt-4', name: 'GPT-4' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
      ])
    }

    vi.mocked(config.loadSettings).mockReturnValue(mockSettings)
    vi.mocked(LlmFactory.manager).mockReturnValue(mockLlmManager)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    fs.rmSync(userDataPath, { recursive: true, force: true })
  })

  describe('GET /api/cli/config', () => {
    test('returns CLI configuration', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/cli/config')
      expect(handler).toBeDefined()

      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      const response = JSON.parse(mockRes.end.mock.calls[0][0])
      expect(response.engine).toEqual({ id: 'openai', name: 'OpenAI' })
      expect(response.model).toEqual({ id: 'gpt-4', name: 'GPT-4' })
      expect(response.userDataPath).toBe(userDataPath)
      expect(response.enableHttpEndpoints).toBe(true)
    })

    test('returns unknown model name when model not found', async () => {
      mockSettings.engines.openai.model.chat = 'unknown-model'

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/cli/config')
      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      const response = JSON.parse(mockRes.end.mock.calls[0][0])
      expect(response.model.id).toBe('unknown-model')
      expect(response.model.name).toBe('unknown-model')
    })

    test('handles error gracefully', async () => {
      vi.mocked(config.loadSettings).mockImplementation(() => {
        throw new Error('Config error')
      })

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/cli/config')
      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' })
    })
  })

  describe('HTTP Endpoints Disabled', () => {
    test('should return 404 when endpoints are disabled', async () => {
      const disabledSettings = {
        ...mockSettings,
        general: {
          enableHttpEndpoints: false
        }
      }
      vi.mocked(config.loadSettings).mockReturnValueOnce(disabledSettings)

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/engines')
      expect(handler).toBeDefined()

      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(404)
      expect(mockRes.end).toHaveBeenCalled()
    })
  })

  describe('GET /api/engines', () => {
    test('returns list of configured engines', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/engines')
      expect(handler).toBeDefined()

      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      const response = JSON.parse(mockRes.end.mock.calls[0][0])
      expect(response.engines).toHaveLength(2)
      expect(response.engines[0]).toEqual({ id: 'openai', name: 'OpenAI' })
      expect(response.engines[1]).toEqual({ id: 'anthropic', name: 'Anthropic' })
    })

    test('filters out non-configured engines', async () => {
      mockLlmManager.isEngineConfigured = vi.fn((engine: string) => engine === 'openai')

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/engines')
      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      const response = JSON.parse(mockRes.end.mock.calls[0][0])
      expect(response.engines).toHaveLength(1)
      expect(response.engines[0].id).toBe('openai')
    })

    test('handles error gracefully', async () => {
      mockLlmManager.getChatEngines = vi.fn(() => {
        throw new Error('Engine error')
      })

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/engines')
      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any

      await handler!(mockReq, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' })
    })
  })

  describe('GET /api/models/:engine', () => {
    test('returns models for valid engine', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/models/*')
      expect(handler).toBeDefined()

      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/models/openai')

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      const response = JSON.parse(mockRes.end.mock.calls[0][0])
      expect(response.engine).toBe('openai')
      expect(response.models).toHaveLength(2)
      expect(response.models[0]).toEqual({ id: 'gpt-4', name: 'GPT-4' })
    })

    test('returns 404 for non-configured engine', async () => {
      mockLlmManager.isEngineConfigured = vi.fn(() => false)

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/models/*')
      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/models/invalid')

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' })
    })

    test('returns 400 for missing engine parameter', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/models/*')
      const mockReq = {} as IncomingMessage
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/models/')

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' })
    })
  })

  describe('POST /api/complete', () => {
    let mockAssistantApi: any

    beforeEach(() => {
      mockAssistantApi = {
        initializeChat: vi.fn(),
        addMessages: vi.fn(),
        prompt: vi.fn(),
        getLastMessage: vi.fn(() => ({ content: 'Test response' }))
      }
      vi.mocked(AssistantApi).mockImplementation(() => mockAssistantApi)
    })

    test('handles non-streaming completion', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/complete')
      expect(handler).toBeDefined()

      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(JSON.stringify({
              stream: 'false',
              thread: [{ role: 'user', content: 'Hello' }]
            })))
          }
          if (event === 'end') callback()
        })
      } as any
      const mockRes = {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/complete')

      // Mock getLastMessage to return our test response
      mockAssistantApi.getLastMessage.mockReturnValue({ content: 'Hello! How are you?' })

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      const response = JSON.parse(mockRes.end.mock.calls[0][0])
      expect(response.success).toBe(true)
      expect(response.response.content).toBe('Hello! How are you?')
    })

    test('handles streaming completion with SSE', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/complete')

      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(JSON.stringify({
              stream: 'true',
              thread: [{ role: 'user', content: 'Hello' }]
            })))
          }
          if (event === 'end') callback()
        })
      } as any
      const mockRes = {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/complete')

      mockAssistantApi.prompt.mockImplementation(async (_prompt: string, _opts: any, callback: (chunk: any) => void) => {
        callback({ type: 'content', text: 'Hello!', done: false })
      })

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('data:'))
      expect(mockRes.write).toHaveBeenCalledWith('data: [DONE]\n\n')
    })

    test('uses default engine and model when not specified', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/complete')

      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(JSON.stringify({
              thread: [{ role: 'user', content: 'Hello' }]
            })))
          }
          if (event === 'end') callback()
        })
      } as any
      const mockRes = {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/complete')

      mockAssistantApi.prompt.mockImplementation(async (_prompt: string, opts: any, callback: (chunk: any) => void) => {
        expect(opts.engine).toBe('openai')
        expect(opts.model).toBe('gpt-4')
        callback({ type: 'content', text: 'test', done: true })
      })

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockAssistantApi.prompt).toHaveBeenCalled()
    })

    test('passes noMarkdown parameter to assistant', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/complete')

      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(JSON.stringify({
              stream: 'false',
              noMarkdown: true,
              thread: [{ role: 'user', content: 'Hello' }]
            })))
          }
          if (event === 'end') callback()
        })
      } as any
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/complete')

      await handler!(mockReq, mockRes, mockUrl)

      // Verify that prompt was called with noMarkdown option
      expect(mockAssistantApi.prompt).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          noMarkdown: true
        }),
        expect.any(Function)
      )
    })

    test('returns 400 for missing thread', async () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/complete')

      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(JSON.stringify({ stream: 'false' })))
          }
          if (event === 'end') callback()
        })
      } as any
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/complete')

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' })
    })

    test('returns 404 for non-configured engine', async () => {
      mockLlmManager.isEngineConfigured = vi.fn(() => false)

      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)

      const handler = registeredRoutes.get('/api/complete')

      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(JSON.stringify({
              engine: 'invalid',
              thread: [{ role: 'user', content: 'Hello' }]
            })))
          }
          if (event === 'end') callback()
        })
      } as any
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn()
      } as any
      const mockUrl = new URL('http://localhost/api/complete')

      await handler!(mockReq, mockRes, mockUrl)

      expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' })
    })
  })

  describe('API token', () => {
    const tokenFile = () => path.join(userDataPath, 'http-api-token')

    test('writes a new token to the user data folder each time the endpoints are installed', () => {
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
      const first = fs.readFileSync(tokenFile(), 'utf-8')
      expect(first).toMatch(/^[0-9a-f]{64}$/)

      registeredRoutes.clear()
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
      const second = fs.readFileSync(tokenFile(), 'utf-8')
      expect(second).toMatch(/^[0-9a-f]{64}$/)
      expect(second).not.toBe(first)
    })

    test.skipIf(process.platform === 'win32')('the token file is readable by its owner only, even when a wider one existed', () => {
      fs.writeFileSync(tokenFile(), 'stale', { mode: 0o644 })
      fs.chmodSync(tokenFile(), 0o644)
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
      expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(tokenFile(), 'utf-8')).not.toBe('stale')
    })

    test('never logs the token', () => {
      const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')]
      logs.forEach((log) => log.mockImplementation(() => {}))
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
      const token = fs.readFileSync(tokenFile(), 'utf-8')
      const logged = logs.flatMap((log) => log.mock.calls).map((args) => args.map(String).join(' ')).join('\n')
      expect(logged).not.toContain(token)
    })

    test('tolerates a token file that cannot be written and logs no token', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const writable = userDataPath
      userDataPath = path.join(writable, 'missing', 'folder')
      expect(() => installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)).not.toThrow()
      userDataPath = writable
      expect(registeredRoutes.has('/api/complete')).toBe(true)
      expect(fs.existsSync(tokenFile())).toBe(false)
      const logged = error.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
      expect(logged).toContain('API token file')
      expect(logged).not.toMatch(/[0-9a-f]{64}/)
    })
  })

  describe('POST /api/complete with a work directory', () => {
    const workDir = { path: '/some/project', access: 'rw' }

    const complete = async (headers: Record<string, string>, body: object) => {
      const payload = JSON.stringify({ stream: 'false', thread: [{ role: 'user', content: 'Hello' }], ...body })
      const mockReq = {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        on: vi.fn((event, callback) => {
          if (event === 'data') callback(Buffer.from(payload))
          if (event === 'end') callback()
        })
      } as any
      const mockRes = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() } as any
      await registeredRoutes.get('/api/complete')!(mockReq, mockRes, new URL('http://localhost/api/complete'))
      return mockRes
    }

    const readToken = () => fs.readFileSync(path.join(userDataPath, 'http-api-token'), 'utf-8')

    beforeEach(() => {
      vi.mocked(AssistantApi).mockImplementation(() => ({
        initializeChat: vi.fn(),
        addMessages: vi.fn(),
        prompt: vi.fn(),
        getLastMessage: vi.fn(() => ({ content: 'Test response' }))
      }) as any)
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
    })

    test('is refused without the API token', async () => {
      const res = await complete({}, { workDir })
      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' })
      const response = JSON.parse(res.end.mock.calls[0][0])
      expect(response.success).toBe(false)
      expect(response.error).toContain('workDir requires the API token')
      expect(AssistantApi).not.toHaveBeenCalled()
    })

    test.each([
      ['a wrong token', () => `Bearer ${'0'.repeat(64)}`],
      ['a token of another length', () => 'Bearer abc'],
      ['a prefix of the token', () => `Bearer ${readToken().slice(0, 32)}`],
      ['the token without the Bearer scheme', () => readToken()],
      ['another scheme', () => `Basic ${readToken()}`],
      ['an empty bearer', () => 'Bearer '],
    ])('is refused with %s', async (_, authorization) => {
      const res = await complete({ authorization: authorization() }, { workDir })
      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' })
      expect(AssistantApi).not.toHaveBeenCalled()
    })

    test('is refused with the token of a previous session', async () => {
      const previous = readToken()
      registeredRoutes.clear()
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
      const res = await complete({ authorization: `Bearer ${previous}` }, { workDir })
      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' })
      expect(AssistantApi).not.toHaveBeenCalled()
    })

    test('is honoured with the API token', async () => {
      const res = await complete({ authorization: `Bearer ${readToken()}` }, { workDir })
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      expect(vi.mocked(AssistantApi).mock.calls[0][1]).toEqual(workDir)
    })

    test('is honoured with the token the CLI reads from the user data folder', async () => {
      const res = await complete({ authorization: `Bearer ${loadApiToken(userDataPath)}` }, { workDir: { path: '/some/project', access: 'ro' } })
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      expect(vi.mocked(AssistantApi).mock.calls[0][1]).toEqual({ path: '/some/project', access: 'ro' })
    })

    test('is refused when the token file could not be written', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const writable = userDataPath
      userDataPath = path.join(writable, 'missing')
      registeredRoutes.clear()
      installApiEndpoints(httpServer, mockApp, mockMcp, mockDocRepo)
      userDataPath = writable
      const res = await complete({ authorization: `Bearer ${readToken()}` }, { workDir })
      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' })
      expect(AssistantApi).not.toHaveBeenCalled()
    })

    test.each([
      ['no work directory', {}],
      ['a work directory without access', { workDir: { path: '/some/project', access: 'none' } }],
      ['a work directory without path', { workDir: { path: null, access: 'rw' } }],
    ])('needs no token with %s and gives the assistant no work directory', async (_, body) => {
      const res = await complete({}, body)
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      expect(vi.mocked(AssistantApi).mock.calls[0][1]).toBeNull()
    })

    test.each([
      'text/plain;application/json',
      'text/plain; charset=application/json',
      'text/plain',
      'application/x-www-form-urlencoded',
    ])('answers 415 to a body sent as %s', async (contentType) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await complete({ 'content-type': contentType, authorization: `Bearer ${readToken()}` }, { workDir })
      expect(res.writeHead).toHaveBeenCalledWith(415, { 'Content-Type': 'application/json' })
      expect(AssistantApi).not.toHaveBeenCalled()
    })
  })
})
