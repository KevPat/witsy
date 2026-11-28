import { beforeEach, expect, test, vi } from 'vitest'
import {
  buildVeniceQueueBody,
  generateVeniceVideo,
  isMp4,
  MediaSink,
  redactSecrets,
  VENICE_API_BASE,
  VeniceVideoError,
} from '@services/venice_video'

const QUEUE_ID = '123e4567-e89b-12d3-a456-426614174000'
const API_KEY = 'sk-venice-test-secret'
const MODEL = 'wan-2.5-preview-text-to-video'

type Call = { url: string, init: RequestInit }

function fakeMp4(extra = 24): Uint8Array {
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

function mp4Response(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'video/mp4', ...headers },
  })
}

function memorySink(): { sink: MediaSink, chunks: Uint8Array[], state: { aborted: boolean, finished: boolean } } {
  const chunks: Uint8Array[] = []
  const state = { aborted: false, finished: false }
  return {
    chunks,
    state,
    sink: {
      async write(chunk: Uint8Array) {
        chunks.push(new Uint8Array(chunk))
      },
      async finish() {
        state.finished = true
        return 'file:///tmp/venice.mp4'
      },
      async abort() {
        state.aborted = true
      },
    },
  }
}

function clock(fetchImpl: typeof fetch, sink: MediaSink, timeoutMs = 60000) {
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

beforeEach(() => {
  vi.restoreAllMocks()
})

test('isMp4 recognizes an ftyp box and rejects other bytes', () => {
  expect(isMp4(fakeMp4())).toBe(true)
  expect(isMp4(new TextEncoder().encode('{"status":"PROCESSING"}'))).toBe(false)
  expect(isMp4(new Uint8Array([0, 1, 2]))).toBe(false)
})

test('redactSecrets removes the api key, bearer tokens, and urls', () => {
  const text = redactSecrets(`bad ${API_KEY} Bearer ${API_KEY} https://private-share.venice.ai/v1/share/read/abc`, API_KEY)
  expect(text).not.toContain(API_KEY)
  expect(text).not.toContain('https://')
  expect(text).toContain('[redacted]')
  expect(text).toContain('[url]')
})

test('buildVeniceQueueBody keeps a strict field set', () => {
  expect(buildVeniceQueueBody({
    model: MODEL,
    prompt: 'a gondola',
    duration: '5s',
    resolution: '720p',
    aspectRatio: '16:9',
    durations: ['5s', '10s'],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9'],
  })).toEqual({
    model: MODEL,
    prompt: 'a gondola',
    duration: '5s',
    resolution: '720p',
    aspect_ratio: '16:9',
  })
})

test('buildVeniceQueueBody rejects unsafe model ids, oversized prompts, and bad images', () => {
  expect(() => buildVeniceQueueBody({ model: '../etc/passwd', prompt: 'hi' })).toThrow(VeniceVideoError)
  expect(() => buildVeniceQueueBody({ model: MODEL, prompt: 'x'.repeat(2501), promptCharacterLimit: 2500 })).toThrow(/too long/)
  expect(() => buildVeniceQueueBody({
    model: 'wan-2.5-preview-image-to-video',
    prompt: 'zoom',
    imageRequired: true,
  })).toThrow(/reference image/)
  expect(() => buildVeniceQueueBody({
    model: 'wan-2.5-preview-image-to-video',
    prompt: 'zoom',
    imageRequired: true,
    imageDataUrl: 'https://evil.example/cat.jpg',
  })).toThrow(/JPEG, PNG/)
  expect(() => buildVeniceQueueBody({
    model: MODEL,
    prompt: 'hi',
    duration: '99s',
    durations: ['5s'],
  })).toThrow(/duration/)
})

test('queues, polls through processing, saves the mp4, and completes', async () => {
  const bytes = fakeMp4()
  const calls: Call[] = []
  let retrieves = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    }
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves < 4) {
        return jsonResponse({ status: 'PROCESSING', average_execution_time: 15000, execution_duration: 3000 })
      }
      return mp4Response(bytes)
    }
    throw new Error(`unexpected ${url}`)
  })
  const { deps, sleeps } = clock(fetchImpl, saved.sink)

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola', duration: '5s' }, deps)

  expect(url).toBe('file:///tmp/venice.mp4')
  expect(retrieves).toBe(4)
  expect(saved.state.finished).toBe(true)
  expect(saved.state.aborted).toBe(false)
  expect(Buffer.concat(saved.chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(bytes))
  expect(sleeps.length).toBeGreaterThanOrEqual(3)
  expect(calls.map((call) => call.url)).toEqual([
    `${VENICE_API_BASE}/video/queue`,
    `${VENICE_API_BASE}/video/retrieve`,
    `${VENICE_API_BASE}/video/retrieve`,
    `${VENICE_API_BASE}/video/retrieve`,
    `${VENICE_API_BASE}/video/retrieve`,
  ])
  expect(calls.some((call) => call.url.endsWith('/video/complete'))).toBe(false)
  for (const call of calls) {
    expect(call.init.redirect).toBe('manual')
    expect(call.init.headers?.['Authorization']).toBe(`Bearer ${API_KEY}`)
    expect(JSON.stringify(call.init.body || '')).not.toContain('file://')
  }
  const queued = JSON.parse(String(calls[0].init.body))
  expect(queued).toEqual({ model: MODEL, prompt: 'a gondola', duration: '5s' })
  for (const call of calls.filter((item) => item.url.endsWith('/video/retrieve'))) {
    const body = JSON.parse(String(call.init.body))
    expect(body.delete_media_on_completion).toBe(true)
    expect(typeof body.delete_media_on_completion).toBe('boolean')
  }
  expect(JSON.parse(String(calls.at(-1).init.body))).toEqual({
    model: MODEL,
    queue_id: QUEUE_ID,
    delete_media_on_completion: true,
  })
})

