import { expect, test, vi } from 'vitest'
import { Configuration } from 'types/config'
import Venice, { FALLBACK_VENICE_VIDEO_MODELS, fetchVeniceVideoCatalog, parseVeniceVideoCatalog } from '@services/venice'
import { VENICE_API_BASE } from '@services/venice_video'

const catalog = {
  object: 'list',
  type: 'video',
  data: [
    {
      id: 'wan-2.5-preview-text-to-video',
      type: 'video',
      object: 'model',
      owned_by: 'venice.ai',
      model_spec: {
        name: 'Wan 2.5 Preview',
        offline: false,
        constraints: {
          model_type: 'text-to-video',
          durations: ['5s', '10s', 'nope'],
          resolutions: ['720p', '1080p'],
          aspect_ratios: ['16:9', '9:16'],
          prompt_character_limit: 2500,
          secret_field: 'do-not-store',
        },
      },
    },
    {
      id: 'wan-2.5-preview-image-to-video',
      type: 'video',
      object: 'model',
      model_spec: {
        name: 'Wan 2.5 Image',
        constraints: {
          model_type: 'image-to-video',
          durations: ['5s'],
          resolutions: ['720p'],
          aspect_ratios: [],
        },
      },
    },
    {
      id: 'topaz-upscale-video',
      type: 'video',
      object: 'model',
      model_spec: { name: 'Topaz', constraints: { model_type: 'video' } },
    },
    {
      id: 'kling-video-to-video',
      type: 'video',
      object: 'model',
      model_spec: { name: 'Edit', constraints: { model_type: 'video-to-video' } },
    },
    {
      id: '../escape',
      type: 'video',
      object: 'model',
      model_spec: { name: 'Bad', constraints: { model_type: 'text-to-video' } },
    },
    {
      id: 'text-model',
      type: 'text',
      object: 'model',
      model_spec: { name: 'Chat' },
    },
  ],
}

test('parseVeniceVideoCatalog splits text and image models and drops the rest', () => {
  const parsed = parseVeniceVideoCatalog(catalog)
  expect(parsed.video.map((model) => model.id)).toEqual(['wan-2.5-preview-text-to-video'])
  expect(parsed.video[0].meta).toEqual({
    modelType: 'text-to-video',
    durations: ['5s', '10s'],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    promptCharacterLimit: 2500,
  })
  expect(JSON.stringify(parsed)).not.toContain('do-not-store')
  expect(parsed.videoEdit.map((model) => model.id)).toEqual(['wan-2.5-preview-image-to-video'])
  expect(parsed.videoEdit[0].meta.aspectRatios).toEqual([])
})

test('parseVeniceVideoCatalog rejects a payload that is not a list', () => {
  expect(() => parseVeniceVideoCatalog({ models: [] })).toThrow(/malformed/)
  expect(() => parseVeniceVideoCatalog(null)).toThrow(/malformed/)
})

test('fetchVeniceVideoCatalog calls the fixed https models endpoint', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))

  const parsed = await fetchVeniceVideoCatalog('sk-secret', fetchImpl)
  expect(parsed.video).toHaveLength(1)
  expect(fetchImpl).toHaveBeenCalledWith(`${VENICE_API_BASE}/models?type=video`, expect.objectContaining({
    method: 'GET',
    redirect: 'manual',
    headers: expect.objectContaining({ Authorization: 'Bearer sk-secret' }),
  }))
})

test('fetchVeniceVideoCatalog retries without a key after 401', async () => {
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>
    if (headers.Authorization) return new Response('nope', { status: 401 })
    return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const parsed = await fetchVeniceVideoCatalog('sk-secret', fetchImpl)
  expect(parsed.videoEdit).toHaveLength(1)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  const secondHeaders = fetchImpl.mock.calls[1][1].headers as Record<string, string>
  expect(secondHeaders.Authorization).toBeUndefined()
})

test('Venice loader falls back when the catalog cannot be fetched', async () => {
  const fetchImpl = vi.fn(async () => { throw new TypeError('offline') })
  vi.stubGlobal('fetch', fetchImpl)
  const config = {
    engines: {
      venice: { apiKey: 'sk-secret', models: { chat: [] }, model: {} },
    },
  } as unknown as Configuration

  const loader = new Venice(config)
  await expect(loader.loadModels()).resolves.toBe(true)
  expect(config.engines.venice.models.video?.[0].id).toBe(FALLBACK_VENICE_VIDEO_MODELS[0].id)
  expect(config.engines.venice.models.videoEdit?.[0].id).toBe('wan-2.5-preview-image-to-video')
  vi.unstubAllGlobals()
})
