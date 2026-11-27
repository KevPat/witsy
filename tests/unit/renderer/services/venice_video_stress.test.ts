import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  defaultSleep,
  generateVeniceVideo,
  MediaSink,
  VENICE_API_BASE,
  VENICE_MAX_VIDEO_BYTES,
  VeniceGenerateDeps,
  VeniceVideoError,
} from '@services/venice_video'

// Stress and fuzz tests for the Venice video client.
//
// Every request in this file is answered by an in-memory fake. The global
// fetch is replaced with a function that throws, so nothing can reach the
// network even by mistake. The API key below is not a real key.
//
// Tests declared with test.fails describe a bug that exists today. They assert
// the behaviour the client should have, and vitest reports them as passing
// while the bug is present. When a bug is fixed its test starts to "fail":
// drop the .fails and it becomes a normal regression test.

const API_KEY = 'sk-fake.$tress*key[0]'
const MODEL = 'wan-2.5-preview-text-to-video'
const QUEUE_ID = '123e4567-e89b-12d3-a456-426614174000'
const DOWNLOAD = 'https://private-share.example.test/v1/share/read/abc'
const CODES = ['cancelled', 'timeout', 'failed', 'rate_limit', 'invalid', 'network', 'malformed', 'unavailable']
const MIB = 1024 * 1024

type Call = {
  url: string
  method: string
  body: any
  headers: Record<string, string>
  signal?: AbortSignal
}

type Handler = (call: Call, count: number) => Response | Promise<Response>
type RouteName = 'queue' | 'retrieve' | 'complete' | 'download' | 'remove'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('the network is disabled in tests')
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Deterministic random numbers, so a failing round can be replayed.
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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

function mp4(size: number, stamp = 0): Uint8Array {
  const out = new Uint8Array(Math.max(size, 24))
  out.set([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ])
  for (let i = 24; i < out.length; i++) out[i] = (i * 31 + stamp * 17 + 1) & 0xff
  return out
}

// Random bytes that cannot be mistaken for an MP4: no 'f' in the sniffed header.
function garbage(random: () => number, size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    let value = int(random, 0, 255)
    if (i < 64 && value === 0x66) value = 0x67
    out[i] = value
  }
  return out
}

function split(bytes: Uint8Array, random: () => number, maxChunk: number, allowEmpty = true): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    if (allowEmpty && random() < 0.1) chunks.push(new Uint8Array(0))
    const size = Math.min(int(random, 1, maxChunk), bytes.byteLength - offset)
    chunks.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  return chunks
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(sum(chunks.map((chunk) => chunk.byteLength)))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function raw(body: string, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }): Response {
  return new Response(body, { status, headers })
}

function video(body: BodyInit, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4', ...headers } })
}

type StreamOptions = {
  before?: (index: number) => void | Promise<void>
  failAt?: number
  stallAt?: number
  signal?: AbortSignal
}

// A pull-based body: one chunk is produced per read, like a slow connection.
function streamBody(chunks: Uint8Array[], options: StreamOptions = {}) {
  const probe = { pulls: 0, delivered: 0, cancelled: false }
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      options.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('Aborted', 'AbortError'))
        } catch {
          // The stream had already ended.
        }
      }, { once: true })
    },
    async pull(controller) {
      probe.pulls += 1
      await options.before?.(index)
      if (options.stallAt === index) return new Promise<void>(() => { /* never answers */ })
      if (options.failAt === index) {
        controller.error(new TypeError('network error'))
        return
      }
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index])
      index += 1
      probe.delivered = index
    },
    cancel() {
      probe.cancelled = true
    },
  }, { highWaterMark: 0 })
  return { stream, probe }
}

type SinkProbe = {
  sink: MediaSink
  writes: Uint8Array[]
  finished: number
  aborted: number
  url: string
  keep: boolean
  byteCount: number
  onWrite?: (index: number, chunk: Uint8Array) => void | Promise<void>
  onFinish?: () => void | Promise<void>
  onAbort?: () => void | Promise<void>
  bytes: () => Uint8Array
}

function sinkProbe(url = 'file:///tmp/stress.mp4'): SinkProbe {
  const probe: SinkProbe = {
    writes: [],
    finished: 0,
    aborted: 0,
    url,
    keep: true,
    byteCount: 0,
    bytes: () => concat(probe.writes),
    sink: {
      async write(chunk: Uint8Array) {
        const index = probe.writes.length
        probe.byteCount += chunk.byteLength
        probe.writes.push(probe.keep ? new Uint8Array(chunk) : new Uint8Array(0))
        await probe.onWrite?.(index, chunk)
      },
      async finish() {
        await probe.onFinish?.()
        probe.finished += 1
        return probe.url
      },
      async abort() {
        probe.aborted += 1
        await probe.onAbort?.()
      },
    },
  }
  return probe
}

function fakeClock(start = 0) {
  const state = {
    now: start,
    sleeps: [] as number[],
    frozen: false,
    onSleep: undefined as undefined | ((ms: number, index: number) => void | Promise<void>),
  }
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      state.sleeps.push(ms)
      if (!state.frozen) state.now += ms
      await state.onSleep?.(ms, state.sleeps.length - 1)
    },
  }
}

function router(routes: Partial<Record<RouteName, Handler>> = {}, downloadUrl = DOWNLOAD) {
  const calls: Call[] = []
  const unexpected: string[] = []
  const counts: Record<RouteName, number> = { queue: 0, retrieve: 0, complete: 0, download: 0, remove: 0 }
  const defaults: Record<RouteName, Handler> = {
    queue: () => json({ model: MODEL, queue_id: QUEUE_ID }),
    retrieve: () => video(mp4(256)),
    complete: () => json({ success: true }),
    download: () => video(mp4(256)),
    remove: () => new Response(null, { status: 204 }),
  }
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method || 'GET').toUpperCase()
    const call: Call = {
      url,
      method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init.headers || {}) as Record<string, string>,
      signal: init.signal || undefined,
    }
    calls.push(call)
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    let name: RouteName | null = null
    if (url === `${VENICE_API_BASE}/video/queue` && method === 'POST') name = 'queue'
    else if (url === `${VENICE_API_BASE}/video/retrieve` && method === 'POST') name = 'retrieve'
    else if (url === `${VENICE_API_BASE}/video/complete` && method === 'POST') name = 'complete'
    else if (url === downloadUrl && method === 'GET') name = 'download'
    else if (url === downloadUrl && method === 'DELETE') name = 'remove'
    if (!name) {
      unexpected.push(`${method} ${url}`)
      throw new Error(`unexpected request ${method} ${url}`)
    }
    counts[name] += 1
    return (routes[name] || defaults[name])(call, counts[name])
  }) as typeof fetch
  return { fetch: fetchImpl, calls, counts, unexpected }
}

function request(overrides: Record<string, unknown> = {}) {
  return { apiKey: API_KEY, model: MODEL, prompt: 'a gondola', ...overrides }
}

type Outcome = { url?: string, error?: VeniceVideoError }

async function outcome(job: Promise<string>): Promise<Outcome> {
  try {
    return { url: await job }
  } catch (error) {
    return { error: error as VeniceVideoError }
  }
}

function track(job: Promise<string>) {
  const state: { status: 'pending' | 'resolved' | 'rejected', url?: string, error?: VeniceVideoError } = { status: 'pending' }
  job.then((url) => {
    state.status = 'resolved'
    state.url = url
  }, (error) => {
    state.status = 'rejected'
    state.error = error
  })
  return state
}

function run(net: ReturnType<typeof router>, probe: SinkProbe, clock: ReturnType<typeof fakeClock>, extra: Partial<VeniceGenerateDeps> = {}, overrides: Record<string, unknown> = {}) {
  return outcome(generateVeniceVideo(request(overrides), {
    fetch: net.fetch,
    sink: probe.sink,
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  }))
}

