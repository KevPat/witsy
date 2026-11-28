import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import STTWhisper from '@renderer/voice/stt-whisper'

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: false },
  pipeline: vi.fn(),
}))

type ReaderMode = 'load' | 'error' | 'bad-result'

const installFileReader = (mode: ReaderMode) => {
  class FakeFileReader {
    result: ArrayBuffer | string | null = mode === 'bad-result' ? 'not-a-buffer' : new ArrayBuffer(8)
    error: Error | null = mode === 'error' ? new Error('read failed') : null
    onloadend: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsArrayBuffer() {
      if (mode === 'error') {
        this.result = null
        this.onerror?.()
        this.onloadend?.()
        return
      }
      this.onloadend?.()
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader)
}

const makeEngine = () => {
  const engine = new STTWhisper({
    stt: { locale: 'en-US', whisper: { gpu: false } },
  } as any)
  engine.transcriber = vi.fn(async () => ({ text: 'hello' }))
  return engine
}

describe('STTWhisper.transcribe', () => {
  let decodeAudioData: ReturnType<typeof vi.fn>

  beforeEach(() => {
    decodeAudioData = vi.fn(async () => ({
      getChannelData: () => new Float32Array([0]),
    }))
    vi.stubGlobal('AudioContext', class {
      decodeAudioData = decodeAudioData
      close = vi.fn()
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves with the transcriber output', async () => {
    installFileReader('load')
    const engine = makeEngine()
    await expect(engine.transcribe(new Blob(['audio']))).resolves.toEqual({ text: 'hello' })
    expect(engine.transcriber).toHaveBeenCalled()
  })

  it('rejects when decodeAudioData throws', async () => {
    installFileReader('load')
    decodeAudioData.mockRejectedValue(new Error('decode failed'))
    const engine = makeEngine()
    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('decode failed')
  })

  it('rejects when the model throws', async () => {
    installFileReader('load')
    const engine = makeEngine()
    engine.transcriber = vi.fn(async () => {
      throw new Error('model failed')
    })
    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('model failed')
  })

  it('rejects when FileReader errors', async () => {
    installFileReader('error')
    const engine = makeEngine()
    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('read failed')
    expect(decodeAudioData).not.toHaveBeenCalled()
  })

  it('rejects when FileReader result is not an ArrayBuffer', async () => {
    installFileReader('bad-result')
    const engine = makeEngine()
    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('Failed to read audio file')
    expect(decodeAudioData).not.toHaveBeenCalled()
  })
})