test('downloads a private venice url after COMPLETED and deletes it without the api key', async () => {
  const downloadUrl = 'https://private-share.venice.ai/v1/share/read/abc'
  const calls: Call[] = []
  let retrieves = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID, download_url: downloadUrl })
    }
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves === 1) return jsonResponse({ status: 'PROCESSING' })
      return jsonResponse({ status: 'COMPLETED' })
    }
    if (String(url) === downloadUrl && init.method === 'GET') return mp4Response(fakeMp4())
    if (String(url) === downloadUrl && init.method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`unexpected ${url} ${init.method}`)
  })

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)

  expect(url).toBe('file:///tmp/venice.mp4')
  const download = calls.find((call) => call.url === downloadUrl && call.init.method === 'GET')
  const deletion = calls.find((call) => call.url === downloadUrl && call.init.method === 'DELETE')
  expect(download?.init.headers?.['Authorization']).toBeUndefined()
  expect(deletion).toBeTruthy()
  expect(deletion?.init.headers?.['Authorization']).toBeUndefined()
  expect(calls.some((call) => call.url.endsWith('/video/complete'))).toBe(false)
  for (const call of calls.filter((item) => item.url.endsWith('/video/retrieve'))) {
    const body = JSON.parse(String(call.init.body))
    expect(body.delete_media_on_completion).toBe(true)
    expect(typeof body.delete_media_on_completion).toBe('boolean')
  }
  for (const call of calls) {
    if (call.url.startsWith(VENICE_API_BASE)) {
      expect(call.init.headers?.['Authorization']).toBe(`Bearer ${API_KEY}`)
    }
  }
})

test('fetches a download url on any host without the api key', async () => {
  const downloadUrl = 'https://cdn.example.com/clip.mp4'
  const calls: Call[] = []
  const saved = memorySink()
  const bytes = fakeMp4()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID, download_url: downloadUrl })
    }
    if (String(url).endsWith('/video/retrieve')) return jsonResponse({ status: 'COMPLETED' })
    if (String(url) === downloadUrl && init.method === 'GET') return mp4Response(bytes)
    if (String(url) === downloadUrl && init.method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`unexpected ${url} ${init.method}`)
  })

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)

  expect(url).toBe('file:///tmp/venice.mp4')
  const download = calls.find((call) => call.url === downloadUrl && call.init.method === 'GET')
  expect(download?.init.redirect).toBe('follow')
  expect(download?.init.headers?.['Authorization']).toBeUndefined()
  expect(JSON.stringify(download?.init.headers || {})).not.toContain(API_KEY)
  const apiCall = calls.find((call) => call.url.endsWith('/video/queue'))
  expect(apiCall?.init.headers?.['Authorization']).toBe(`Bearer ${API_KEY}`)
  expect(calls.some((call) => call.url.endsWith('/video/complete'))).toBe(false)
  const retrieve = calls.find((call) => call.url.endsWith('/video/retrieve'))
  expect(JSON.parse(String(retrieve?.init.body)).delete_media_on_completion).toBe(true)
})