// What every failure must look like, whatever caused it.
function expectCleanFailure(error: VeniceVideoError | undefined, probe: SinkProbe, code?: string) {
  expect(error).toBeInstanceOf(VeniceVideoError)
  expect(CODES).toContain(error.code)
  if (code) expect(error.code).toBe(code)
  expect(error.message.length).toBeGreaterThan(0)
  expect(error.message.length).toBeLessThanOrEqual(300)
  expect(error.message).not.toContain(API_KEY)
  expect(error.message).not.toMatch(/https?:\/\//i)
  // eslint-disable-next-line no-control-regex
  expect(error.message).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  expect(probe.finished).toBe(0)
  expect(probe.aborted).toBeGreaterThanOrEqual(1)
}

function expectSaved(result: Outcome, probe: SinkProbe, expected: Uint8Array) {
  expect(result.error).toBeUndefined()
  expect(result.url).toBe(probe.url)
  expect(probe.finished).toBe(1)
  expect(probe.aborted).toBe(0)
  expect(Buffer.from(probe.bytes()).equals(Buffer.from(expected))).toBe(true)
}

describe('retrieve loop deadlines', () => {

  test('a job that never finishes stops exactly at the deadline, whatever the server hints', async () => {
    const random = prng(1)
    const hint = () => pick<unknown>(random, [undefined, null, 0, -1, -1e12, 1e15, 'soon', int(random, 1, 300000), int(random, 1, 300000) + 0.5])
    for (let round = 0; round < 60; round++) {
      const timeoutMs = int(random, 1, 600000)
      const clock = fakeClock(int(random, 0, 2 ** 40))
      const probe = sinkProbe()
      const net = router({
        retrieve: () => json({ status: 'PROCESSING', average_execution_time: hint(), execution_duration: hint() }),
      })

      const result = await run(net, probe, clock, { timeoutMs })

      expectCleanFailure(result.error, probe, 'timeout')
      const sleeps = clock.state.sleeps
      expect(sum(sleeps)).toBe(timeoutMs)
      for (const ms of sleeps.slice(0, -1)) {
        expect(ms).toBeGreaterThanOrEqual(5000)
        expect(ms).toBeLessThanOrEqual(30000)
      }
      expect(sleeps.at(-1)).toBeLessThanOrEqual(30000)
      expect(net.counts.retrieve).toBe(sleeps.length)
      expect(net.counts.complete).toBe(0)
      expect(net.unexpected).toEqual([])
    }
  })

  test('the poll interval follows the server estimate and stays between 5 and 30 seconds', async () => {
    const cases: [number, number, number][] = [
      [15000, 3000, 5000],
      [60000, 0, 20000],
      [300000, 0, 30000],
      [300000, 299999, 5000],
      [100000, 100000, 5000],
      [100000, 250000, 5000],
      [45000, 15000, 10000],
    ]
    for (const [average, elapsed, expected] of cases) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        retrieve: (_call, count) => count === 1
          ? json({ status: 'PROCESSING', average_execution_time: average, execution_duration: elapsed })
          : video(mp4(64)),
      })
      const result = await run(net, probe, clock)
      expect(result.url).toBe(probe.url)
      expect(clock.state.sleeps).toEqual([expected])
    }
  })

  test('a video that arrives before the deadline is kept, one that would arrive after is not fetched', async () => {
    const answer: Handler = (_call, count) => count === 1 ? json({ status: 'PROCESSING' }) : video(mp4(64))

    const early = { clock: fakeClock(), probe: sinkProbe(), net: router({ retrieve: answer }) }
    const kept = await run(early.net, early.probe, early.clock, { timeoutMs: 5001 })
    expect(kept.url).toBe(early.probe.url)
    expect(early.net.counts.retrieve).toBe(2)

    const late = { clock: fakeClock(), probe: sinkProbe(), net: router({ retrieve: answer }) }
    const dropped = await run(late.net, late.probe, late.clock, { timeoutMs: 5000 })
    expectCleanFailure(dropped.error, late.probe, 'timeout')
    expect(late.net.counts.retrieve).toBe(1)
    expect(late.net.counts.complete).toBe(0)
  })

  test('a clock that never advances cannot make the loop spin forever', async () => {
    const polling = { clock: fakeClock(), probe: sinkProbe(), net: router({ retrieve: () => json({ status: 'PROCESSING' }) }) }
    polling.clock.state.frozen = true
    const polled = await run(polling.net, polling.probe, polling.clock)
    expectCleanFailure(polled.error, polling.probe, 'timeout')
    expect(polling.net.counts.retrieve).toBe(400)

    const queueing = { clock: fakeClock(), probe: sinkProbe(), net: router({ queue: () => json({ error: 'busy' }, 429) }) }
    queueing.clock.state.frozen = true
    const queued = await run(queueing.net, queueing.probe, queueing.clock)
    expectCleanFailure(queued.error, queueing.probe, 'rate_limit')
    expect(queueing.net.counts.queue).toBe(9)
    expect(queueing.net.counts.retrieve).toBe(0)

    const fetching = {
      clock: fakeClock(),
      probe: sinkProbe(),
      net: router({
        queue: () => json({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD }),
        retrieve: () => json({ status: 'COMPLETED' }),
        download: () => json({ error: 'busy' }, 503),
      }),
    }
    fetching.clock.state.frozen = true
    const fetched = await run(fetching.net, fetching.probe, fetching.clock)
    expectCleanFailure(fetched.error, fetching.probe, 'unavailable')
    expect(fetching.net.counts.download).toBe(5)
  })

  test('a clock that jumps forward during a request ends the job at the next check', async () => {
    const clock = fakeClock(1000)
    const probe = sinkProbe()
    const net = router({
      retrieve: () => {
        clock.state.now += 60 * 60 * 1000
        return json({ status: 'PROCESSING' })
      },
    })
    const result = await run(net, probe, clock, { timeoutMs: 20 * 60 * 1000 })
    expectCleanFailure(result.error, probe, 'timeout')
    expect(net.counts.retrieve).toBe(1)
    expect(clock.state.sleeps).toEqual([])
  })

  test('a slow stream is abandoned once the deadline passes', async () => {
    const clock = fakeClock()
    const probe = sinkProbe()
    const chunks = split(mp4(100 * 512), prng(3), 512, false)
    let body: ReturnType<typeof streamBody>
    const net = router({
      retrieve: () => {
        body = streamBody(chunks, { before: () => { clock.state.now += 1000 } })
        return video(body.stream)
      },
    })

    const result = await run(net, probe, clock, { timeoutMs: 10000 })

    expectCleanFailure(result.error, probe, 'timeout')
    expect(body.probe.cancelled).toBe(true)
    expect(body.probe.delivered).toBeLessThanOrEqual(10)
    expect(probe.byteCount).toBeLessThan(100 * 512)
    expect(net.counts.complete).toBe(0)
  })

  test('a Retry-After longer than the time left turns into a timeout, not a long sleep', async () => {
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router({ retrieve: () => json({ error: 'slow down' }, 429, { 'retry-after': '60' }) })
    const result = await run(net, probe, clock, { timeoutMs: 10000 })
    expectCleanFailure(result.error, probe, 'timeout')
    expect(clock.state.sleeps).toEqual([10000])
    expect(net.counts.retrieve).toBe(1)
  })

  test.fails('BUG: a status request that never answers is cut off at the deadline', async () => {
    vi.useFakeTimers()
    const probe = sinkProbe()
    const net = router({ retrieve: () => new Promise<Response>(() => { /* the server never answers */ }) })
    const state = track(generateVeniceVideo(request(), { fetch: net.fetch, sink: probe.sink, timeoutMs: 60000 }))

    await vi.advanceTimersByTimeAsync(10 * 60000)

    expect(net.counts.retrieve).toBe(1)
    expect(state.status).toBe('rejected')
    expect(state.error.code).toBe('timeout')
  })

  test.fails('BUG: a download that stalls mid-stream is cut off at the deadline', async () => {
    vi.useFakeTimers()
    const probe = sinkProbe()
    const chunks = split(mp4(4096), prng(4), 512, false)
    const net = router({ retrieve: () => video(streamBody(chunks, { stallAt: 3 }).stream) })
    const state = track(generateVeniceVideo(request(), { fetch: net.fetch, sink: probe.sink, timeoutMs: 60000 }))

    await vi.advanceTimersByTimeAsync(10 * 60000)

    expect(probe.byteCount).toBeGreaterThan(0)
    expect(state.status).toBe('rejected')
    expect(state.error.code).toBe('timeout')
  })

  test.fails('BUG: a cleanup request that never answers does not hold back a video that is already saved', async () => {
    vi.useFakeTimers()
    const probe = sinkProbe()
    const net = router({ complete: () => new Promise<Response>(() => { /* the server never answers */ }) })
    const state = track(generateVeniceVideo(request(), { fetch: net.fetch, sink: probe.sink, timeoutMs: 60000 }))

    await vi.advanceTimersByTimeAsync(10 * 60000)

    expect(probe.finished).toBe(1)
    expect(state.status).toBe('resolved')
    expect(state.url).toBe(probe.url)
  })

  test.fails('BUG: one deadline covers queueing and polling together', async () => {
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router({
      queue: (_call, count) => count === 1
        ? json({ error: 'busy' }, 429, { 'retry-after': '50' })
        : json({ model: MODEL, queue_id: QUEUE_ID }),
      retrieve: () => json({ status: 'PROCESSING' }),
    })

    const result = await run(net, probe, clock, { timeoutMs: 60000 })

    expect(result.error.code).toBe('timeout')
    expect(sum(clock.state.sleeps)).toBeLessThanOrEqual(60000)
  })

})

