import { expect, test, vi } from 'vitest'
import {
  buildVeniceQueueBody,
  generateVeniceVideo,
  MediaSink,
} from '@services/venice_video'

const QUEUE_ID = '123e4567-e89b-12d3-a456-426614174000'
const API_KEY = 'sk-venice.$ecret*with[regex]'
const MODEL = 'wan-2.5-preview-text-to-video'
const DOWNLOAD = 'https://cdn.example.com/renders/clip.mp4'

function fakeMp4(extra = 8): Uint8Array {
  const header = Uint8Array.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ])
  const out = new Uint8Array(header.length + extra)
  out.set(header)
  return out
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function memorySink(): { sink: MediaSink, chunks: Uint8Array[], state: { aborted: boolean, finished: boolean, finishUrl: string } } {
  const chunks: Uint8Array[] = []
  const state = { aborted: false, finished: false, finishUrl: 'file:///tmp/battle.mp4' }
  return {
    chunks,
    state,
    sink: {
      async write(chunk: Uint8Array) {
        chunks.push(new Uint8Array(chunk))
      },
      async finish() {
        state.finished = true
        return state.finishUrl
      },
      async abort() {
        state.aborted = true
      },
    },
  }
}

function clock(fetchImpl: typeof fetch, sink: MediaSink, timeoutMs = 120000) {
  let nowMs = 0
  const sleeps: number[] = []
  return {
    sleeps,
    deps: {
      fetch: fetchImpl,
      sink,
      timeoutMs,
      now: () => nowMs,
      sleep: async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        sleeps.push(ms)
        nowMs += ms
      },
    },
  }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  expect(text).not.toContain(API_KEY)
  expect(text.toLowerCase()).not.toContain('bearer sk-')
}

test('queue body drops aspect when the model publishes an empty list and strips nulls', () => {
  expect(buildVeniceQueueBody({
    model: 'wan-2.5-preview-image-to-video',
    prompt: 'zoom\u0000 in',
    duration: 5,
    resolution: '720p',
    aspectRatio: '16:9',
    durations: ['5s', '10s'],
    resolutions: ['720p'],
    aspectRatios: [],
    imageRequired: true,
    imageDataUrl: 'data:image/png;base64,aGVs bG8=',
  })).toEqual({
    model: 'wan-2.5-preview-image-to-video',
    prompt: 'zoom in',
    duration: '5s',
    resolution: '720p',
    image_url: 'data:image/png;base64,aGVsbG8=',
  })
})

test('queue body rejects header injection, svg images, and over-long model ids', () => {
  expect(() => buildVeniceQueueBody({ model: MODEL, prompt: 'hi', duration: '5s\r\nX-Ignore: 1' })).toThrow(/duration/)
  expect(() => buildVeniceQueueBody({
    model: 'wan-2.5-preview-image-to-video',
    prompt: 'hi',
    imageRequired: true,
    imageDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
  })).toThrow(/JPEG, PNG/)
  expect(() => buildVeniceQueueBody({ model: 'a'.repeat(129), prompt: 'hi' })).toThrow(/model id/)
  expect(buildVeniceQueueBody({ model: `m${'a'.repeat(127)}`, prompt: 'hi', duration: '5s' }).model).toHaveLength(128)
  expect(() => buildVeniceQueueBody({ model: MODEL, prompt: '\u0000\u0000' })).toThrow(/prompt is required/)
})

test('a download url on another host is fetched and deleted without the api key', async () => {
  const calls: { url: string, init: RequestInit }[] = []
  const saved = memorySink()
  const bytes = fakeMp4()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD })
    }
    if (String(url).endsWith('/video/retrieve')) {
      return jsonResponse({ status: 'COMPLETED' })
    }
    if (String(url) === DOWNLOAD && init.method === 'GET') {
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    if (String(url) === DOWNLOAD && init.method === 'DELETE') {
      throw new TypeError('delete failed')
    }
    throw new Error(`unexpected ${url}`)
  })

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)

  expect(url).toBe('file:///tmp/battle.mp4')
  expect(saved.state.finished).toBe(true)
  expect(saved.state.aborted).toBe(false)
  expect(Buffer.concat(saved.chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(bytes))
  const download = calls.find((call) => call.url === DOWNLOAD && call.init.method === 'GET')
  const deletion = calls.find((call) => call.init.method === 'DELETE')
  expect(download?.init.headers?.['Authorization']).toBeUndefined()
  expect(download?.init.redirect).toBe('follow')
  expect(deletion?.url).toBe(DOWNLOAD)
  expect(deletion?.init.headers?.['Authorization']).toBeUndefined()
  const queue = calls.find((call) => call.url.endsWith('/video/queue'))
  expect(queue?.init.headers?.['Authorization']).toBe(`Bearer ${API_KEY}`)
  expect(calls.some((call) => call.url.endsWith('/video/complete'))).toBe(false)
  const retrieve = JSON.parse(String(calls.find((call) => call.url.endsWith('/video/retrieve'))?.init.body))
  expect(retrieve.delete_media_on_completion).toBe(true)
  expect(typeof retrieve.delete_media_on_completion).toBe('boolean')
  for (const call of calls) {
    if (call.url === DOWNLOAD) expect(JSON.stringify(call.init.headers || {})).not.toContain(API_KEY)
  }
})

