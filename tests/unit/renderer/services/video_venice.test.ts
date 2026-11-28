import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { useWindowMock } from '@tests/mocks/window'
import VideoPlugin from '@services/plugins/video'
import { store } from '@services/store'
import VideoCreator from '@services/video'
import { VENICE_API_BASE } from '@services/venice_video'

const API_KEY = 'sk-venice-live-secret'

function fakeMp4(): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
    0x00, 0x00, 0x00, 0x00,
  ])
}

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  vi.unstubAllGlobals()
  store.config.engines.venice.apiKey = API_KEY
  window.api.file.mediaOpen = vi.fn(async () => 'media-session')
  window.api.file.mediaAppend = vi.fn(async () => undefined)
  window.api.file.mediaFinish = vi.fn(async () => 'file://file_saved')
  window.api.file.mediaAbort = vi.fn(async () => undefined)
})

test('Venice is a video engine only when a key is stored', () => {
  expect(VideoCreator.getEngines(false).map((engine) => engine.id)).toContain('venice')
  expect(VideoCreator.getEngines(true).map((engine) => engine.id)).toContain('venice')
  store.config.engines.venice.apiKey = ''
  expect(VideoCreator.getEngines(true).map((engine) => engine.id)).not.toContain('venice')
  expect(VideoCreator.getEngines(false).map((engine) => engine.id)).toContain('venice')
})

test('the video plugin enables Venice from the saved key', () => {
  store.config.plugins.video.engine = 'venice'
  store.config.plugins.video.model = 'wan-2.5-preview-text-to-video'
  store.config.plugins.video.enabled = true
  const plugin = new VideoPlugin(store.config.plugins.video, store.config.workspaceId)
  expect(plugin.isEnabled()).toBe(true)
  store.config.engines.venice.apiKey = '   '
  expect(plugin.isEnabled()).toBe(false)
})

test('VideoCreator queues Venice and returns the saved file url', async () => {
  const calls: { url: string, init: RequestInit }[] = []
  let retrieves = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return new Response(JSON.stringify({
        model: 'wan-2.5-preview-text-to-video',
        queue_id: '123e4567-e89b-12d3-a456-426614174000',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  window.api.file.mediaOpen = vi.fn(async () => 'media-session')
  window.api.file.mediaAppend = vi.fn(async () => undefined)
  window.api.file.mediaFinish = vi.fn(async () => 'file:///tmp/studio.mp4')
  window.api.file.mediaAbort = vi.fn(async () => undefined)

  const result = await new VideoCreator().execute('venice', 'wan-2.5-preview-text-to-video', {
    prompt: 'a gondola at dusk',
    duration: '5s',
    resolution: '720p',
    aspect_ratio: '16:9',
    model: 'ignore-me',
    image_url: 'https://evil.example/injected',
  })

  expect(retrieves).toBe(1)
  expect(result).toEqual({ url: 'file:///tmp/studio.mp4' })
  expect(calls.some((call) => call.url.endsWith('/video/complete'))).toBe(false)
  const retrieve = calls.find((call) => call.url.endsWith('/video/retrieve'))
  const retrieveBody = JSON.parse(String(retrieve?.init.body))
  expect(retrieveBody.delete_media_on_completion).toBe(true)
  expect(typeof retrieveBody.delete_media_on_completion).toBe('boolean')
  expect(calls[0].url).toBe(`${VENICE_API_BASE}/video/queue`)
  expect(calls[0].init.redirect).toBe('manual')
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    model: 'wan-2.5-preview-text-to-video',
    prompt: 'a gondola at dusk',
    duration: '5s',
    resolution: '720p',
    aspect_ratio: '16:9',
  })
  expect(JSON.stringify(result)).not.toContain(API_KEY)
  expect(window.api.file.mediaAppend).toHaveBeenCalled()
  expect(window.api.file.mediaFinish).toHaveBeenCalledWith('media-session')
})

test('cancelling a Venice generation does not report a file', async () => {
  const creator = new VideoCreator()
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
      creator.cancel()
    })
  }))

  const result = await creator.execute('venice', 'wan-2.5-preview-text-to-video', { prompt: 'stop' })
  expect(result.cancelled).toBe(true)
  expect(result.url).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain(API_KEY)
})

test('image-to-video sends a data url built from the reference', async () => {
  const calls: { url: string, init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return new Response(JSON.stringify({
        model: 'wan-2.5-preview-image-to-video',
        queue_id: '123e4567-e89b-12d3-a456-426614174000',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/video/retrieve')) {
      return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))

  const result = await new VideoCreator().execute('venice', 'wan-2.5-preview-image-to-video', {
    prompt: 'camera push',
  }, [{ mimeType: 'image/png', contents: 'aGVsbG8=' }])

  expect(result.url).toBe('file://file_saved')
  expect(JSON.parse(String(calls[0].init.body)).image_url).toBe('data:image/png;base64,aGVsbG8=')
  expect(calls.some((call) => call.url.endsWith('/video/complete'))).toBe(false)
  const retrieve = JSON.parse(String(calls.find((call) => call.url.endsWith('/video/retrieve'))?.init.body))
  expect(retrieve.delete_media_on_completion).toBe(true)
})