describe('429 and 5xx bursts', () => {

  test('Retry-After is honoured within one second and one minute, and nonsense falls back to backoff', async () => {
    const start = Date.UTC(2030, 0, 1)
    const cases: [string, number][] = [
      ['0', 1000],
      ['0.0004', 1000],
      ['1', 1000],
      ['2', 2000],
      ['2.5', 2500],
      [' 7 ', 7000],
      ['59', 59000],
      ['60', 60000],
      ['61', 60000],
      ['86400', 60000],
      ['99999999999999999999', 60000],
      [new Date(start + 30000).toUTCString(), 30000],
      [new Date(start - 30000).toUTCString(), 1000],
      [new Date(start + 86400000).toUTCString(), 60000],
      ['soon', 4000],
      ['1e3', 4000],
      ['Infinity', 4000],
      ['NaN', 4000],
      ['120, 60', 4000],
      ['', 4000],
    ]
    for (const status of [429, 500, 503]) {
      for (const [header, expected] of cases) {
        const clock = fakeClock(start)
        const probe = sinkProbe()
        const net = router({
          retrieve: (_call, count) => count === 1 ? json({ error: 'later' }, status, { 'retry-after': header }) : video(mp4(64)),
        })
        const result = await run(net, probe, clock)
        expect(result.url, `status ${status} retry-after ${JSON.stringify(header)}`).toBe(probe.url)
        expect(clock.state.sleeps, `status ${status} retry-after ${JSON.stringify(header)}`).toEqual([expected])
      }
    }
  })

  test('backoff without Retry-After grows to thirty seconds and no further', async () => {
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router({ retrieve: (_call, count) => count <= 8 ? json({ error: 'busy' }, 503) : video(mp4(64)) })
    const result = await run(net, probe, clock)
    expect(result.url).toBe(probe.url)
    expect(clock.state.sleeps).toEqual([4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
  })

  test('eight transient answers in a row are survived three times over, because progress resets the count', async () => {
    const clock = fakeClock()
    const probe = sinkProbe()
    const script = [
      ...Array(8).fill(429), 'PROCESSING',
      ...Array(8).fill(503), 'PROCESSING',
      ...Array(8).fill(500), 'VIDEO',
    ]
    const payload = mp4(512)
    const net = router({
      retrieve: (_call, count) => {
        const step = script[count - 1]
        if (step === 'PROCESSING') return json({ status: 'PROCESSING' })
        if (step === 'VIDEO') return video(payload)
        return json({ error: 'busy' }, step as number, { 'retry-after': '1' })
      },
    })
    const result = await run(net, probe, clock)
    expectSaved(result, probe, payload)
    expect(net.counts.retrieve).toBe(script.length)
    expect(net.counts.complete).toBe(1)
  })

  test('the ninth transient answer in a row ends the job, and the last one names the failure', async () => {
    const cases: [(number | 'throw')[], string][] = [
      [Array(9).fill(429), 'rate_limit'],
      [Array(9).fill(500), 'unavailable'],
      [Array(9).fill(503), 'unavailable'],
      [[...Array(8).fill(429), 503], 'unavailable'],
      [[...Array(8).fill(503), 429], 'rate_limit'],
      [Array(9).fill('throw'), 'network'],
      [[429, 'throw', 503, 'throw', 500, 'throw', 429, 'throw', 'throw'], 'network'],
      [['throw', 429, 'throw', 503, 'throw', 500, 'throw', 429, 429], 'rate_limit'],
    ]
    for (const [script, code] of cases) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        retrieve: (_call, count) => {
          const step = script[count - 1]
          if (step === 'throw') throw new TypeError(`socket hang up ${API_KEY}`)
          return json({ error: `busy ${API_KEY}` }, step, { 'retry-after': '1' })
        },
      })
      const result = await run(net, probe, clock)
      expectCleanFailure(result.error, probe, code)
      expect(net.counts.retrieve).toBe(9)
      expect(net.counts.complete).toBe(0)
    }
  })

  test('random bursts end the way the retry budget says they should', async () => {
    const random = prng(11)
    for (let round = 0; round < 80; round++) {
      const script: (number | 'throw' | 'PROCESSING' | 'VIDEO')[] = []
      let expected = 'saved'
      const segments = int(random, 1, 5)
      for (let segment = 0; segment < segments && expected === 'saved'; segment++) {
        const burst = int(random, 0, 10)
        for (let i = 0; i < burst; i++) {
          const step = pick<number | 'throw'>(random, [429, 500, 503, 'throw'])
          script.push(step)
          if (i === 8) {
            expected = step === 'throw' ? 'network' : step === 429 ? 'rate_limit' : 'unavailable'
            break
          }
        }
        if (expected === 'saved') script.push(segment === segments - 1 ? 'VIDEO' : 'PROCESSING')
      }
      const payload = mp4(int(random, 24, 2048), round)
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        retrieve: (_call, count) => {
          const step = script[count - 1]
          if (step === 'throw') throw new TypeError('network down')
          if (step === 'PROCESSING') return json({ status: 'PROCESSING' })
          if (step === 'VIDEO') return video(payload)
          const headers: Record<string, string> = random() < 0.5 ? { 'retry-after': String(int(random, 0, 120)) } : {}
          return json({ error: 'busy' }, step, headers)
        },
      })

      const result = await run(net, probe, clock, { timeoutMs: 24 * 60 * 60 * 1000 })

      if (expected === 'saved') {
        expectSaved(result, probe, payload)
      } else {
        expectCleanFailure(result.error, probe, expected)
      }
      expect(net.counts.retrieve).toBe(script.length)
      for (const ms of clock.state.sleeps) {
        expect(ms).toBeGreaterThanOrEqual(1000)
        expect(ms).toBeLessThanOrEqual(60000)
      }
    }
  })

  test('a busy queue is retried with the same body and stops after the ninth refusal', async () => {
    const recovered = { clock: fakeClock(), probe: sinkProbe(), net: router({
      queue: (_call, count) => count <= 8
        ? json({ error: 'busy' }, pick(prng(count), [429, 500, 503]), { 'retry-after': '2' })
        : json({ model: MODEL, queue_id: QUEUE_ID }),
    }) }
    const saved = await run(recovered.net, recovered.probe, recovered.clock)
    expect(saved.url).toBe(recovered.probe.url)
    expect(recovered.net.counts.queue).toBe(9)
    expect(recovered.clock.state.sleeps).toEqual(Array(8).fill(2000))
    const bodies = recovered.net.calls.filter((call) => call.url.endsWith('/video/queue')).map((call) => JSON.stringify(call.body))
    expect(new Set(bodies).size).toBe(1)

    for (const [status, code] of [[429, 'rate_limit'], [500, 'unavailable'], [503, 'unavailable']] as [number, string][]) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ queue: () => json({ error: `busy ${API_KEY}` }, status) })
      const result = await run(net, probe, clock)
      expectCleanFailure(result.error, probe, code)
      expect(net.counts.queue).toBe(9)
      expect(net.counts.retrieve).toBe(0)
      expect(clock.state.sleeps).toEqual([4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
    }
  })

  test('the download link tolerates four bad answers and gives up on the fifth', async () => {
    const linked: Handler = () => json({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD })
    const done: Handler = () => json({ status: 'COMPLETED' })
    const payload = mp4(700)

    const cases: [(number | 'throw')[], string][] = [
      [[429, 503, 500, 'throw'], 'saved'],
      [['throw', 'throw', 'throw', 'throw'], 'saved'],
      [[429, 429, 429, 429, 429], 'rate_limit'],
      [[503, 503, 503, 503, 500], 'unavailable'],
      [[429, 'throw', 503, 'throw', 'throw'], 'network'],
      [[404], 'failed'],
      [[410], 'failed'],
      [[403], 'failed'],
      [[502], 'failed'],
      [[429, 410], 'failed'],
    ]
    for (const [script, expected] of cases) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        queue: linked,
        retrieve: done,
        download: (_call, count) => {
          const step = script[count - 1]
          if (step === undefined) return video(payload)
          if (step === 'throw') throw new TypeError('connection reset')
          return raw('nope', step, { 'content-type': 'text/plain', 'retry-after': '3' })
        },
      })

      const result = await run(net, probe, clock)

      if (expected === 'saved') {
        expectSaved(result, probe, payload)
        expect(net.counts.download).toBe(script.length + 1)
        expect(net.counts.remove).toBe(1)
        expect(net.counts.complete).toBe(1)
      } else {
        expectCleanFailure(result.error, probe, expected)
        expect(net.counts.download).toBe(script.length)
        expect(net.counts.remove).toBe(0)
        expect(net.counts.complete).toBe(0)
      }
      for (const call of net.calls.filter((entry) => entry.url === DOWNLOAD)) {
        expect(JSON.stringify(call.headers)).not.toContain(API_KEY)
        expect(call.headers.Authorization).toBeUndefined()
      }
    }
  })

  test.fails('BUG: a 502 or 504 from a gateway while polling is retried like a 503', async () => {
    for (const status of [502, 504]) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        retrieve: (_call, count) => count === 2
          ? raw('<html>bad gateway</html>', status, { 'content-type': 'text/html' })
          : count < 4 ? json({ status: 'PROCESSING' }) : video(mp4(64)),
      })
      const result = await run(net, probe, clock)
      expect(result.url, `status ${status}`).toBe(probe.url)
    }
  })

})

