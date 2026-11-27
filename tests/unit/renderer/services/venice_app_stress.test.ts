import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { useWindowMock } from '@tests/mocks/window'
import VideoPlugin from '@services/plugins/video'
import { store } from '@services/store'
import Venice, { FALLBACK_VENICE_VIDEO_MODELS, parseVeniceVideoCatalog, VeniceVideoModel } from '@services/venice'
import { VENICE_API_BASE, VENICE_ASPECT, VENICE_DURATION, VENICE_MODEL_ID, VENICE_RESOLUTION } from '@services/venice_video'
import VideoCreator from '@services/video'

// Stress tests for the layers around the Venice client: VideoCreator, the IPC
// media sink, the video plugin, and the model catalog loader. The Venice API
// and the main process are both faked in memory. Nothing here reaches a network.
//
// Tests declared with test.fails describe a bug that exists today: they assert
// the behaviour the app should have and are reported as passing while the bug
// is present. Drop the .fails once the bug is fixed.

const API_KEY = 'sk-fake-app-stress-key'
const TEXT_MODEL = 'wan-2.5-preview-text-to-video'
const IPC_CHUNK_LIMIT = 4 * 1024 * 1024

function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

function pick<T>(random: () => number, items: T[]): T {
  return items[int(random, 0, items.length - 1)]
}

function mp4(size: number, stamp: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + stamp) & 0xff
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0)
  return bytes
}

function split(bytes: Uint8Array, random: () => number, maxChunk: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const size = Math.min(int(random, 1, maxChunk), bytes.byteLength - offset)
    chunks.push(bytes.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function same(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
  return !!actual && Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function videoStream(chunks: Uint8Array[]): Response {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) controller.close()
      else controller.enqueue(chunks[index++])
    },
  }, { highWaterMark: 0 })
  return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
}

// Stands in for the main process side of the media IPC calls, with the same
// rules as src/main/media_file.ts: sessions by id, a per-chunk limit, and a
// minimum size to publish.
function fakeMain() {
  const open = new Map<string, Uint8Array[]>()
  const published = new Map<string, Uint8Array>()
  const stats = { opened: 0, finished: 0, aborted: 0, appends: 0 }
  const hooks: { onAppend?: (id: string, count: number) => void | Promise<void> } = {}

  window.api.file.mediaOpen = vi.fn(async () => {
    const id = `session-${++stats.opened}`
    open.set(id, [])
    return id
  })
  window.api.file.mediaAppend = vi.fn(async (id: string, chunk: Uint8Array) => {
    const chunks = open.get(id)
    if (!chunks) throw new Error('Media session not found')
    if (chunk.byteLength > IPC_CHUNK_LIMIT) {
      open.delete(id)
      throw new Error('Video exceeds size limit')
    }
    chunks.push(chunk.slice())
    stats.appends += 1
    await hooks.onAppend?.(id, chunks.length)
  })
  window.api.file.mediaFinish = vi.fn(async (id: string) => {
    const chunks = open.get(id)
    if (!chunks) throw new Error('Media session not found')
    open.delete(id)
    const bytes = concat(chunks)
    if (bytes.byteLength < 12) throw new Error('Video file was empty')
    stats.finished += 1
    const url = `file:///videos/${id}.mp4`
    published.set(url, bytes)
    return url
  })
  window.api.file.mediaAbort = vi.fn(async (id: string) => {
    if (open.delete(id)) stats.aborted += 1
  })

  return { open, published, stats, hooks }
}

