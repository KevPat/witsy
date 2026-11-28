import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WitsyAPI } from '@/cli/api'
import { state } from '@/cli/state'

// Setup fetch mock
global.fetch = vi.fn()

describe('WitsyAPI', () => {
  let api: WitsyAPI

  beforeEach(() => {
    api = new WitsyAPI()
    state.port = 4321
    state.engine = { id: 'openai', name: 'OpenAI' }
    state.model = { id: 'gpt-4', name: 'GPT-4' }
    state.userDataPath = ''
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('getConfig makes correct API call', async () => {
    const mockResponse = {
      engine: { id: 'openai', name: 'OpenAI' },
      model: { id: 'gpt-4', name: 'GPT-4' },
      userDataPath: '/path/to/userData',
      enableHttpEndpoints: true
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response)

    const result = await api.getConfig()

    expect(fetch).toHaveBeenCalledWith('http://localhost:4321/api/cli/config')
    expect(result).toEqual(mockResponse)
  })

  test('getEngines makes correct API call', async () => {
    const mockResponse = {
      engines: [
        { id: 'openai', name: 'OpenAI' },
        { id: 'anthropic', name: 'Anthropic' },
      ],
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response)

    const result = await api.getEngines()

    expect(fetch).toHaveBeenCalledWith('http://localhost:4321/api/engines', {})
    expect(result).toEqual(mockResponse.engines)
  })

  test('getModels makes correct API call', async () => {
    const mockResponse = {
      models: [
        { id: 'gpt-4', name: 'GPT-4' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
      ],
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response)

    const result = await api.getModels('openai')

    expect(fetch).toHaveBeenCalledWith('http://localhost:4321/api/models/openai', {})
    expect(result).toEqual(mockResponse.models)
  })

  test('handles HTTP errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response)

    await expect(api.getConfig()).rejects.toThrow('HTTP 404')
  })

  test('connectWithTimeout returns true on successful connection', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
    } as Response)

    const result = await api.connectWithTimeout(4321, 2000)
    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledWith('http://localhost:4321/api/cli/config', expect.any(Object))
  })

  test('connectWithTimeout returns false on timeout', async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
    )

    const result = await api.connectWithTimeout(4321, 50)
    expect(result).toBe(false)
  })

  test('connectWithTimeout returns false on network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

    const result = await api.connectWithTimeout(4321, 2000)
    expect(result).toBe(false)
  })

  test('complete streams response chunks', async () => {
    const chunks: string[] = []
    const mockChunks = [
      'data: {"type":"content","text":"Hello"}\n',
      'data: {"type":"content","text":" world"}\n',
      'data: [DONE]\n'
    ]

    // Mock ReadableStream
    const encoder = new TextEncoder()
    let chunkIndex = 0

    const mockReader = {
      read: vi.fn(async () => {
        if (chunkIndex < mockChunks.length) {
          const value = encoder.encode(mockChunks[chunkIndex++])
          return { value, done: false }
        }
        return { value: undefined, done: true }
      })
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => mockReader
      } as any
    } as Response)

    await api.complete(
      [{ role: 'user', content: 'test' }],
      (payload) => chunks.push(payload)
    )

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('{"type":"content","text":"Hello"}')
    expect(chunks[1]).toBe('{"type":"content","text":" world"}')
  })

  test('complete handles abort signal', async () => {
    const controller = new AbortController()

    vi.mocked(fetch).mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))

    controller.abort()

    await expect(
      api.complete(
        [{ role: 'user', content: 'test' }],
        () => {},
        controller.signal
      )
    ).rejects.toThrow()
  })

  test('complete throws on missing response body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      body: null
    } as Response)

    await expect(
      api.complete([{ role: 'user', content: 'test' }], () => {})
    ).rejects.toThrow('No response body')
  })

  test('saveConversation makes correct API call', async () => {
    const mockChat = {
      uuid: 'test-uuid',
      title: 'Test Chat',
      messages: []
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chatId: 'new-chat-id' })
    } as Response)

    const result = await api.saveConversation(mockChat as any)

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:4321/api/conversations',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: mockChat })
      })
    )
    expect(result).toBe('new-chat-id')
  })

  test('saveConversation handles errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500
    } as Response)

    await expect(
      api.saveConversation({} as any)
    ).rejects.toThrow('HTTP 500')
  })

  describe('API token', () => {
    const kToken = 'a'.repeat(64)
    const kNextToken = 'b'.repeat(64)

    const writeToken = (token: string) => fs.writeFileSync(path.join(state.userDataPath, 'http-api-token'), token)
    const sentHeaders = (call = 0) => (vi.mocked(fetch).mock.calls[call][1] as any)?.headers
    const streamOf = (lines: string[]) => {
      const encoder = new TextEncoder()
      let index = 0
      return { getReader: () => ({ read: async () => index < lines.length ? { value: encoder.encode(lines[index++]), done: false } : { value: undefined, done: true } }) } as any
    }

    beforeEach(() => {
      state.userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-cli-api-'))
      state.workDir = { path: '/some/project', access: 'rw' }
      writeToken(kToken)
    })

    afterEach(() => {
      fs.rmSync(state.userDataPath, { recursive: true, force: true })
      state.userDataPath = ''
      state.workDir = { path: null, access: 'none' }
    })

    test('complete sends the token of the app with the work directory', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: streamOf(['data: [DONE]\n']) } as Response)

      await api.complete([{ role: 'user', content: 'test' }], () => {})

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:4321/api/complete')
      expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${kToken}` })
      expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body).workDir).toEqual({ path: '/some/project', access: 'rw' })
    })

    test('the other calls made once connected send the token too', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ engines: [], models: [], chatId: 'id' }) } as Response)

      await api.getEngines()
      await api.getModels('openai')
      await api.saveConversation({} as any)

      expect(sentHeaders(0)).toEqual({ Authorization: `Bearer ${kToken}` })
      expect(sentHeaders(1)).toEqual({ Authorization: `Bearer ${kToken}` })
      expect(sentHeaders(2)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${kToken}` })
    })

    test('the calls that discover the app never send the token', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response)

      await api.connectWithTimeout(5000, 2000)
      await api.getConfig()

      expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(kToken)
    })

    test('reads the token again and retries once when the app restarted', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ engines: [] }) } as Response)
      await api.getEngines()

      // the app restarted: new token in the file, the one in memory is refused
      writeToken(kNextToken)
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamOf(['data: {"type":"content","text":"Hi"}\n', 'data: [DONE]\n']) } as Response)

      const chunks: string[] = []
      await api.complete([{ role: 'user', content: 'test' }], (payload) => chunks.push(payload))

      expect(fetch).toHaveBeenCalledTimes(3)
      expect(sentHeaders(1).Authorization).toBe(`Bearer ${kToken}`)
      expect(sentHeaders(2).Authorization).toBe(`Bearer ${kNextToken}`)
      expect((vi.mocked(fetch).mock.calls[2][1] as any).body).toBe((vi.mocked(fetch).mock.calls[1][1] as any).body)
      expect(chunks).toEqual(['{"type":"content","text":"Hi"}'])

      // the new token is remembered
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ engines: [] }) } as Response)
      await api.getEngines()
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(sentHeaders(3).Authorization).toBe(`Bearer ${kNextToken}`)
    })

    test.each([401, 403])('does not retry a %i when the token did not change', async (status) => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status } as Response)

      await expect(api.complete([{ role: 'user', content: 'test' }], () => {})).rejects.toThrow(`HTTP ${status}`)
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    test('retries only once', async () => {
      vi.mocked(fetch).mockImplementation(async () => {
        writeToken(`token-${vi.mocked(fetch).mock.calls.length}`)
        return { ok: false, status: 403 } as Response
      })

      await expect(api.complete([{ role: 'user', content: 'test' }], () => {})).rejects.toThrow('HTTP 403')
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    test('sends no Authorization header when the token file is missing', async () => {
      fs.rmSync(path.join(state.userDataPath, 'http-api-token'))
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: streamOf(['data: [DONE]\n']) } as Response)

      await api.complete([{ role: 'user', content: 'test' }], () => {})

      expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })
    })
  })
})