describe('huge, truncated, and garbage downloads', () => {

  test('any chunking of a valid file is saved byte for byte, inline or through a download link', async () => {
    const random = prng(21)
    for (let round = 0; round < 60; round++) {
      const maxChunk = pick(random, [1, 7, 31, 32, 33, 4096, 65536])
      const payload = mp4(int(random, 24, maxChunk < 64 ? 4000 : 200000), round)
      const chunks = split(payload, random, maxChunk)
      const linked = random() < 0.5
      const body = streamBody(chunks)
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        queue: () => json({ model: MODEL, queue_id: QUEUE_ID, ...(linked ? { download_url: DOWNLOAD } : {}) }),
        retrieve: () => linked ? json({ status: 'COMPLETED' }) : video(body.stream),
        download: () => video(body.stream, { 'content-type': pick(random, ['video/mp4', 'application/octet-stream', 'binary/octet-stream', 'VIDEO/MP4; codecs=avc1']) }),
      })

      const result = await run(net, probe, clock)

      expectSaved(result, probe, payload)
      expect(probe.writes.length).toBeLessThanOrEqual(chunks.length)
      if (payload.byteLength >= 32) expect(probe.writes[0].byteLength).toBeGreaterThanOrEqual(32)
      expect(net.counts.complete).toBe(1)
      expect(net.counts.remove).toBe(linked ? 1 : 0)
      expect(net.unexpected).toEqual([])
    }
  })

  test('garbage is never written, whatever its size, chunking, or content type', async () => {
    const random = prng(22)
    for (let round = 0; round < 100; round++) {
      const payload = garbage(random, pick(random, [0, 1, 11, 12, 31, 32, 33, 63, 64, 65, 4096, int(random, 0, 20000)]))
      const chunks = payload.byteLength ? split(payload, random, pick(random, [1, 16, 4096])) : []
      const linked = random() < 0.5
      const body = streamBody(chunks)
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        queue: () => json({ model: MODEL, queue_id: QUEUE_ID, ...(linked ? { download_url: DOWNLOAD } : {}) }),
        retrieve: () => linked ? json({ status: 'COMPLETED' }) : video(body.stream, { 'content-type': pick(random, ['video/mp4', 'application/octet-stream']) }),
        download: () => video(body.stream, { 'content-type': pick(random, ['video/mp4', 'application/octet-stream', 'text/html', 'text/plain', '']) }),
      })

      const result = await run(net, probe, clock)

      expectCleanFailure(result.error, probe, 'malformed')
      expect(probe.byteCount).toBe(0)
      expect(net.counts.complete).toBe(0)
      expect(net.counts.remove).toBe(0)
    }
  })

  test('text that is not a video is refused even when it is labelled as one', async () => {
    const bodies = [
      '{"status":"PROCESSING"}',
      '{"error":"Inference processing failed"}',
      '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
      'RIFF\u0000\u0000\u0000\u0000AVI LIST',
      '\u001aE\u00df\u00a3 webm webm webm webm webm webm webm webm',
      'GIF89a' + 'x'.repeat(200),
      '',
    ]
    for (const text of bodies) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => video(text) })
      const result = await run(net, probe, clock)
      expectCleanFailure(result.error, probe, 'malformed')
      expect(probe.byteCount).toBe(0)
    }
  })

  test('a download link that answers with JSON is refused without reading it as a video', async () => {
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router({
      queue: () => json({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD }),
      retrieve: () => json({ status: 'COMPLETED' }),
      download: () => json({ error: `expired ${API_KEY}` }),
    })
    const result = await run(net, probe, clock)
    expectCleanFailure(result.error, probe, 'malformed')
    expect(net.counts.download).toBe(1)
    expect(net.counts.remove).toBe(0)
  })

  test('the size limit is exact: the limit passes, one byte more does not', async () => {
    for (const [size, ok] of [[4095, true], [4096, true], [4097, false], [9000, false]] as [number, boolean][]) {
      const payload = mp4(size)
      const body = streamBody(split(payload, prng(size), 500, false))
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => video(body.stream) })
      const result = await run(net, probe, clock, { maxBytes: 4096 })
      if (ok) {
        expectSaved(result, probe, payload)
      } else {
        expectCleanFailure(result.error, probe, 'invalid')
        expect(probe.byteCount).toBeLessThanOrEqual(4096)
        expect(body.probe.cancelled).toBe(true)
        expect(net.counts.complete).toBe(0)
      }
    }
  })

  test('a declared length over the limit is refused before a single byte is read', async () => {
    const body = streamBody(split(mp4(8192), prng(5), 512, false))
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router({ retrieve: () => video(body.stream, { 'content-length': '4097' }) })
    const result = await run(net, probe, clock, { maxBytes: 4096 })
    expectCleanFailure(result.error, probe, 'invalid')
    expect(body.probe.pulls).toBe(0)
    expect(body.probe.cancelled).toBe(true)
    expect(probe.byteCount).toBe(0)
  })

  test('a declared length that lies or is nonsense does not get past the running count', async () => {
    for (const header of ['10', '0', '-1', '1e3', 'abc', '', '4096 ', '0x10', '4096.5', '+4096']) {
      const body = streamBody(split(mp4(8192), prng(6), 512, false))
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => video(body.stream, { 'content-length': header }) })
      const result = await run(net, probe, clock, { maxBytes: 4096 })
      expectCleanFailure(result.error, probe, 'invalid')
      expect(probe.byteCount, `content-length ${JSON.stringify(header)}`).toBeLessThanOrEqual(4096)
      expect(body.probe.cancelled).toBe(true)
    }
  })

  test('the default 512 MiB limit holds for a real-sized stream', async () => {
    const first = mp4(MIB)
    const filler = new Uint8Array(MIB)
    const chunkCount = VENICE_MAX_VIDEO_BYTES / MIB

    const exact = { clock: fakeClock(), probe: sinkProbe(), body: streamBody([first, ...Array(chunkCount - 1).fill(filler)]) }
    exact.probe.keep = false
    const exactNet = router({ retrieve: () => video(exact.body.stream) })
    const saved = await run(exactNet, exact.probe, exact.clock)
    expect(saved.url).toBe(exact.probe.url)
    expect(exact.probe.byteCount).toBe(VENICE_MAX_VIDEO_BYTES)
    expect(exact.probe.finished).toBe(1)

    const over = { clock: fakeClock(), probe: sinkProbe(), body: streamBody([first, ...Array(chunkCount - 1).fill(filler), new Uint8Array(1), filler, filler]) }
    over.probe.keep = false
    const overNet = router({ retrieve: () => video(over.body.stream) })
    const refused = await run(overNet, over.probe, over.clock)
    expectCleanFailure(refused.error, over.probe, 'invalid')
    expect(over.probe.byteCount).toBe(VENICE_MAX_VIDEO_BYTES)
    expect(over.body.probe.delivered).toBe(chunkCount + 1)
    expect(over.body.probe.cancelled).toBe(true)
  })

  test('a stream that breaks part way is not published, at any break point', async () => {
    const payload = mp4(6000)
    const chunks = split(payload, prng(8), 400, false)
    // failAt === chunks.length is a connection that dies after the last byte but before the clean end.
    for (let failAt = 0; failAt <= chunks.length; failAt += 1) {
      const body = streamBody(chunks, { failAt })
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => video(body.stream, { 'content-length': String(payload.byteLength) }) })

      const result = await run(net, probe, clock)

      expectCleanFailure(result.error, probe, 'network')
      expect(probe.byteCount).toBeLessThanOrEqual(payload.byteLength)
      expect(net.counts.complete).toBe(0)
      expect(net.counts.retrieve).toBe(1)
    }
  })

  test('files at the edge of the header check: under 12 bytes is refused, a bare header is kept', async () => {
    const header = mp4(24)
    for (const size of [0, 1, 4, 8, 11]) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => video(streamBody(size ? [header.subarray(0, size)] : []).stream) })
      const result = await run(net, probe, clock)
      expectCleanFailure(result.error, probe, 'malformed')
      expect(probe.byteCount).toBe(0)
    }
    for (const size of [12, 16, 24]) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => video(streamBody([header.subarray(0, size)]).stream) })
      const result = await run(net, probe, clock)
      expectSaved(result, probe, header.subarray(0, size))
      expect(probe.writes).toHaveLength(1)
    }
  })

  test('a response without a readable stream is checked the same way', async () => {
    const bodyless = (bytes: Uint8Array, headers: Record<string, string> = {}) => ({
      ok: true,
      status: 200,
      type: 'basic',
      body: null as ReadableStream<Uint8Array> | null,
      headers: new Headers({ 'content-type': 'video/mp4', ...headers }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }) as unknown as Response

    const payload = mp4(3000)
    const good = { clock: fakeClock(), probe: sinkProbe(), net: router({ retrieve: () => bodyless(payload) }) }
    expectSaved(await run(good.net, good.probe, good.clock), good.probe, payload)
    expect(good.probe.writes).toHaveLength(1)

    const big = { clock: fakeClock(), probe: sinkProbe(), net: router({ retrieve: () => bodyless(payload) }) }
    expectCleanFailure((await run(big.net, big.probe, big.clock, { maxBytes: 2999 })).error, big.probe, 'invalid')
    expect(big.probe.byteCount).toBe(0)

    const bad = { clock: fakeClock(), probe: sinkProbe(), net: router({ retrieve: () => bodyless(garbage(prng(9), 3000)) }) }
    expectCleanFailure((await run(bad.net, bad.probe, bad.clock)).error, bad.probe, 'malformed')
    expect(bad.probe.byteCount).toBe(0)
  })

  test('the stream is read one chunk at a time while the sink is busy', async () => {
    const payload = mp4(64 * 200)
    const body = streamBody(split(payload, prng(10), 64, false))
    const clock = fakeClock()
    const probe = sinkProbe()
    let overlaps = 0
    probe.onWrite = async () => {
      const before = body.probe.pulls
      await ticks(20)
      if (body.probe.pulls !== before) overlaps += 1
    }
    const net = router({ retrieve: () => video(body.stream) })

    const result = await run(net, probe, clock)

    expectSaved(result, probe, payload)
    expect(overlaps).toBe(0)
    expect(body.probe.pulls).toBe(body.probe.delivered + 1)
  })

  test('a sink that fails part way stops the download and surfaces a clean error', async () => {
    const failures: [string, (probe: SinkProbe) => void][] = [
      ['write', (probe) => { probe.onWrite = (index) => { if (index === 2) throw new Error(`ENOSPC: no space left ${API_KEY} https://disk.example/full`) } }],
      ['finish', (probe) => { probe.onFinish = () => { throw new Error('EXDEV: rename failed') } }],
      ['write+abort', (probe) => {
        probe.onWrite = (index) => { if (index === 1) throw new Error('EIO') }
        probe.onAbort = () => { throw new Error('abort failed too') }
      }],
    ]
    for (const [name, arm] of failures) {
      const body = streamBody(split(mp4(4000), prng(12), 300, false))
      const clock = fakeClock()
      const probe = sinkProbe()
      arm(probe)
      const net = router({ retrieve: () => video(body.stream) })

      const result = await run(net, probe, clock)

      expect(result.error, name).toBeInstanceOf(VeniceVideoError)
      expect(result.error.message).not.toContain(API_KEY)
      expect(result.error.message).not.toMatch(/https?:/)
      expect(probe.finished).toBe(0)
      expect(probe.aborted).toBeGreaterThanOrEqual(1)
      expect(net.counts.complete).toBe(0)
      if (name !== 'finish') expect(body.probe.cancelled).toBe(true)
    }
  })

  test('a sink that reports anything but a local file url is treated as a failure', async () => {
    for (const url of ['', 'https://evil.example/video.mp4', 'File:///tmp/x.mp4', '/tmp/x.mp4', undefined, null, 42]) {
      const clock = fakeClock()
      const probe = sinkProbe()
      probe.url = url as string
      const net = router()
      const result = await run(net, probe, clock)
      expect(result.error, String(url)).toBeInstanceOf(VeniceVideoError)
      expect(probe.aborted).toBeGreaterThanOrEqual(1)
      expect(net.counts.complete).toBe(0)
    }
  })

  test.fails('BUG: a download link that drops mid-stream is fetched again, as the Venice docs allow', async () => {
    const payload = mp4(6000)
    const chunks = split(payload, prng(13), 400, false)
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router({
      queue: () => json({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD }),
      retrieve: () => json({ status: 'COMPLETED' }),
      download: (_call, count) => video(streamBody(chunks, count === 1 ? { failAt: 5 } : {}).stream),
    })

    const result = await run(net, probe, clock)

    expect(net.counts.download).toBe(2)
    expect(result.url).toBe(probe.url)
  })

})

