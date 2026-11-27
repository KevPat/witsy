import { expect, test, vi } from 'vitest'
import {
  generateVeniceVideo,
  MediaSink,
  VeniceVideoError,
} from '@services/venice_video'

const API_KEY = 'sk-pressure-test-only'
const MODEL = 'wan-2.5-preview-text-to-video'
const QUEUE_ID = 'pressure_queue_0001'

type SinkState = {
  aborted: boolean
  finished: boolean
  chunks: Uint8Array[]
}

function fakeMp4(extra = 64): Uint8Array {
  const header = Uint8Array.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ])
  const bytes = new Uint8Array(header.length + extra)
  bytes.set(header)
  return bytes
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sink(): { mediaSink: MediaSink, state: SinkState } {
  const state: SinkState = { aborted: false, finished: false, chunks: [] }
  return {
    state,
    mediaSink: {
      async write(chunk) {
        state.chunks.push(new Uint8Array(chunk))
      },
      async finish() {
        state.finished = true
        return 'file:///tmp/venice-pressure.mp4'
      },
      async abort() {
        state.aborted = true
      },
    },
  }
}

function timedDeps(fetchImpl: typeof fetch, mediaSink: MediaSink, timeoutMs = 120000) {
  let now = 0
  const sleeps: number[] = []
  return {
    sleeps,
    advance(ms: number) {
      now += ms
    },
    deps: {
      fetch: fetchImpl,
      sink: mediaSink,
      timeoutMs,
      now: () => now,
      sleep: async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        sleeps.push(ms)
        now += ms
      },
    },
  }
}

test('retrieve retries mixed 429/500/503 bursts without escaping the deadline', async () => {
  const saved = sink()
  const statuses = [429, 500, 503]
  let retrieve = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    if (url.endsWith('/video/retrieve')) {
      const status = statuses[retrieve++]
      if (status) {
        return jsonResponse(
          { error: `transient ${status}` },
          status,
          status === 429 ? { 'retry-after': '0.25' } : {},
        )
      }
      return new Response(fakeMp4(), { headers: { 'content-type': 'video/mp4' } })
    }
    return jsonResponse({ success: true })
  })
  const timed = timedDeps(fetchImpl, saved.mediaSink, 30000)

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'retry pressure',
  }, timed.deps)).resolves.toBe('file:///tmp/venice-pressure.mp4')

  expect(retrieve).toBe(4)
  expect(timed.sleeps).toEqual([1000, 8000, 16000])
  expect(saved.state.finished).toBe(true)
})

test('retrieve processing and retry delays share a bounded deadline', async () => {
  const saved = sink()
  let retrieve = 0
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    retrieve += 1
    if (retrieve % 3 === 0) return jsonResponse({ error: 'busy' }, 503)
    return jsonResponse({
      status: 'PROCESSING',
      average_execution_time: 60000,
      execution_duration: retrieve * 1000,
    })
  })
  const timed = timedDeps(fetchImpl, saved.mediaSink, 17000)

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'deadline pressure',
  }, timed.deps)).rejects.toMatchObject({ code: 'timeout' })

  expect(timed.sleeps.reduce((sum, delay) => sum + delay, 0)).toBe(17000)
  expect(retrieve).toBeLessThan(10)
  expect(saved.state.aborted).toBe(true)
  expect(saved.state.finished).toBe(false)
})

test('an oversized chunked download is stopped even without content-length', async () => {
  const saved = sink()
  const bytes = fakeMp4(16 * 1024)
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          controller.enqueue(bytes.subarray(offset, offset + 1024))
        }
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'video/mp4' } })
  })
  const timed = timedDeps(fetchImpl, saved.mediaSink)
  timed.deps.maxBytes = 8192

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'large stream',
  }, timed.deps)).rejects.toMatchObject({ code: 'invalid' })

  expect(saved.state.aborted).toBe(true)
  expect(saved.state.finished).toBe(false)
  expect(saved.state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBeLessThanOrEqual(8192)
})

test('truncated and garbage streams never publish a partial file', async () => {
  const bodies: ReadableStream<Uint8Array>[] = [
    new ReadableStream({
      start(controller) {
        controller.enqueue(fakeMp4(0))
        controller.error(new TypeError('socket closed'))
      },
    }),
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not an mp4 payload'))
        controller.close()
      },
    }),
  ]

  for (const body of bodies) {
    const saved = sink()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
      return new Response(body, { headers: { 'content-type': 'video/mp4' } })
    })

    await expect(generateVeniceVideo({
      apiKey: API_KEY,
      model: MODEL,
      prompt: 'bad stream',
    }, timedDeps(fetchImpl, saved.mediaSink).deps)).rejects.toBeInstanceOf(VeniceVideoError)

    expect(saved.state.aborted).toBe(true)
    expect(saved.state.finished).toBe(false)
  }
})

