import { expect, test, vi } from 'vitest'
import {
  buildVeniceQueueBody,
  generateVeniceVideo,
  MediaSink,
  VeniceVideoError,
} from '@services/venice_video'

const QUEUE_ID = '123e4567-e89b-12d3-a456-426614174000'
const API_KEY = 'sk-venice-stress-secret'
const MODEL = 'wan-2.5-preview-text-to-video'
const DOWNLOAD = 'https://cdn.example.com/renders/clip.mp4'

const MP4_HEADER = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x31,
])

function fakeMp4(extra = 24, fill = 0x11): Uint8Array {
  const out = new Uint8Array(MP4_HEADER.length + extra)
  out.set(MP4_HEADER)
  out.fill(fill, MP4_HEADER.length)
  return out
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(payload, {
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

function memorySink(fileUrl = 'file:///tmp/venice-stress.mp4'): {
  sink: MediaSink
  chunks: Uint8Array[]
  state: { aborted: boolean, finished: boolean }
} {
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
        return fileUrl
      },
      async abort() {
        state.aborted = true
      },
    },
  }
}

function joined(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function clock(fetchImpl: typeof fetch, sink: MediaSink, timeoutMs = 600000, start = 0) {
  let nowMs = start
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

function xorshift(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
}

test('queue 429s past the deadline without calling retrieve', async () => {
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(String(url))
    return jsonResponse({ error: `slow ${API_KEY}` }, 429, { 'retry-after': '30' })
  })
  const timed = clock(fetchImpl, saved.sink, 4000)

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps).catch((caught) => caught)

  expect(error).toBeInstanceOf(VeniceVideoError)
  expect(error.code).toBe('timeout')
  expect(error.message).not.toContain(API_KEY)
  expect(calls.every((url) => url.endsWith('/video/queue'))).toBe(true)
  expect(timed.sleeps).toEqual([4000])
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('a retry-after longer than the remaining budget is cut down to the deadline', async () => {
  const saved = memorySink()
  let retrieves = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    retrieves += 1
    return jsonResponse({ error: 'later' }, 503, { 'retry-after': '120' })
  })
  const timed = clock(fetchImpl, saved.sink, 9000)

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'timeout' })

  expect(retrieves).toBe(1)
  expect(timed.sleeps).toEqual([9000])
  expect(saved.state.aborted).toBe(true)
  expect(saved.state.finished).toBe(false)
})

test('processing estimates cannot stretch a poll past the deadline', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    return jsonResponse({ status: 'PROCESSING', average_execution_time: 600000, execution_duration: 0 })
  })
  const timed = clock(fetchImpl, saved.sink, 20000)

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'timeout' })

  expect(timed.sleeps).toEqual([20000])
})

test('retrieve backs off through 429 and 503 Retry-After values, then saves the mp4', async () => {
  const saved = memorySink()
  const bytes = fakeMp4()
  let retrieves = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves === 1) return jsonResponse({ error: 'slow' }, 429, { 'retry-after': '0' })
      if (retrieves === 2) return jsonResponse({ error: 'slow' }, 503, { 'retry-after': '1.5' })
      if (retrieves === 3) return jsonResponse({ error: 'slow' }, 429, { 'retry-after': ' 2 ' })
      if (retrieves === 4) return jsonResponse({ error: 'slow' }, 503, { 'retry-after': 'not-a-date' })
      if (retrieves === 5) return jsonResponse({ error: 'slow' }, 429, { 'retry-after': 'soon' })
      return mp4Response(bytes)
    }
    return jsonResponse({ success: true })
  })
  const timed = clock(fetchImpl, saved.sink)

  const url = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)

  expect(url).toBe('file:///tmp/venice-stress.mp4')
  expect(retrieves).toBe(6)
  expect(timed.sleeps).toEqual([1000, 1500, 2000, 30000, 30000])
  expect(joined(saved.chunks)).toEqual(Buffer.from(bytes))
  expect(saved.state.finished).toBe(true)
  expect(saved.state.aborted).toBe(false)
})

test('an http-date Retry-After in the past waits the minimum second', async () => {
  const saved = memorySink()
  const when = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')
  let retrieves = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    retrieves += 1
    if (retrieves === 1) {
      return jsonResponse({ error: 'later' }, 429, { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' })
    }
    return mp4Response(fakeMp4())
  })
  const timed = clock(fetchImpl, saved.sink, 600000, when + 5000)

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, timed.deps)

  expect(timed.sleeps[0]).toBe(1000)
  expect(saved.state.finished).toBe(true)
})

test('an http-date Retry-After far ahead is clamped to a minute', async () => {
  const saved = memorySink()
  let retrieves = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    retrieves += 1
    if (retrieves === 1) {
      return jsonResponse({ error: 'later' }, 429, { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' })
    }
    return mp4Response(fakeMp4())
  })
  const timed = clock(fetchImpl, saved.sink)

  await generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'a gondola' }, timed.deps)

  expect(timed.sleeps[0]).toBe(60000)
})