describe('cancellation', () => {

  test('a signal that is already aborted sends nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const clock = fakeClock()
    const probe = sinkProbe()
    const net = router()
    const result = await run(net, probe, clock, { signal: controller.signal })
    expect(result.error.code).toBe('cancelled')
    expect(net.calls).toHaveLength(0)
    expect(probe.finished).toBe(0)
  })

  test('cancelling at every step of a job stops it there, and nothing is published or cleaned up remotely', async () => {
    const payload = mp4(3000)
    const chunks = split(payload, prng(31), 256, false)

    const scenario = async (linked: boolean, abortAt: number) => {
      const controller = new AbortController()
      const clock = fakeClock()
      const probe = sinkProbe()
      const steps: string[] = []
      const step = (name: string) => {
        steps.push(name)
        if (steps.length === abortAt) controller.abort()
      }
      const guarded = (name: string, answer: Handler): Handler => (call, count) => {
        step(name)
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        return answer(call, count)
      }
      const net = router({
        queue: guarded('queue', (_call, count) => count === 1
          ? json({ error: 'busy' }, 429, { 'retry-after': '1' })
          : json({ model: MODEL, queue_id: QUEUE_ID, ...(linked ? { download_url: DOWNLOAD } : {}) })),
        retrieve: guarded('retrieve', (_call, count) => {
          if (count === 1) return json({ status: 'PROCESSING' })
          if (count === 2) return json({ error: 'busy' }, 503)
          if (linked) return json({ status: 'COMPLETED' })
          return video(streamBody(chunks, { signal: controller.signal }).stream)
        }),
        download: guarded('download', (_call, count) => count === 1
          ? raw('busy', 429, { 'content-type': 'text/plain' })
          : video(streamBody(chunks, { signal: controller.signal }).stream)),
        remove: guarded('remove', () => new Response(null, { status: 204 })),
        complete: guarded('complete', () => json({ success: true })),
      })
      clock.state.onSleep = () => step('sleep')
      probe.onWrite = () => step('write')
      probe.onFinish = () => step('finish')

      const result = await run(net, probe, clock, { signal: controller.signal })
      return { result, probe, net, steps }
    }

    for (const linked of [false, true]) {
      const baseline = await scenario(linked, -1)
      expectSaved(baseline.result, baseline.probe, payload)
      const finishStep = baseline.steps.indexOf('finish') + 1
      expect(finishStep).toBeGreaterThan(10)

      for (let abortAt = 1; abortAt <= baseline.steps.length; abortAt++) {
        const { result, probe, net, steps } = await scenario(linked, abortAt)
        const label = `linked=${linked} abort at step ${abortAt} (${baseline.steps[abortAt - 1]})`
        if (abortAt < finishStep) {
          expect(result.error?.code, label).toBe('cancelled')
          expect(result.error.message).toBe('Video generation was cancelled')
          expect(probe.finished, label).toBe(0)
          expect(probe.aborted, label).toBeGreaterThanOrEqual(1)
          expect(net.counts.complete, label).toBe(0)
          expect(net.counts.remove, label).toBe(0)
          expect(steps.length, label).toBeLessThanOrEqual(abortAt + 1)
        } else {
          // The file is already on disk: the job reports it instead of dropping it.
          expect(result.url, label).toBe(probe.url)
          expect(probe.finished, label).toBe(1)
          expect(probe.aborted, label).toBe(0)
        }
      }
    }
  })

  test('cancelling mid-download tears the stream down and keeps the partial bytes out of sight', async () => {
    const payload = mp4(64 * 100)
    const chunks = split(payload, prng(32), 64, false)
    for (const cancelAfter of [1, 2, 10, 50, 98]) {
      const controller = new AbortController()
      const body = streamBody(chunks, { signal: controller.signal })
      const clock = fakeClock()
      const probe = sinkProbe()
      probe.onWrite = (index) => { if (index + 1 === cancelAfter) controller.abort() }
      const net = router({ retrieve: () => video(body.stream) })

      const result = await run(net, probe, clock, { signal: controller.signal })

      expect(result.error.code).toBe('cancelled')
      expect(probe.writes).toHaveLength(cancelAfter)
      expect(probe.finished).toBe(0)
      expect(probe.aborted).toBeGreaterThanOrEqual(1)
      expect(net.counts.complete).toBe(0)
      expect(net.calls.filter((call) => call.url.endsWith('/video/retrieve'))).toHaveLength(1)
    }
  })

  test('cancelling while a request is in flight reports a cancel, not a network error', async () => {
    for (const route of ['queue', 'retrieve', 'download'] as RouteName[]) {
      const controller = new AbortController()
      const clock = fakeClock()
      const probe = sinkProbe()
      const hang: Handler = (call) => new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener('abort', () => reject(new TypeError(`fetch failed ${API_KEY}`)), { once: true })
        controller.abort()
      })
      const net = router({
        queue: route === 'queue' ? hang : () => json({ model: MODEL, queue_id: QUEUE_ID, download_url: DOWNLOAD }),
        retrieve: route === 'retrieve' ? hang : () => json({ status: 'COMPLETED' }),
        download: hang,
      })

      const result = await run(net, probe, clock, { signal: controller.signal })

      expect(result.error.code, route).toBe('cancelled')
      expect(result.error.message).not.toContain(API_KEY)
      expect(probe.finished).toBe(0)
      expect(net.counts.complete).toBe(0)
    }
  })

  test('the real sleep wakes at once on cancel and leaves no timer or listener behind', async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    for (let i = 0; i < 50; i++) {
      const nap = defaultSleep(5000, controller.signal)
      await vi.advanceTimersByTimeAsync(5000)
      await nap
    }
    expect(add).toHaveBeenCalledTimes(50)
    expect(remove).toHaveBeenCalledTimes(50)
    expect(vi.getTimerCount()).toBe(0)

    const interrupted = track(defaultSleep(30000, controller.signal).then(() => 'woke'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(interrupted.status).toBe('pending')
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(interrupted.status).toBe('rejected')
    expect(interrupted.error.code).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)

    await expect(defaultSleep(1000, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a job on the real clock is cancelled during its poll wait without waiting it out', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const probe = sinkProbe()
    const net = router({ retrieve: () => json({ status: 'PROCESSING', average_execution_time: 90000, execution_duration: 0 }) })
    const state = track(generateVeniceVideo(request(), { fetch: net.fetch, sink: probe.sink, signal: controller.signal }))

    await vi.advanceTimersByTimeAsync(65000)
    expect(net.counts.retrieve).toBe(3)
    expect(state.status).toBe('pending')

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(state.status).toBe('rejected')
    expect(state.error.code).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    expect(probe.aborted).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(10 * 60000)
    expect(net.counts.retrieve).toBe(3)
  })

})