test('cancellation after the first download write aborts the partial file', async () => {
  const controller = new AbortController()
  const bytes = fakeMp4(128)
  const state: SinkState = { aborted: false, finished: false, chunks: [] }
  const mediaSink: MediaSink = {
    async write(chunk) {
      state.chunks.push(new Uint8Array(chunk))
      controller.abort()
    },
    async finish() {
      state.finished = true
      return 'file:///tmp/should-not-exist.mp4'
    },
    async abort() {
      state.aborted = true
    },
  }
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(bytes.subarray(0, 48))
        streamController.enqueue(bytes.subarray(48))
        streamController.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'video/mp4' } })
  })
  const timed = timedDeps(fetchImpl, mediaSink)
  timed.deps.signal = controller.signal

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'cancel during download',
  }, timed.deps)).rejects.toMatchObject({ code: 'cancelled' })

  expect(state.chunks).toHaveLength(1)
  expect(state.aborted).toBe(true)
  expect(state.finished).toBe(false)
})

test('concurrent jobs keep queue ids, sinks, and completion isolated', async () => {
  const jobs = Array.from({ length: 24 }, (_, index) => {
    const saved = sink()
    return { index, ...saved }
  })
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>
    if (url.endsWith('/video/queue')) {
      const index = Number(body.prompt.split('-').at(-1))
      return jsonResponse({ queue_id: `pressure_queue_${String(index).padStart(4, '0')}` })
    }
    if (url.endsWith('/video/retrieve')) {
      const index = Number(body.queue_id.split('_').at(-1))
      const bytes = fakeMp4(1)
      bytes[bytes.length - 1] = index
      return new Response(bytes, { headers: { 'content-type': 'video/mp4' } })
    }
    return jsonResponse({ success: true })
  })

  const results = await Promise.all(jobs.map(async (job) => {
    const result = await generateVeniceVideo({
      apiKey: API_KEY,
      model: MODEL,
      prompt: `concurrent-${job.index}`,
    }, timedDeps(fetchImpl, job.mediaSink).deps)
    return {
      result,
      marker: job.state.chunks.at(-1)?.at(-1),
      state: job.state,
    }
  }))

  expect(results.map((result) => result.marker)).toEqual(jobs.map((job) => job.index))
  expect(results.every((result) => result.result === 'file:///tmp/venice-pressure.mp4')).toBe(true)
  expect(results.every((result) => result.state.finished && !result.state.aborted)).toBe(true)
})

test('malformed JSON fuzz cases fail closed without writing bytes', async () => {
  const malformed = [
    '',
    'null',
    '[]',
    '{}',
    '{"queue_id":',
    '{"queue_id":null}',
    '{"queue_id":"short"}',
    '{"queue_id":"../escape_escape"}',
    '\u0000\u0001',
    'x'.repeat(4096),
  ]

  for (const payload of malformed) {
    const saved = sink()
    const fetchImpl = vi.fn(async () => new Response(payload, {
      headers: { 'content-type': 'application/json' },
    }))

    await expect(generateVeniceVideo({
      apiKey: API_KEY,
      model: MODEL,
      prompt: 'malformed fuzz',
    }, timedDeps(fetchImpl, saved.mediaSink).deps)).rejects.toMatchObject({ code: 'malformed' })

    expect(saved.state.chunks).toHaveLength(0)
    expect(saved.state.aborted).toBe(true)
    expect(saved.state.finished).toBe(false)
  }
})

test('a stream that advances beyond the deadline is cancelled before its next chunk', async () => {
  const saved = sink()
  const bytes = fakeMp4(64)
  const timed = timedDeps(vi.fn(), saved.mediaSink, 5000)
  let read = 0
  let cancelled = false
  const response = {
    status: 200,
    ok: true,
    type: 'basic',
    headers: new Headers({ 'content-type': 'video/mp4' }),
    body: {
      getReader: () => ({
        async read() {
          timed.advance(6000)
          const value = read++ === 0 ? bytes.subarray(0, 48) : bytes.subarray(48)
          return { done: false, value }
        },
        async cancel() {
          cancelled = true
        },
        releaseLock() {},
      }),
    },
  } as unknown as Response
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/video/queue')) return jsonResponse({ queue_id: QUEUE_ID })
    return response
  })
  timed.deps.fetch = fetchImpl

  await expect(generateVeniceVideo({
    apiKey: API_KEY,
    model: MODEL,
    prompt: 'slow stream',
  }, timed.deps)).rejects.toMatchObject({ code: 'timeout' })

  expect(read).toBe(1)
  expect(cancelled).toBe(true)
  expect(saved.state.aborted).toBe(true)
  expect(saved.state.finished).toBe(false)
})