test('eight retrieve network errors still recover, and a ninth is terminal', async () => {
  const bytes = fakeMp4()
  let retrieves = 0
  const saved = memorySink()
  const recovering = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) {
      retrieves += 1
      if (retrieves <= 8) throw new TypeError(`offline ${API_KEY}`)
      return mp4Response(bytes)
    }
    return jsonResponse({ success: true })
  })
  const recovered = clock(recovering, saved.sink, 400000)

  const url = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, recovered.deps)

  expect(url).toBe('file:///tmp/venice-stress.mp4')
  expect(retrieves).toBe(9)
  expect(recovered.sleeps).toEqual([4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
  expect(saved.state.aborted).toBe(false)

  let failures = 0
  const failing = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    failures += 1
    throw new TypeError('offline')
  })
  const dropped = memorySink()
  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(failing, dropped.sink, 400000).deps).catch((caught) => caught)

  expect(failures).toBe(9)
  expect(error.code).toBe('network')
  expect(error.message).not.toContain(API_KEY)
  expect(dropped.state.aborted).toBe(true)
  expect(dropped.state.finished).toBe(false)
})

test('a private download retries 429 and 503, then deletes the link without the key', async () => {
  const bytes = fakeMp4(32, 0x22)
  const calls: { url: string, method: string, headers: Record<string, string> }[] = []
  let downloads = 0
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      headers: (init.headers || {}) as Record<string, string>,
    })
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ queue_id: QUEUE_ID, download_url: DOWNLOAD })
    }
    if (String(url).endsWith('/video/retrieve')) return jsonResponse({ status: 'COMPLETED' })
    if (String(url) === DOWNLOAD && init.method === 'GET') {
      downloads += 1
      if (downloads === 1) return jsonResponse({ error: 'slow' }, 429, { 'retry-after': '3' })
      if (downloads === 2) return new Response('busy', { status: 503 })
      return mp4Response(bytes)
    }
    if (String(url) === DOWNLOAD && init.method === 'DELETE') return new Response(null, { status: 204 })
    if (String(url).endsWith('/video/complete')) return jsonResponse({ success: true })
    throw new Error(`unexpected ${url}`)
  })
  const timed = clock(fetchImpl, saved.sink)

  const url = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)

  expect(url).toBe('file:///tmp/venice-stress.mp4')
  expect(downloads).toBe(3)
  expect(timed.sleeps).toEqual([3000, 8000])
  expect(joined(saved.chunks)).toEqual(Buffer.from(bytes))
  const downloadCalls = calls.filter((call) => call.url === DOWNLOAD)
  for (const call of downloadCalls) {
    expect(JSON.stringify(call.headers)).not.toContain(API_KEY)
  }
  expect(downloadCalls.some((call) => call.method === 'DELETE')).toBe(true)
})