// A Venice that answers one job per prompt. The prompt is `job-<n>`.
function fakeVenice(payloads: Uint8Array[], random: () => number, options: { processing?: number } = {}) {
  const counts = { queue: 0, retrieve: 0, complete: 0, other: 0 }
  const polls = new Map<number, number>()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!url.startsWith(`${VENICE_API_BASE}/video/`) || (init.headers as Record<string, string>).Authorization !== `Bearer ${API_KEY}`) {
      counts.other += 1
      throw new Error('unexpected request')
    }
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/video/queue')) {
      counts.queue += 1
      return json({ model: body.model, queue_id: `queue-id-${String(body.prompt).slice(4)}` })
    }
    const index = Number(String(body.queue_id).slice('queue-id-'.length))
    if (url.endsWith('/video/complete')) {
      counts.complete += 1
      return json({ success: true })
    }
    counts.retrieve += 1
    const seen = (polls.get(index) || 0) + 1
    polls.set(index, seen)
    if (seen <= (options.processing ?? 0)) return json({ status: 'PROCESSING' })
    return videoStream(split(payloads[index], random, 4096))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { counts, fetchMock }
}

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  store.config.engines.venice.apiKey = API_KEY
  store.config.engines.venice.models = { chat: [] }
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('the network is disabled in tests')
  }))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VideoCreator over the IPC media sink', () => {

  test('a chunked download goes through one session and is saved byte for byte', async () => {
    const random = prng(11)
    for (let round = 0; round < 20; round++) {
      const main = fakeMain()
      const payload = mp4(int(random, 12, 150000), round)
      const venice = fakeVenice([payload], random)

      const result = await new VideoCreator().execute('venice', TEXT_MODEL, { prompt: 'job-0' })

      expect(result).toEqual({ url: 'file:///videos/session-1.mp4' })
      expect(same(main.published.get(result.url), payload)).toBe(true)
      expect(main.stats).toMatchObject({ opened: 1, finished: 1, aborted: 0 })
      expect(main.open.size).toBe(0)
      expect(venice.counts).toEqual({ queue: 1, retrieve: 1, complete: 1, other: 0 })
    }
  })

  test('cancelling mid-download aborts the session once and publishes nothing, at any point', async () => {
    const random = prng(12)
    const payload = mp4(60000, 3)
    for (let cancelAt = 1; cancelAt <= 12; cancelAt++) {
      const main = fakeMain()
      const venice = fakeVenice([payload], random)
      const creator = new VideoCreator()
      main.hooks.onAppend = (_id, count) => {
        if (count === cancelAt) creator.cancel()
      }

      const result = await creator.execute('venice', TEXT_MODEL, { prompt: 'job-0' })

      expect(result).toEqual({ cancelled: true, error: 'cancelled' })
      expect(main.published.size).toBe(0)
      expect(main.open.size).toBe(0)
      expect(main.stats).toMatchObject({ opened: 1, finished: 0, aborted: 1, appends: cancelAt })
      expect(window.api.file.mediaFinish).not.toHaveBeenCalled()
      expect(venice.counts.complete).toBe(0)
      // A second cancel after the job ended is a no-op.
      expect(() => creator.cancel()).not.toThrow()
    }
  })

  test('forty creators running at once each keep their own session and bytes', async () => {
    const random = prng(13)
    const main = fakeMain()
    const payloads = Array.from({ length: 40 }, (_unused, index) => mp4(int(random, 2000, 40000), index))
    const venice = fakeVenice(payloads, random)
    const creators = payloads.map(() => new VideoCreator())
    const cancelled = new Set([3, 11, 19, 27, 35])
    const identified = new Set<string>()
    main.hooks.onAppend = (id) => {
      // Byte 12 is the first one after the header and differs for every job.
      const bytes = concat(main.open.get(id))
      if (identified.has(id) || bytes.byteLength < 13) return
      identified.add(id)
      const owner = payloads.findIndex((payload) => payload[12] === bytes[12])
      if (cancelled.has(owner)) creators[owner].cancel()
    }

    const results = await Promise.all(creators.map((creator, index) => creator.execute('venice', TEXT_MODEL, { prompt: `job-${index}` })))

    results.forEach((result, index) => {
      if (cancelled.has(index)) {
        expect(result).toEqual({ cancelled: true, error: 'cancelled' })
      } else {
        expect(same(main.published.get(result.url), payloads[index])).toBe(true)
      }
    })
    expect(new Set(results.filter((result) => result.url).map((result) => result.url)).size).toBe(35)
    expect(main.published.size).toBe(35)
    expect(main.open.size).toBe(0)
    expect(main.stats).toMatchObject({ opened: 40, finished: 35, aborted: 5 })
    expect(venice.counts).toMatchObject({ queue: 40, complete: 35, other: 0 })
  })

  test('a main process that refuses at any step gives an error result, no file, and no open session', async () => {
    const random = prng(14)
    const payload = mp4(30000, 9)
    const refusals: [string, (main: ReturnType<typeof fakeMain>) => void][] = [
      ['open returns nothing', () => { window.api.file.mediaOpen = vi.fn(async () => '') }],
      ['open rejects', () => { window.api.file.mediaOpen = vi.fn(async () => { throw new Error(`EACCES /Users/me/${API_KEY}`) }) }],
      ['append rejects on the first chunk', (main) => { main.hooks.onAppend = () => { throw new Error('ENOSPC: no space left on device') } }],
      ['append rejects on the third chunk', (main) => { main.hooks.onAppend = (_id, count) => { if (count === 3) throw new Error('ENOSPC: no space left on device') } }],
      ['finish rejects', () => { window.api.file.mediaFinish = vi.fn(async () => { throw new Error('EPERM: rename') }) }],
      ['finish returns nothing', () => { window.api.file.mediaFinish = vi.fn(async () => null as unknown as string) }],
      ['finish returns a web url', () => { window.api.file.mediaFinish = vi.fn(async () => 'https://example.test/video.mp4') }],
    ]
    for (const [name, arrange] of refusals) {
      const main = fakeMain()
      fakeVenice([payload], random)
      arrange(main)

      const result = await new VideoCreator().execute('venice', TEXT_MODEL, { prompt: 'job-0' })

      expect(result.url, name).toBeUndefined()
      expect(result.cancelled, name).toBeUndefined()
      expect(typeof result.error, name).toBe('string')
      expect(result.error.length, name).toBeGreaterThan(0)
      expect(JSON.stringify(result), name).not.toContain(API_KEY)
      expect(main.published.size, name).toBe(0)
      // A session opened through the fake main process must not stay open. The
      // finish overrides bypass it, so those are checked through the abort call.
      if (name.startsWith('finish')) expect(window.api.file.mediaFinish, name).toHaveBeenCalledTimes(1)
      else expect(main.open.size, name).toBe(0)
    }
  })

  test('a main process that also fails to abort does not turn a cancel into a crash', async () => {
    const random = prng(15)
    const main = fakeMain()
    fakeVenice([mp4(30000, 1)], random)
    const creator = new VideoCreator()
    main.hooks.onAppend = () => creator.cancel()
    window.api.file.mediaAbort = vi.fn(async () => { throw new Error('Media session not found') })

    const result = await creator.execute('venice', TEXT_MODEL, { prompt: 'job-0' })

    expect(result).toEqual({ cancelled: true, error: 'cancelled' })
    expect(window.api.file.mediaAbort).toHaveBeenCalledTimes(1)
  })

  test('a missing or blank key ends in an error after one request and opens no file', async () => {
    const main = fakeMain()
    for (const key of ['', '   ', undefined]) {
      const fetchMock = vi.fn(async () => json({ error: 'Authentication failed' }, 401))
      vi.stubGlobal('fetch', fetchMock)
      store.config.engines.venice.apiKey = key
      const result = await new VideoCreator().execute('venice', TEXT_MODEL, { prompt: 'job-0' })
      expect(result.url).toBeUndefined()
      expect(result.error).toContain('Authentication failed')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
    expect(main.stats.opened).toBe(0)
  })

  test.fails('BUG: a stream chunk larger than the IPC chunk limit is split instead of failing the job', async () => {
    const main = fakeMain()
    const payload = mp4(IPC_CHUNK_LIMIT + 1024, 2)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/video/queue')) return json({ model: TEXT_MODEL, queue_id: 'queue-id-0' })
      if (String(input).endsWith('/video/retrieve')) return videoStream([payload])
      return json({ success: true })
    }))

    const result = await new VideoCreator().execute('venice', TEXT_MODEL, { prompt: 'job-0' })

    expect(result.error).toBeUndefined()
    expect(same(main.published.get(result.url), payload)).toBe(true)
  })

  test.fails('BUG: stopping the chat stops a Venice job started by the video plugin', async () => {
    vi.useFakeTimers()
    const main = fakeMain()
    const venice = fakeVenice([mp4(2000, 1)], prng(16), { processing: Infinity })
    const plugin = new VideoPlugin({ enabled: true, engine: 'venice', model: TEXT_MODEL }, store.config.workspaceId)
    const chat = new AbortController()
    let settled = false

    void plugin.execute({ model: 'chat-model', abortSignal: chat.signal }, { prompt: 'job-0' }).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(12000)
    expect(venice.counts.retrieve).toBeGreaterThanOrEqual(2)
    expect(settled).toBe(false)

    chat.abort()
    const pollsAtStop = venice.counts.retrieve
    await vi.advanceTimersByTimeAsync(120000)

    expect(venice.counts.retrieve).toBe(pollsAtStop)
    expect(settled).toBe(true)
    expect(main.published.size).toBe(0)
  })

})