describe('concurrent jobs', () => {

  test('many jobs in flight at once never mix their bytes, ids, or outcomes', async () => {
    for (const seed of [41, 42, 43]) {
      const random = prng(seed)
      type Job = {
        index: number
        queueId: string
        link: string | null
        payload: Uint8Array
        fate: 'saved' | 'rejected' | 'cancelled'
        polls: number
        completes: number
        removes: number
        controller: AbortController
        probe: SinkProbe
        clock: ReturnType<typeof fakeClock>
      }
      const jobs: Job[] = Array.from({ length: 40 }, (_unused, index) => ({
        index,
        queueId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        link: index % 5 === 0 ? `https://cdn.example.test/${seed}/job-${index}.mp4` : null,
        payload: mp4(int(random, 64, 6000), index + seed),
        fate: index % 7 === 3 ? 'rejected' : index % 11 === 5 ? 'cancelled' : 'saved',
        polls: 0,
        completes: 0,
        removes: 0,
        controller: new AbortController(),
        probe: sinkProbe(`file:///tmp/${seed}/job-${index}.mp4`),
        clock: fakeClock(index * 1000),
      }))
      const unexpected: string[] = []

      const sharedFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method || 'GET'
        const headers = (init.headers || {}) as Record<string, string>
        await ticks(int(random, 0, 6))
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

        if (url.startsWith(`${VENICE_API_BASE}/video/`)) {
          const body = JSON.parse(String(init.body))
          const job = url.endsWith('/video/queue')
            ? jobs[Number(String(body.prompt).slice(4))]
            : jobs.find((entry) => entry.queueId === body.queue_id)
          if (!job || headers.Authorization !== `Bearer key-${job.index}`) {
            unexpected.push(`${method} ${url} carried the wrong job or key`)
            throw new Error('unexpected request')
          }
          if (url.endsWith('/video/queue')) {
            return json({ model: MODEL, queue_id: job.queueId, ...(job.link ? { download_url: job.link } : {}) })
          }
          if (url.endsWith('/video/complete')) {
            job.completes += 1
            return json({ success: true })
          }
          job.polls += 1
          if (job.polls <= 2) return json({ status: 'PROCESSING' })
          if (job.fate === 'rejected') return json({ error: { message: `blocked job-${job.index}` } }, 422)
          if (job.fate === 'cancelled') {
            job.controller.abort()
            return json({ status: 'PROCESSING' })
          }
          if (job.link) return json({ status: 'COMPLETED' })
          return video(streamBody(split(job.payload, random, 512), { before: () => ticks(int(random, 0, 3)) }).stream)
        }

        const linked = jobs.find((entry) => entry.link === url)
        if (linked && headers.Authorization === undefined && method === 'GET') {
          return video(streamBody(split(linked.payload, random, 512), { before: () => ticks(int(random, 0, 3)) }).stream)
        }
        if (linked && headers.Authorization === undefined && method === 'DELETE') {
          linked.removes += 1
          return new Response(null, { status: 204 })
        }
        unexpected.push(`${method} ${url}`)
        throw new Error('unexpected request')
      }) as typeof fetch

      const results = await Promise.all(jobs.map((job) => {
        job.probe.onWrite = () => ticks(int(random, 0, 4))
        return outcome(generateVeniceVideo({
          apiKey: `key-${job.index}`,
          model: MODEL,
          prompt: `job-${job.index}`,
        }, {
          fetch: sharedFetch,
          sink: job.probe.sink,
          signal: job.controller.signal,
          now: job.clock.now,
          sleep: async (ms, signal) => {
            await ticks(int(random, 0, 5))
            await job.clock.sleep(ms, signal)
          },
        }))
      }))

      expect(unexpected).toEqual([])
      results.forEach((result, index) => {
        const job = jobs[index]
        const label = `seed ${seed} job ${index} (${job.fate})`
        if (job.fate === 'saved') {
          expect(result.url, label).toBe(`file:///tmp/${seed}/job-${index}.mp4`)
          expect(Buffer.from(job.probe.bytes()).equals(Buffer.from(job.payload)), label).toBe(true)
          expect(job.probe.finished, label).toBe(1)
          expect(job.probe.aborted, label).toBe(0)
          expect(job.completes, label).toBe(1)
          expect(job.removes, label).toBe(job.link ? 1 : 0)
        } else {
          expect(result.error?.code, label).toBe(job.fate === 'rejected' ? 'failed' : 'cancelled')
          if (job.fate === 'rejected') expect(result.error.message).toBe(`blocked job-${index}`)
          expect(job.probe.finished, label).toBe(0)
          expect(job.probe.aborted, label).toBeGreaterThanOrEqual(1)
          expect(job.probe.byteCount, label).toBe(0)
          expect(job.completes, label).toBe(0)
          expect(job.removes, label).toBe(0)
        }
      })
    }
  })

  test('one job being cancelled or timing out leaves its neighbours alone', async () => {
    const payload = mp4(2000)
    const make = (timeoutMs: number, signal?: AbortSignal) => {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({
        retrieve: async (_call, count) => {
          await ticks(3)
          return count <= 6 ? json({ status: 'PROCESSING' }) : video(payload)
        },
      })
      return { probe, net, job: run(net, probe, clock, { timeoutMs, signal }) }
    }
    const controller = new AbortController()
    const patient = make(120000)
    const impatient = make(12000)
    const stopped = make(120000, controller.signal)
    controller.abort()

    const [first, second, third] = await Promise.all([patient.job, impatient.job, stopped.job])

    expectSaved(first, patient.probe, payload)
    expectCleanFailure(second.error, impatient.probe, 'timeout')
    expect(third.error.code).toBe('cancelled')
    expect(patient.net.counts.retrieve).toBe(7)
  })

})

