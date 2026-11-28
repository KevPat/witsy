import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WitsyAPI } from '@/cli/api'
import { state } from '@/cli/state'

// WitsyAPI.complete reads the /api/complete event stream chunk by chunk. A network read boundary
// can fall anywhere, so the client has to carry the unfinished line (and the unfinished multi-byte
// character) from one read to the next: it used to split EACH chunk on newlines on its own, which
// delivered a `data:` line cut in two truncated (first half) and dropped its second half.
// fetch is stubbed with a Response over an in-memory ReadableStream: no socket.

const kPayloads = [
  '{"type":"content","text":"Hello"}',
  '{"type":"tool","name":"search","state":"running"}',
  '{"type":"content","text":" wörld \ud83d\ude00"}',
  '{"type":"content","text":"line with data: inside"}',
  '{"type":"usage","usage":{"prompt_tokens":12,"completion_tokens":34}}',
]

const kStream = kPayloads.map((p) => `data: ${p}\n\n`).join('') + 'data: [DONE]\n\n'
const kBytes = new TextEncoder().encode(kStream)

// cuts the stream at the given byte offsets and returns what the client hands to its callback
const receive = async (cuts: number[], bytes: Uint8Array = kBytes): Promise<string[]> => {
  const chunks: Uint8Array[] = []
  let start = 0
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    chunks.push(bytes.slice(start, cut))
    start = cut
  }
  chunks.push(bytes.slice(start))

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  vi.mocked(fetch).mockResolvedValueOnce(new Response(body))

  const received: string[] = []
  await new WitsyAPI().complete([{ role: 'user', content: 'hi' }], (data) => received.push(data))
  return received
}

// byte offset of the first occurrence of a marker in the stream
const offsetOf = (marker: string): number => {
  const index = kStream.indexOf(marker)
  return new TextEncoder().encode(kStream.slice(0, index)).length
}

// offsets where the stream may be cut without splitting a `data:` line: at a line start, or right
// before the newline that ends a line (the whole line is then the last piece of its chunk)
const isLineBoundary = (cut: number): boolean => kBytes[cut - 1] === 0x0A || kBytes[cut] === 0x0A

// small deterministic PRNG so a failing fuzz case can be reproduced from its seed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const kOriginalWorkDir = { ...state.workDir }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  state.workDir = { ...kOriginalWorkDir }
})

describe('CLI event stream: chunks that end on line boundaries', () => {

  test('a stream delivered in one chunk yields every event once, in order', async () => {
    expect(await receive([])).toEqual(kPayloads)
  })

  test('every cut that falls on a line boundary yields every event once, in order', async () => {
    const cuts = [...kBytes.keys()].filter((cut) => cut > 0 && isLineBoundary(cut))
    expect(cuts.length).toBeGreaterThan(10)
    for (const cut of cuts) {
      expect(await receive([cut]), `cut at byte ${cut}`).toEqual(kPayloads)
    }
  })

  test('one chunk per line yields every event once, in order', async () => {
    const cuts = [...kBytes.keys()].filter((cut) => cut > 0 && kBytes[cut - 1] === 0x0A)
    expect(await receive(cuts)).toEqual(kPayloads)
  })

  test('a non-2xx answer is reported, not parsed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(new WitsyAPI().complete([], () => {})).rejects.toThrow('HTTP 500')
  })

  test('the request carries the CLI working directory and access level', async () => {
    // client half of the /api/complete workDir finding: the server trusts whatever arrives here
    state.workDir = { path: '/some/project', access: 'rw' }
    await receive([])
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string).workDir).toEqual({ path: '/some/project', access: 'rw' })
  })

})