test('does not follow an authenticated redirect', async () => {
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(String(url))
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'failed' })

  expect(calls).toEqual([`${VENICE_API_BASE}/video/queue`])
})

test('backs off on 429 and then accepts the video', async () => {
  let retrieves = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves === 1) {
        return jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '3' })
      }
      if (retrieves === 2) return jsonResponse({ status: 'PROCESSING' })
      return mp4Response(fakeMp4())
    }
    return jsonResponse({ success: true })
  })
  const timed = clock(fetchImpl, saved.sink)

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, timed.deps)

  expect(timed.sleeps[0]).toBe(3000)
  expect(saved.state.finished).toBe(true)
})

test('stops after repeated 429 responses', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({ error: `slow ${API_KEY}` }, 429, { 'retry-after': '1' })
  })

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error).toBeInstanceOf(VeniceVideoError)
  expect(error.code).toBe('rate_limit')
  expect(error.message).not.toContain(API_KEY)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('retries a network error then saves the video', async () => {
  let retrieves = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves === 1) throw new TypeError('network down')
      if (retrieves === 2) return jsonResponse({ status: 'PROCESSING' })
      return mp4Response(fakeMp4())
    }
    return jsonResponse({ success: true })
  })

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)
  expect(url).toBe('file:///tmp/venice.mp4')
  expect(retrieves).toBe(3)
})

test('returns a content-policy failure without the api key and does not complete', async () => {
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({
      error: {
        message: `The provider rejected this request. key=${API_KEY}`,
        type: 'provider_content_policy',
        credits_refunded: true,
      },
    }, 422)
  })

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error.code).toBe('failed')
  expect(error.message).toContain('provider rejected')
  expect(error.message).not.toContain(API_KEY)
  expect(calls.some((url) => url.endsWith('/video/complete'))).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('treats a FAILED status as terminal', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({ status: 'FAILED', error: 'inference failed' })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'failed', message: 'inference failed' })
})

test('rejects a malformed queue response', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async () => jsonResponse({ model: MODEL }))

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
  expect(saved.state.finished).toBe(false)
})

test('rejects a video payload that is not an mp4', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return new Response('this is not a video', { status: 200, headers: { 'content-type': 'video/mp4' } })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
  expect(saved.chunks).toHaveLength(0)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('rejects an unreadable status body', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
})

test('times out when the job keeps processing', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return jsonResponse({ status: 'PROCESSING' })
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink, 12000).deps)).rejects.toMatchObject({ code: 'timeout' })
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('cancellation stops polling and does not complete the job', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push(String(url))
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    controller.abort()
    return jsonResponse({ status: 'PROCESSING' })
  })
  const timed = clock(fetchImpl, saved.sink)
  timed.deps.signal = controller.signal

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'cancelled' })

  expect(calls.some((url) => url.endsWith('/video/complete'))).toBe(false)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('refuses a download larger than the size limit', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    return new Response(fakeMp4(), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '99999999' },
    })
  })
  const timed = clock(fetchImpl, saved.sink)
  timed.deps.maxBytes = 1024

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'invalid' })
  expect(saved.chunks).toHaveLength(0)
})

test('stops a stream once it passes the size limit and aborts the partial file', async () => {
  const bytes = fakeMp4(64)
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 40))
        controller.enqueue(bytes.subarray(40))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
  })
  const timed = clock(fetchImpl, saved.sink)
  timed.deps.maxBytes = 50

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'invalid' })
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('the settings key is sent as entered, including when it is blank', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
  const saved = memorySink()
  await expect(generateVeniceVideo({
    apiKey: '   ',
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'failed' })
  expect(fetchImpl).toHaveBeenCalled()
  const init = fetchImpl.mock.calls[0][1] as RequestInit
  const headers = init.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer    ')
})