test('repeated private-download 429s stop and do not complete the job', async () => {
  const calls: string[] = []
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method} ${url}`)
    if (String(url).endsWith('/video/queue')) {
      return jsonResponse({ queue_id: QUEUE_ID, download_url: DOWNLOAD })
    }
    if (String(url).endsWith('/video/retrieve')) return jsonResponse({ status: 'COMPLETED' })
    if (init.method === 'GET') return jsonResponse({ error: `slow ${API_KEY}` }, 429, { 'retry-after': '1' })
    throw new Error(`unexpected ${url}`)
  })

  const error = await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)

  expect(error.code).toBe('rate_limit')
  expect(error.message).not.toContain(API_KEY)
  expect(calls.filter((call) => call.startsWith('GET ')).length).toBe(5)
  expect(calls.some((call) => call.includes('/video/complete'))).toBe(false)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('a declared body over the cap is refused before any byte is written', async () => {
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    return mp4Response(fakeMp4(), { 'content-length': '999999999' })
  })
  const timed = clock(fetchImpl, saved.sink)
  timed.deps.maxBytes = 1024

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'invalid' })

  expect(saved.chunks).toHaveLength(0)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
})

test('a stream of small chunks stops once the running total passes the cap', async () => {
  const bytes = fakeMp4(80)
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    const stream = new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += 10) {
          controller.enqueue(bytes.subarray(offset, offset + 10))
        }
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
  })
  const timed = clock(fetchImpl, saved.sink)
  timed.deps.maxBytes = 60

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'invalid' })

  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
  expect(joined(saved.chunks).byteLength).toBeLessThanOrEqual(60)
})

test('one-byte chunks are reassembled into the original mp4', async () => {
  const bytes = fakeMp4(16, 0x44)
  const saved = memorySink()
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  })

  await generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)

  expect(joined(saved.chunks)).toEqual(Buffer.from(bytes))
  expect(saved.state.finished).toBe(true)
})

test('garbage, truncated, and non-json bodies never finish the file', async () => {
  const rng = xorshift(0x5eed)
  const garbage: Uint8Array[] = [
    new Uint8Array(0),
    fakeMp4().subarray(0, 11),
    new Uint8Array([0x66, 0x74, 0x79]),
  ]
  for (let n = 0; n < 24; n += 1) {
    const length = rng() % 80
    const bytes = new Uint8Array(length)
    bytes.fill(0x41 + (n % 20))
    garbage.push(bytes)
  }

  for (const bytes of garbage) {
    const saved = memorySink()
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
      return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } })
    })
    await expect(generateVeniceVideo({
      apiKey: API_KEY,
      model: MODEL,
      prompt: 'a gondola',
    }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
    expect(saved.state.finished).toBe(false)
    expect(saved.state.aborted).toBe(true)
  }
})

test('malformed status payloads and an oversized json body are refused', async () => {
  const bodies = [
    '',
    '{',
    'null',
    '[]',
    '"processing"',
    '{"status":',
    '{"status":1}',
    '{"status":""}',
    `{"status":"PROCESSING","note":"${'x'.repeat(80)}`,
    '   ',
    '<html>nope</html>',
  ]
  for (const body of bodies) {
    const saved = memorySink()
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const error = await generateVeniceVideo({
      apiKey: API_KEY,
      model: MODEL,
      prompt: 'a gondola',
    }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)
    expect(error).toBeInstanceOf(VeniceVideoError)
    expect(error.code).toBe('malformed')
    expect(error.message).not.toContain(API_KEY)
    expect(saved.state.finished).toBe(false)
  }

  const saved = memorySink()
  const huge = `{"status":"${'P'.repeat(1_048_577)}"}`
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    return new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } })
  })
  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, clock(fetchImpl, saved.sink).deps)).rejects.toMatchObject({ code: 'malformed' })
  expect(saved.state.aborted).toBe(true)
})

test('unknown status strings are malformed and do not complete the job', async () => {
  const rng = xorshift(0xc0ffee)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
  for (let n = 0; n < 20; n += 1) {
    let status = 'X'
    const length = 1 + (rng() % 12)
    for (let i = 0; i < length; i += 1) status += alphabet[rng() % alphabet.length]
    const saved = memorySink()
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
      return jsonResponse({ status, error: `bad ${API_KEY}` })
    })
    const error = await generateVeniceVideo({
      apiKey: API_KEY,
      model: MODEL,
      prompt: 'a gondola',
    }, clock(fetchImpl, saved.sink).deps).catch((caught) => caught)
    expect(error.code).toBe('malformed')
    expect(error.message).not.toContain(API_KEY)
    expect(calls.some((url) => url.endsWith('/video/complete'))).toBe(false)
    expect(saved.state.aborted).toBe(true)
  }
})

test('cancelling between download chunks leaves no file and does not complete', async () => {
  const controller = new AbortController()
  const bytes = fakeMp4(48)
  const calls: string[] = []
  const saved = memorySink()
  let pulls = 0
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(String(url))
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    const stream = new ReadableStream({
      pull(streamController) {
        pulls += 1
        if (pulls === 1) {
          streamController.enqueue(bytes.subarray(0, 40))
          return
        }
        controller.abort()
        streamController.error(new DOMException('Aborted', 'AbortError'))
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
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

test('an already aborted signal never touches the network', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchImpl = vi.fn(async () => jsonResponse({ queue_id: QUEUE_ID }))
  const saved = memorySink()
  const timed = clock(fetchImpl, saved.sink)
  timed.deps.signal = controller.signal

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'cancelled' })

  expect(fetchImpl).not.toHaveBeenCalled()
  expect(saved.state.finished).toBe(false)
})

test('a slow stream that crosses the deadline aborts the partial file', async () => {
  const bytes = fakeMp4(64, 0x55)
  const saved = memorySink()
  let nowMs = 0
  let offset = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    const stream = new ReadableStream({
      pull(controller) {
        nowMs += 2000
        if (offset >= bytes.byteLength) {
          controller.close()
          return
        }
        controller.enqueue(bytes.subarray(offset, offset + 16))
        offset += 16
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
  })
  const timed = clock(fetchImpl, saved.sink, 5000)
  timed.deps.now = () => nowMs

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'a gondola',
  }, timed.deps)).rejects.toMatchObject({ code: 'timeout' })

  expect(saved.state.finished).toBe(false)
  expect(saved.state.aborted).toBe(true)
  expect(saved.chunks.length).toBeGreaterThan(0)
  expect(joined(saved.chunks).byteLength).toBeLessThan(bytes.byteLength)
})