test('an expired private link is a failure and does not complete the job', async () => {
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(String(url))
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD })
    }
    if (String(url).endsWith('/video/retrieve')) return jsonResponse({ status: 'COMPLETED' })
    if (init.method === 'GET') return new Response('gone', { status: 410 })
    throw new Error(`unexpected ${url}`)
  })

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error.code).toBe('failed')
  expect(error.message).toMatch(/expired/)
  assertNoSecret(error.message)
  expect(calls.some((url) => url.endsWith('/video/complete'))).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('COMPLETED without a download link is malformed', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({ status: 'COMPLETED' })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
  expect(saved.state.aborted).toBe(true)
})

test('CANCELLED, an unknown status, and a bad queue id stop the job', async () => {
  const saved = memorySink()
  const cancelled = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({ status: 'CANCELLED', error: `stopped ${API_KEY} https://evil.example/x` })
  })
  const cancelledError = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(cancelled, saved.sink).deps).catch((caught) => caught)
  expect(cancelledError.code).toBe('failed')
  assertNoSecret(cancelledError.message)
  expect(cancelledError.message).not.toContain('https://')

  const unknown = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({ status: 'QUEUED' })
  })
  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(unknown, memorySink().sink).deps)).rejects.toMatchObject({ code: 'malformed' })

  const badId = vi.fn(async () => jsonResponse({ queue_id: '../etc/passwd' }))
  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(badId, memorySink().sink).deps)).rejects.toMatchObject({ code: 'malformed' })
})

test('a 500 on queue backs off and a later success is saved', async () => {
  const saved = memorySink()
  let queues = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) {
      queues += 1
      if (queues === 1) return jsonResponse({ error: 'blip' }, 500)
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    }
    if (String(url).endsWith('/video/retrieve')) return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } })
    return jsonResponse({ success: true })
  })
  const timed = clock(fetchImpl, saved.sink)

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, timed.deps)
  expect(url).toBe('file:///tmp/battle.mp4')
  expect(timed.sleeps[0]).toBe(4000)
  expect(queues).toBe(2)
})

test('an http-date retry-after is clamped', async () => {
  const saved = memorySink()
  let retrieves = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves === 1) {
        return jsonResponse({ error: 'later' }, 429, { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' })
      }
      return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }
    return jsonResponse({ success: true })
  })
  const timed = clock(fetchImpl, saved.sink)

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, timed.deps)
  expect(timed.sleeps[0]).toBe(60000)
})

test('tiny chunks are assembled before the mp4 check', async () => {
  const bytes = fakeMp4(0)
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 10))
        controller.enqueue(bytes.subarray(10, 20))
        controller.enqueue(bytes.subarray(20))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
  })

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)
  expect(Buffer.concat(saved.chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(bytes))
  expect(saved.state.finished).toBe(true)
})

test('an html body is not saved even when the status is 200', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return new Response('<html>not a video</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
  expect(saved.chunks).toHaveLength(0)
  expect(saved.state.aborted).toBe(true)
})

test('a file url that is not local is discarded', async () => {
  const saved = memorySink()
  saved.state.finishUrl = 'https://evil.example/venice.mp4'
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }
    return jsonResponse({ success: true })
  })

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error.code).toBe('failed')
  assertNoSecret(error.message)
  expect(saved.state.finished).toBe(true)
  expect(saved.state.aborted).toBe(true)
})

test('a 401 names the key failure without echoing the key', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async () => new Response(`{"error":"nope ${API_KEY}"}`, {
    status: 401,
    headers: { 'content-type': 'application/json' },
  }))

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error.code).toBe('failed')
  expect(error.message).toContain('nope')
  assertNoSecret(error.message)
})

test('a thrown network error is redacted', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async () => {
    throw new Error(`connect failed Bearer ${API_KEY} https://evil.example/${API_KEY}`)
  })

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error.code).toBe('network')
  assertNoSecret(error.message)
  expect(error.message).not.toContain('https://')
  expect(saved.state.aborted).toBe(true)
})