test('retrieve HTTP 502 keeps polling and a later video is saved', async () => {
  const bytes = fakeMp4()
  let retrieves = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves <= 2) return jsonResponse({ error: 'bad gateway' }, 502)
      if (retrieves === 3) return jsonResponse({ status: 'PROCESSING' })
      return mp4Response(bytes)
    }
    throw new Error(`unexpected ${url}`)
  })

  const url = await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)

  expect(url).toBe('file:///tmp/venice.mp4')
  expect(retrieves).toBe(4)
  expect(saved.state.finished).toBe(true)
  expect(saved.state.aborted).toBe(false)
})

test('retrieve HTTP 502 does not count toward the transient failure cap', async () => {
  let retrieves = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves <= 9) return jsonResponse({ error: 'bad gateway' }, 502)
      return mp4Response(fakeMp4())
    }
    throw new Error(`unexpected ${url}`)
  })

  const url = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink, 400000).deps)

  expect(url).toBe('file:///tmp/venice.mp4')
  expect(retrieves).toBe(10)
  expect(saved.state.finished).toBe(true)
})

test('retrieve HTTP 500 fails the run and is not retried', async () => {
  let retrieves = 0
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      return jsonResponse({ error: 'server' }, 500)
    }
    throw new Error(`unexpected ${url}`)
  })

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'unavailable' })

  expect(retrieves).toBe(1)
  expect(calls.filter((url) => url.endsWith('/video/retrieve'))).toHaveLength(1)
  expect(calls.some((url) => url.endsWith('/video/complete'))).toBe(false)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('a successful retrieve asks Venice to delete media and never calls complete', async () => {
  const calls: Call[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) return jsonResponse({ model: MODEL, queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) return mp4Response(fakeMp4())
    throw new Error(`unexpected ${url}`)
  })

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)

  expect(calls.map((call) => call.url)).toEqual([
    `${VENICE_API_BASE}/video/queue`,
    `${VENICE_API_BASE}/video/retrieve`,
  ])
  const body = JSON.parse(String(calls[1].init.body))
  expect(body).toEqual({
    model: MODEL,
    queue_id: QUEUE_ID,
    delete_media_on_completion: true,
  })
  expect(typeof body.delete_media_on_completion).toBe('boolean')
  expect(String(calls[1].init.body)).not.toContain('"delete_media_on_completion":"true"')
})

test('download_url is fetched without Authorization and Venice API calls keep it', async () => {
  const downloadUrl = 'https://cdn.example.com/private/clip.mp4'
  const calls: Call[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ model: MODEL, queue_id: QUEUE_ID, download_url: downloadUrl })
    }
    if (String(url).endsWith('/video/retrieve')) return jsonResponse({ status: 'COMPLETED' })
    if (String(url) === downloadUrl && init.method === 'GET') return mp4Response(fakeMp4())
    if (String(url) === downloadUrl && init.method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`unexpected ${url} ${init.method}`)
  })

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, clock(fetchImpl, saved.sink).deps)

  const download = calls.find((call) => call.url === downloadUrl && call.init.method === 'GET')
  const deletion = calls.find((call) => call.url === downloadUrl && call.init.method === 'DELETE')
  expect(download?.init.headers?.['Authorization']).toBeUndefined()
  expect(download?.init.credentials).toBe('omit')
  expect(JSON.stringify(download?.init.headers || {})).not.toContain(API_KEY)
  expect(deletion?.init.headers?.['Authorization']).toBeUndefined()
  expect(JSON.stringify(deletion?.init.headers || {})).not.toContain(API_KEY)
  for (const call of calls.filter((item) => item.url.startsWith(VENICE_API_BASE))) {
    expect(call.init.headers?.['Authorization']).toBe(`Bearer ${API_KEY}`)
  }
  expect(calls.some((call) => call.url.startsWith(VENICE_API_BASE) && call.url.endsWith('/video/queue'))).toBe(true)
  expect(calls.some((call) => call.url.startsWith(VENICE_API_BASE) && call.url.endsWith('/video/retrieve'))).toBe(true)
})