test('concurrent jobs keep their own bytes, and one abort does not cancel the other', async () => {
  async function run(model: string, fill: number, fileUrl: string) {
    const bytes = fakeMp4(20, fill)
    const saved = memorySink(fileUrl)
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body || '{}')) as { model?: string }
      if (body.model && body.model !== model) throw new Error(`crossed ${body.model}`)
      if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
      if (String(url).endsWith('/video/retrieve')) return mp4Response(bytes)
      return jsonResponse({ success: true })
    })
    const url = await generateVeniceVideo({
      apiKey: API_KEY,
      model,
      prompt: `job ${fill}`,
    }, clock(fetchImpl, saved.sink).deps)
    return { url, bytes: joined(saved.chunks), expected: Buffer.from(bytes), aborted: saved.state.aborted }
  }

  const results = await Promise.all([
    run('model-a', 1, 'file:///tmp/a.mp4'),
    run('model-b', 2, 'file:///tmp/b.mp4'),
    run('model-c', 3, 'file:///tmp/c.mp4'),
    run('model-d', 4, 'file:///tmp/d.mp4'),
    run('model-e', 5, 'file:///tmp/e.mp4'),
    run('model-f', 6, 'file:///tmp/f.mp4'),
  ])

  expect(results.map((result) => result.url)).toEqual([
    'file:///tmp/a.mp4',
    'file:///tmp/b.mp4',
    'file:///tmp/c.mp4',
    'file:///tmp/d.mp4',
    'file:///tmp/e.mp4',
    'file:///tmp/f.mp4',
  ])
  for (const result of results) {
    expect(result.aborted).toBe(false)
    expect(result.bytes).toEqual(result.expected)
  }
  const distinct = new Set(results.map((result) => result.bytes.toString('hex')))
  expect(distinct.size).toBe(results.length)

  const controller = new AbortController()
  controller.abort()
  const cancelled = memorySink('file:///tmp/cancelled.mp4')
  const healthy = memorySink('file:///tmp/healthy.mp4')
  const healthyBytes = fakeMp4(8, 0x77)
  const cancelledFetch = vi.fn(async () => {
    throw new Error('cancelled job must not fetch')
  })
  const healthyFetch = vi.fn(async (url: string) => {
    if (String(url).endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    if (String(url).endsWith('/video/retrieve')) return mp4Response(healthyBytes)
    return jsonResponse({ success: true })
  })
  const cancelledClock = clock(cancelledFetch, cancelled.sink)
  cancelledClock.deps.signal = controller.signal
  const [bad, good] = await Promise.allSettled([
    generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'stop' }, cancelledClock.deps),
    generateVeniceVideo({ apiKey: API_KEY, model: MODEL, prompt: 'go' }, clock(healthyFetch, healthy.sink).deps),
  ])

  expect(bad.status).toBe('rejected')
  expect((bad as PromiseRejectedResult).reason.code).toBe('cancelled')
  expect(cancelledFetch).not.toHaveBeenCalled()
  expect(good.status).toBe('fulfilled')
  expect(healthy.state.finished).toBe(true)
  expect(joined(healthy.chunks)).toEqual(Buffer.from(healthyBytes))
})

test('queue body fuzz stays inside the strict field set or rejects', () => {
  const rng = xorshift(0x1234abcd)
  const alphabet = 'abcXYZ09._- /\\\u0000\n\r\t..'
  const allowed = new Set(['model', 'prompt', 'duration', 'resolution', 'aspect_ratio', 'image_url'])
  for (let n = 0; n < 60; n += 1) {
    const modelLength = rng() % 140
    let model = ''
    for (let i = 0; i < modelLength; i += 1) model += alphabet[rng() % alphabet.length]
    const promptLength = rng() % 80
    let prompt = ''
    for (let i = 0; i < promptLength; i += 1) prompt += alphabet[rng() % alphabet.length]
    if (rng() % 5 === 0) prompt = 'x'.repeat(20001)
    try {
      const body = buildVeniceQueueBody({
        model,
        prompt,
        duration: rng() % 2 === 0 ? `${(rng() % 40)}s` : rng() % 20,
        resolution: rng() % 2 === 0 ? '720p' : 'nope',
        aspectRatio: rng() % 2 === 0 ? '16:9' : 'wide',
      })
      expect(Object.keys(body).every((key) => allowed.has(key))).toBe(true)
      expect(body.model.length).toBeGreaterThan(0)
      expect(body.model.length).toBeLessThanOrEqual(128)
      expect(body.prompt.length).toBeGreaterThan(0)
      expect(body.prompt).not.toContain('\u0000')
      expect(JSON.stringify(body)).not.toContain(API_KEY)
    } catch (error) {
      expect(error).toBeInstanceOf(VeniceVideoError)
      expect((error as VeniceVideoError).code).toBe('invalid')
    }
  }
})