describe('CLI event stream: a data line split across two reads', () => {

  test('a cut inside an event payload does not truncate or drop it', async () => {
    // used to fail: the first half reaches the callback as broken JSON, the second half is discarded
    expect(await receive([offsetOf('"text":"Hello"') + 4])).toEqual(kPayloads)
  })

  test('a cut inside the "data: " prefix does not drop the event', async () => {
    // used to fail: neither half starts with "data: ", so the whole event silently disappears
    expect(await receive([offsetOf('data: {"type":"tool"') + 3])).toEqual(kPayloads)
  })

  test('a cut inside a multi-byte character does not lose the event', async () => {
    // used to fail: the decoder reassembles the character, but the line it belongs to is still split
    expect(await receive([offsetOf('\ud83d\ude00') + 2])).toEqual(kPayloads)
  })

  test('a cut inside the [DONE] marker is not handed to the callback as content', async () => {
    // used to fail: "data: [DO" is not the terminator, so "[DO" is delivered as if it were an event
    expect(await receive([offsetOf('[DONE]') + 3])).toEqual(kPayloads)
  })

  test('every possible two-chunk split delivers every event exactly once', async () => {
    // used to fail: only cuts that happen to fall on a line boundary survive
    const broken: number[] = []
    for (let cut = 1; cut < kBytes.length; cut++) {
      const received = await receive([cut])
      if (JSON.stringify(received) !== JSON.stringify(kPayloads)) broken.push(cut)
    }
    expect(broken.length, `${broken.length} of ${kBytes.length - 1} cut positions lose or corrupt an event, first at byte ${broken[0]}`).toBe(0)
  })

  test('seeded fuzz: any chunking of the stream delivers every event exactly once', async () => {
    // used to fail: same defect with 2 to 7 chunks of random sizes, as a real socket would produce
    const rand = mulberry32(0x5EED)
    const broken: string[] = []
    for (let i = 0; i < 200; i++) {
      const cuts = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => 1 + Math.floor(rand() * (kBytes.length - 1)))
      const received = await receive(cuts)
      if (JSON.stringify(received) !== JSON.stringify(kPayloads)) broken.push(`iteration ${i} cuts [${cuts.join(',')}]`)
    }
    expect(broken.length, `seed 0x5EED: ${broken.length} of 200 chunkings lose or corrupt an event, first: ${broken[0]}`).toBe(0)
  })

  test('one byte per read delivers every event exactly once', async () => {
    const cuts = [...kBytes.keys()].filter((cut) => cut > 0)
    expect(await receive(cuts)).toEqual(kPayloads)
  })

})

describe('CLI event stream: line endings and end of stream', () => {

  const encode = (text: string) => new TextEncoder().encode(text)

  test('CRLF line endings yield the same events, wherever the stream is cut', async () => {
    const bytes = encode(kStream.replaceAll('\n', '\r\n'))
    expect(await receive([], bytes)).toEqual(kPayloads)
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await receive([cut], bytes), `cut at byte ${cut}`).toEqual(kPayloads)
    }
  })

  test('a last line without a newline is delivered when the stream ends', async () => {
    const bytes = encode(`data: ${kPayloads[0]}\n\ndata: ${kPayloads[2]}`)
    expect(await receive([], bytes)).toEqual([kPayloads[0], kPayloads[2]])
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await receive([cut], bytes), `cut at byte ${cut}`).toEqual([kPayloads[0], kPayloads[2]])
    }
  })

  test('a [DONE] marker without a newline still ends the stream silently', async () => {
    const bytes = encode(`data: ${kPayloads[0]}\n\ndata: [DONE]`)
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await receive([cut], bytes), `cut at byte ${cut}`).toEqual([kPayloads[0]])
    }
  })

  test('nothing after the [DONE] marker is delivered', async () => {
    const bytes = encode(`data: ${kPayloads[0]}\n\ndata: [DONE]\n\ndata: ${kPayloads[1]}\n\n`)
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await receive([cut], bytes), `cut at byte ${cut}`).toEqual([kPayloads[0]])
    }
  })

  test('lines that are not data lines are ignored, and a throwing callback does not stop the stream', async () => {
    const bytes = encode(`: comment\nevent: message\ndata: ${kPayloads[0]}\n\nid: 1\ndata: ${kPayloads[1]}\n\ndata: [DONE]\n\n`)
    const received: string[] = []
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 20))
        controller.enqueue(bytes.slice(20))
        controller.close()
      },
    })))
    await new WitsyAPI().complete([], (data) => {
      received.push(data)
      throw new Error('callback failure')
    })
    expect(received).toEqual([kPayloads[0], kPayloads[1]])
  })

  test('an empty stream delivers nothing', async () => {
    expect(await receive([], new Uint8Array())).toEqual([])
  })

})