describe('Venice model catalog', () => {

  function catalogEntry(id: string, modelType: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      type: 'video',
      model_spec: {
        name: id,
        constraints: { model_type: modelType, durations: ['5s'], resolutions: ['720p'], aspect_ratios: ['16:9'], ...extra },
      },
    }
  }

  function expectValidList(models: VeniceVideoModel[], modelType: string) {
    const names = models.map((model) => model.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    for (const model of models) {
      expect(model.id).toMatch(VENICE_MODEL_ID)
      expect(model.meta.modelType).toBe(modelType)
      expect(model.name.length).toBeGreaterThan(0)
      expect(model.name.length).toBeLessThanOrEqual(200)
      // eslint-disable-next-line no-control-regex
      expect(model.name).not.toMatch(/[\u0000-\u001f\u007f]/)
      for (const [values, pattern] of [
        [model.meta.durations, VENICE_DURATION],
        [model.meta.resolutions, VENICE_RESOLUTION],
        [model.meta.aspectRatios, VENICE_ASPECT],
      ] as [string[], RegExp][]) {
        expect(values.length).toBeLessThanOrEqual(32)
        expect(new Set(values).size).toBe(values.length)
        for (const value of values) expect(value).toMatch(pattern)
      }
      if (model.meta.promptCharacterLimit !== undefined) {
        expect(Number.isInteger(model.meta.promptCharacterLimit)).toBe(true)
        expect(model.meta.promptCharacterLimit).toBeGreaterThan(0)
        expect(model.meta.promptCharacterLimit).toBeLessThanOrEqual(20000)
      }
    }
  }

  test('random catalogs are either refused as malformed or reduced to well-formed models', () => {
    const random = prng(21)
    const scalars: unknown[] = [null, true, false, 0, -1, 1e308, NaN, '', ' ', 'video', '5s', '720p', '16:9', 'x'.repeat(300), '\u0000\u001b[31m', '__proto__', [], {}]
    const value = (depth: number): unknown => {
      const roll = int(random, 0, 9)
      if (depth > 2 || roll < 5) return pick(random, scalars)
      if (roll < 7) return Array.from({ length: int(random, 0, 4) }, () => value(depth + 1))
      const out: Record<string, unknown> = {}
      for (let i = 0; i < int(random, 0, 4); i++) out[pick(random, ['id', 'type', 'model_spec', 'name', 'constraints', 'durations', 'data', 'offline'])] = value(depth + 1)
      return out
    }
    const entry = (): unknown => {
      const roll = int(random, 0, 5)
      if (roll === 0) return value(0)
      const id = pick(random, [
        'wan-2.5-text-to-video', 'kling-image-to-video', 'veo3-fast-text-to-video', 'ltx-video-to-video', 'topaz-upscale',
        'bad id', '-leading', 'a'.repeat(129), 'plain-video', '', 42, null,
      ])
      return {
        id,
        type: pick(random, ['video', 'video', 'video', 'image', 'text', null, 7]),
        model_spec: pick(random, [undefined, null, 'spec', {
          name: pick(random, [undefined, '', '   ', 'A \u0007 name\n', 'n'.repeat(400), 12, `Model ${int(random, 0, 50)}`]),
          offline: pick(random, [undefined, false, true, 'true']),
          constraints: pick(random, [undefined, null, [], {
            model_type: pick(random, [undefined, 'text-to-video', 'image-to-video', 'video', 'video-to-video', 'upscale', 5]),
            durations: value(1),
            resolutions: pick(random, [['480p', '720p', '720p', ' 1080p ', '4K', 'true_1080p', 7], value(1)]),
            aspect_ratios: pick(random, [['16:9', '9:16', 'auto', '1:1:1'], value(1)]),
            prompt_character_limit: pick(random, [undefined, 2500, 0, -5, 1e9, 2500.7, '2500', NaN, Infinity]),
          }]),
        }]),
      }
    }

    let refused = 0
    let kept = 0
    for (let round = 0; round < 500; round++) {
      const payload = int(random, 0, 9) === 0
        ? value(0)
        : { data: Array.from({ length: int(random, 0, 30) }, entry), object: 'list' }
      let catalog: ReturnType<typeof parseVeniceVideoCatalog>
      try {
        catalog = parseVeniceVideoCatalog(payload)
      } catch (error) {
        expect((error as Error).message).toBe('malformed')
        refused += 1
        continue
      }
      expectValidList(catalog.video, 'text-to-video')
      expectValidList(catalog.videoEdit, 'image-to-video')
      kept += catalog.video.length + catalog.videoEdit.length
    }
    expect(refused).toBeGreaterThan(10)
    expect(kept).toBeGreaterThan(100)
  })

  test('a catalog of any size is cut to 400 models', () => {
    const data = Array.from({ length: 5000 }, (_unused, index) => catalogEntry(`model-${index}-${index % 2 ? 'text' : 'image'}-to-video`, index % 2 ? 'text-to-video' : 'image-to-video'))
    const catalog = parseVeniceVideoCatalog({ data })
    expect(catalog.video.length + catalog.videoEdit.length).toBe(400)
  })

  test('every kind of catalog failure falls back to the built-in pair without throwing or logging the key', async () => {
    const failures: [string, () => Promise<Response>][] = [
      ['network error', async () => { throw new TypeError(`fetch failed for key ${API_KEY}`) }],
      ['500', async () => json({ error: 'boom' }, 500)],
      ['429', async () => json({ error: 'slow down' }, 429)],
      ['404', async () => new Response('not found', { status: 404 })],
      ['redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/models' } })],
      ['html', async () => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
      ['truncated json', async () => new Response('{"data":[{"id":"wan', { status: 200 })],
      ['empty body', async () => new Response('', { status: 200 })],
      ['null', async () => json(null)],
      ['no data field', async () => json({ object: 'list' })],
      ['empty list', async () => json({ data: [] })],
      ['only unusable models', async () => json({ data: [catalogEntry('topaz-upscale', 'upscale'), { id: 'flux', type: 'image' }] })],
      ['oversized body', async () => new Response(`{"data":[],"pad":"${'x'.repeat(5000001)}"}`, { status: 200 })],
      ['broken stream', async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('reset')) } }), { status: 200 })],
    ]
    for (const [name, respond] of failures) {
      const fetchMock = vi.fn(respond)
      vi.stubGlobal('fetch', fetchMock)
      store.config.engines.venice.models = { chat: [] }

      const ok = await new Venice(store.config).loadModels()

      expect(ok, name).toBe(true)
      expect(store.config.engines.venice.models.video.map((model) => model.id), name).toEqual([FALLBACK_VENICE_VIDEO_MODELS[0].id])
      expect(store.config.engines.venice.models.videoEdit.map((model) => model.id), name).toEqual([FALLBACK_VENICE_VIDEO_MODELS[1].id])
      expect(fetchMock, name).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(`${VENICE_API_BASE}/models?type=video`)
      expect(init.redirect).toBe('manual')
      expect(JSON.stringify(vi.mocked(console.error).mock.calls), name).not.toContain(API_KEY)
    }
  })

  test('a rejected key is retried once without the key, and never more', async () => {
    for (const status of [401, 403]) {
      const seen: (string | undefined)[] = []
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>).Authorization)
        if (seen.length === 1) return json({ error: 'bad key' }, status)
        return json({ data: [catalogEntry('wan-text-to-video', 'text-to-video')] })
      }))
      expect(await new Venice(store.config).loadModels()).toBe(true)
      expect(seen).toEqual([`Bearer ${API_KEY}`, undefined])
      expect(store.config.engines.venice.models.video.map((model) => model.id)).toEqual(['wan-text-to-video'])
    }

    const fetchMock = vi.fn(async () => json({ error: 'bad key' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    expect(await new Venice(store.config).loadModels()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.config.engines.venice.models.video.map((model) => model.id)).toEqual([FALLBACK_VENICE_VIDEO_MODELS[0].id])
  })

  test.fails('BUG: a failed refresh keeps the catalog that was loaded before', async () => {
    const loader = new Venice(store.config)
    vi.stubGlobal('fetch', vi.fn(async () => json({
      data: [
        catalogEntry('kling-2.5-turbo-pro-text-to-video', 'text-to-video'),
        catalogEntry('veo3-fast-text-to-video', 'text-to-video'),
        catalogEntry('kling-2.5-turbo-pro-image-to-video', 'image-to-video'),
      ],
    })))
    await loader.loadModels()
    const loaded = store.config.engines.venice.models.video.map((model) => model.id)
    expect(loaded).toEqual(['kling-2.5-turbo-pro-text-to-video', 'veo3-fast-text-to-video'])

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'at capacity' }, 503)))
    await loader.loadModels()

    expect(store.config.engines.venice.models.video.map((model) => model.id)).toEqual(loaded)
  })

  test.fails('BUG: a catalog request that never answers is given up on', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    let settled = false

    void new Venice(store.config).loadModels().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(settled).toBe(true)
  })

})
