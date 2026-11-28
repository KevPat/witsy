import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { useWindowMock } from '@tests/mocks/window'
import { store } from '@services/store'
import VideoCreator from '@services/video'

const { generateVideos, getVideosOperation } = vi.hoisted(() => ({
  generateVideos: vi.fn(),
  getVideosOperation: vi.fn(),
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateVideos }
    operations = { getVideosOperation }
  },
  PersonGeneration: { ALLOW_ALL: 'ALLOW_ALL' },
}))

type LongTimer = { fn: () => void, cleared: boolean }

function trapLongTimers(): Map<number, LongTimer> {
  const realSetTimeout = global.setTimeout
  const realClearTimeout = global.clearTimeout
  const timers = new Map<number, LongTimer>()
  let nextId = 1
  vi.spyOn(global, 'setTimeout').mockImplementation((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const delay = typeof ms === 'number' ? ms : 0
    if (delay >= 1000) {
      const id = 1_000_000 + nextId++
      timers.set(id, {
        cleared: false,
        fn: () => {
          if (typeof fn === 'function') fn(...args)
        },
      })
      return id as unknown as ReturnType<typeof setTimeout>
    }
    return realSetTimeout(fn as TimerHandler, delay, ...(args as []))
  })
  vi.spyOn(global, 'clearTimeout').mockImplementation((id?: ReturnType<typeof setTimeout>) => {
    const timer = timers.get(id as unknown as number)
    if (timer) {
      timer.cleared = true
      timers.delete(id as unknown as number)
      return
    }
    realClearTimeout(id as ReturnType<typeof setTimeout>)
  })
  return timers
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  generateVideos.mockReset()
  getVideosOperation.mockReset()
})

test('cancel stops the openai poll without waiting out the status interval', async () => {
  store.config.engines.openai.apiKey = 'test-key'
  store.config.engines.openai.baseURL = 'https://api.openai.com'
  const timers = trapLongTimers()
  let statusCalls = 0
  const creator = new VideoCreator()
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const href = String(url)
    if (href === 'https://api.openai.com/v1/videos' && init?.method === 'POST') {
      expect(init.headers?.['Authorization']).toBe('Bearer test-key')
      return json({ id: 'vid_123', status: 'queued' })
    }
    if (href === 'https://api.openai.com/v1/videos/vid_123') {
      statusCalls += 1
      expect(init?.headers?.['Authorization']).toBe('Bearer test-key')
      return json({ id: 'vid_123', status: 'in_progress', progress: 10 })
    }
    throw new Error(`unexpected ${href}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const pending = creator.execute('openai', 'sora-2', { prompt: 'a cat' })
  await vi.waitUntil(() => timers.size === 1)
  expect(statusCalls).toBe(0)
  const first = [...timers.values()][0]
  first.fn()
  await vi.waitUntil(() => statusCalls === 1 && timers.size >= 1)
  creator.cancel()
  const result = await pending

  expect(result).toEqual({ cancelled: true, error: 'cancelled' })
  expect(statusCalls).toBe(1)
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
  const hosts = fetchMock.mock.calls.map((call) => new URL(String(call[0])).host)
  expect(hosts.every((host) => host === 'api.openai.com')).toBe(true)
})

test('cancel stops the xai poll loop', async () => {
  store.config.engines.xai.apiKey = 'test-key'
  const timers = trapLongTimers()
  let statusCalls = 0
  const creator = new VideoCreator()
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const href = String(url)
    if (href.endsWith('/videos/generations') && init?.method === 'POST') {
      expect(init.headers?.['Authorization']).toBe('Bearer test-key')
      expect(new URL(href).host).toBe('api.x.ai')
      return json({ request_id: 'req_123' })
    }
    if (href.endsWith('/videos/req_123')) {
      statusCalls += 1
      expect(init?.headers?.['Authorization']).toBe('Bearer test-key')
      expect(new URL(href).host).toBe('api.x.ai')
      return json({ status: 'pending' })
    }
    throw new Error(`unexpected ${href}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const pending = creator.execute('xai', 'grok-imagine-video', { prompt: 'a cat' })
  await vi.waitUntil(() => timers.size === 1)
  creator.cancel()
  const result = await pending

  expect(result).toEqual({ cancelled: true, error: 'cancelled' })
  expect(statusCalls).toBe(0)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect([...timers.values()].every((timer) => timer.cleared) || timers.size === 0).toBe(true)
})

test('cancel stops the google operation poll', async () => {
  store.config.engines.google.apiKey = 'test-key'
  generateVideos.mockResolvedValue({ done: false, name: 'operations/video-1' })
  getVideosOperation.mockResolvedValue({ done: false, name: 'operations/video-1' })
  const timers = trapLongTimers()
  const creator = new VideoCreator()

  const pending = creator.execute('google', 'veo-3.1-generate-preview', { prompt: 'a cat' })
  await vi.waitUntil(() => timers.size === 1)
  expect(getVideosOperation).not.toHaveBeenCalled()
  const first = [...timers.values()][0]
  first.fn()
  await vi.waitUntil(() => getVideosOperation.mock.calls.length === 1 && timers.size >= 1)
  creator.cancel()
  const result = await pending

  expect(result).toEqual({ cancelled: true, error: 'cancelled' })
  expect(generateVideos).toHaveBeenCalledTimes(1)
  expect(getVideosOperation).toHaveBeenCalledTimes(1)
})