describe('malformed JSON', () => {

  test('a queue answer that is not a usable job is refused before any polling', async () => {
    const bodies = [
      '',
      ' ',
      'null',
      'true',
      '42',
      '"queued"',
      '[]',
      '{}',
      '{"model":"m"}',
      '{"queue_id":null}',
      '{"queue_id":12345678}',
      '{"queue_id":["a"]}',
      '{"queue_id":{"id":"x"}}',
      '{"queue_id":""}',
      '{"queue_id":"short"}',
      `{"queue_id":"${'a'.repeat(129)}"}`,
      '{"queue_id":"../../../etc/passwd"}',
      '{"queue_id":"1234 5678"}',
      '{"queue_id":"12345678\\n"}',
      '{"queue_id":"12345678\\u0000"}',
      '{"queue_id":"кириллица-1234"}',
      `{"queue_id":"${QUEUE_ID}","download_url":42}`,
      `{"queue_id":"${QUEUE_ID}","download_url":["https://x.example/a"]}`,
      `{"queue_id":"${QUEUE_ID}","download_url":{"href":"https://x.example/a"}}`,
      `{"queue_id":"${QUEUE_ID}"`,
      `{"queue_id":"${QUEUE_ID}"}}`,
      `\uFEFF{"queue_id":"${QUEUE_ID}"}x`,
      '<html><body>Just a moment...</body></html>',
      `{"queue_id":'${QUEUE_ID}'}`,
      '{"__proto__":{"queue_id":"12345678"}}',
    ]
    for (const body of bodies) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ queue: () => raw(body) })
      const result = await run(net, probe, clock)
      expectCleanFailure(result.error, probe, 'malformed')
      expect(net.counts.queue, JSON.stringify(body)).toBe(1)
      expect(net.counts.retrieve, JSON.stringify(body)).toBe(0)
      expect(probe.byteCount).toBe(0)
    }
  })

  test('a status answer that cannot be read ends the job without touching the file', async () => {
    const bodies = [
      '',
      'null',
      'false',
      '0',
      '"PROCESSING"',
      '[]',
      '["PROCESSING"]',
      '{}',
      '{"status":null}',
      '{"status":1}',
      '{"status":true}',
      '{"status":""}',
      '{"status":"   "}',
      '{"status":["PROCESSING"]}',
      '{"status":{"value":"PROCESSING"}}',
      '{"status":"PROCESSING"',
      '{"status":"PROCESSING"}{"status":"COMPLETED"}',
      '{"Status":"PROCESSING"}',
      '{"status":"DONE"}',
      '{"status":"processing…"}',
      'PROCESSING',
      '<html>502</html>',
    ]
    for (const body of bodies) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const net = router({ retrieve: () => raw(body) })
      const result = await run(net, probe, clock)
      expectCleanFailure(result.error, probe, 'malformed')
      expect(net.counts.retrieve, JSON.stringify(body)).toBe(1)
      expect(net.counts.complete).toBe(0)
      expect(probe.byteCount).toBe(0)
    }
  })

  test('status text is read loosely: case, padding, and extra fields do not matter', async () => {
    const bodies = [
      '{"status":"processing"}',
      '{"status":"  Processing\\n"}',
      '{"status":"PROCESSING","average_execution_time":"soon","execution_duration":null,"extra":{"deep":[1,2,3]}}',
      '{"status":"PROCESSING","is_draft":true,"draft_task_id":"x","can_upgrade_to_hd":false}',
      ' \n {"status":"PROCESSING"} \n ',
    ]
    for (const body of bodies) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const payload = mp4(100)
      const net = router({ retrieve: (_call, count) => count === 1 ? raw(body, 200, { 'content-type': 'application/json; charset=utf-8' }) : video(payload) })
      const result = await run(net, probe, clock)
      expectSaved(result, probe, payload)
      expect(clock.state.sleeps).toEqual([5000])
    }
  })

  test('a JSON answer of unreasonable size is refused', async () => {
    const declared = { clock: fakeClock(), probe: sinkProbe() }
    const declaredBody = streamBody([new TextEncoder().encode('{"status":"PROCESSING"}')])
    const declaredNet = router({ retrieve: () => new Response(declaredBody.stream, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(2 * MIB) } }) })
    expectCleanFailure((await run(declaredNet, declared.probe, declared.clock)).error, declared.probe, 'malformed')
    expect(declaredBody.probe.pulls).toBe(0)

    const actual = { clock: fakeClock(), probe: sinkProbe() }
    const actualNet = router({ retrieve: () => raw(`{"status":"PROCESSING","pad":"${'x'.repeat(MIB + 10)}"}`) })
    expectCleanFailure((await run(actualNet, actual.probe, actual.clock)).error, actual.probe, 'malformed')

    const queue = { clock: fakeClock(), probe: sinkProbe() }
    const queueNet = router({ queue: () => raw(`{"queue_id":"${QUEUE_ID}","pad":"${'x'.repeat(MIB + 10)}"}`) })
    expectCleanFailure((await run(queueNet, queue.probe, queue.clock)).error, queue.probe, 'malformed')
    expect(queueNet.counts.retrieve).toBe(0)
  })

  test('error bodies of every shape become one short, clean message', async () => {
    const hostile = `key=${API_KEY} Bearer ${API_KEY} see https://evil.example/?k=${API_KEY} \u0000\u0007\u001b[31m`
    const bodies = [
      '',
      'not json',
      '<html><body><h1>403 Forbidden</h1></body></html>',
      'null',
      '[]',
      '"just a string"',
      '{}',
      '{"error":null}',
      '{"error":42}',
      '{"error":[]}',
      '{"error":{}}',
      '{"error":{"message":null}}',
      '{"error":{"message":{"nested":true}}}',
      JSON.stringify({ error: hostile }),
      JSON.stringify({ error: { message: hostile, type: 'provider_content_policy', credits_refunded: true } }),
      JSON.stringify({ message: hostile }),
      JSON.stringify({ error: 'x'.repeat(100000) }),
      JSON.stringify({ error: `${'😀'.repeat(400)}${API_KEY}` }),
      JSON.stringify({ details: { _errors: [], prompt: { _errors: ['Required'] } }, error: 'Invalid request parameters' }),
      JSON.stringify({ error: { code: 'needs_consent', message: 'Additional consent is required' }, consent_flow: 'seedance' }),
      `{"error":"${hostile.slice(0, 20)}`,
    ]
    for (const status of [400, 401, 402, 403, 404, 409, 413, 415, 422, 451]) {
      for (const body of bodies) {
        for (const phase of ['queue', 'retrieve'] as RouteName[]) {
          const clock = fakeClock()
          const probe = sinkProbe()
          const net = router({ [phase]: () => raw(body, status) })
          const result = await run(net, probe, clock)
          expectCleanFailure(result.error, probe, 'failed')
          expect(net.counts[phase]).toBe(1)
          expect(net.counts.complete).toBe(0)
          expect(clock.state.sleeps).toEqual([])
        }
      }
    }
  })

  test('random JSON in place of the queue and status answers always ends in a clean result', async () => {
    const random = prng(51)
    const value = (depth: number): unknown => {
      const kind = int(random, 0, depth > 3 ? 6 : 9)
      if (kind === 0) return null
      if (kind === 1) return random() < 0.5
      if (kind === 2) return pick(random, [0, -1, 1, 1e308, -1e308, 5e-324, int(random, -1000, 1000), random() * 1e6])
      if (kind === 3) return pick(random, ['', 'PROCESSING', 'COMPLETED', 'FAILED', 'ERROR', 'CANCELLED', 'processing', QUEUE_ID, DOWNLOAD, API_KEY, 'file:///etc/passwd', '\u0000', 'a'.repeat(int(random, 0, 300))])
      if (kind === 4) return pick(random, ['queue_id', 'status', 'error', 'message', 'download_url'])
      if (kind === 5) return int(random, 0, 2 ** 31)
      if (kind === 6) return String.fromCharCode(...Array.from({ length: int(random, 0, 40) }, () => int(random, 0, 0xffff)))
      if (kind <= 8) return Array.from({ length: int(random, 0, 4) }, () => value(depth + 1))
      const record: Record<string, unknown> = {}
      const keys = ['queue_id', 'status', 'error', 'message', 'download_url', 'model', 'average_execution_time', 'execution_duration', 'constructor', 'toString']
      for (let i = int(random, 0, 5); i > 0; i--) record[pick(random, keys)] = value(depth + 1)
      return record
    }
    const record = (base: Record<string, unknown>): unknown => {
      const out = value(0)
      if (random() < 0.6 && out && typeof out === 'object' && !Array.isArray(out)) return { ...base, ...out }
      if (random() < 0.3) return base
      return out
    }

    for (let round = 0; round < 400; round++) {
      const clock = fakeClock()
      const probe = sinkProbe()
      const payload = mp4(128, round)
      const queueAnswer = record({ model: MODEL, queue_id: QUEUE_ID })
      const statusAnswer = record({ status: 'PROCESSING' })
      const linkAllowed = [DOWNLOAD]
      const net = router({
        queue: () => json(queueAnswer),
        retrieve: (_call, count) => count === 1 ? json(statusAnswer) : video(payload),
        download: () => video(payload),
      })
      const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (!url.startsWith(VENICE_API_BASE) && !linkAllowed.includes(url)) {
          // A fuzzed download_url: answer it locally, never forward it.
          return (init?.method === 'DELETE') ? new Response(null, { status: 204 }) : raw('gone', 410, { 'content-type': 'text/plain' })
        }
        return net.fetch(input, init)
      }) as typeof fetch

      const result = await outcome(generateVeniceVideo(request(), {
        fetch: guarded,
        sink: probe.sink,
        now: clock.now,
        sleep: clock.sleep,
        timeoutMs: 60000,
      }))

      if (result.url !== undefined) {
        expectSaved(result, probe, payload)
      } else {
        expectCleanFailure(result.error, probe)
        expect(['malformed', 'failed', 'timeout']).toContain(result.error.code)
        expect(probe.byteCount).toBe(0)
      }
      expect(net.calls.length).toBeLessThanOrEqual(8)
    }
  })

  test('redirects on the authenticated endpoints are refused at every stage', async () => {
    const opaque = () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: new Headers(), body: null }) as unknown as Response
    const located = (status: number) => () => new Response(null, { status, headers: { location: 'https://evil.example/steal' } })
    for (const answer of [opaque, located(301), located(302), located(303), located(307), located(308)]) {
      for (const phase of ['queue', 'retrieve'] as RouteName[]) {
        const clock = fakeClock()
        const probe = sinkProbe()
        const net = router({ [phase]: answer })
        const result = await run(net, probe, clock)
        expectCleanFailure(result.error, probe, 'failed')
        expect(net.calls.every((call) => call.url.startsWith(VENICE_API_BASE))).toBe(true)
        expect(net.counts.complete).toBe(0)
      }
    }
  })

})
