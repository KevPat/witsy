import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import STTParakeet from '@renderer/voice/stt-parakeet'

vi.mock('parakeet.js', () => ({
  getParakeetModel: vi.fn(),
  ParakeetModel: { fromUrls: vi.fn() },
}))

type ReaderMode = 'load' | 'error' | 'bad-result'

const installFileReader = (mode: ReaderMode) => {
  class FakeFileReader {
    result: ArrayBuffer | string | null = mode === 'bad-result' ? null : new ArrayBuffer(8)
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

describe('STTParakeet.transcribe', () => {
  let decodeAudioData: ReturnType<typeof vi.fn>
  let close: ReturnType<typeof vi.fn>

  beforeEach(() => {
    decodeAudioData = vi.fn(async () => ({
      getChannelData: () => new Float32Array([0]),
    }))
    close = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', class {
      decodeAudioData = decodeAudioData
      close = close
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const makeEngine = () => {
    const engine = new STTParakeet({
      stt: { locale: 'en-US', model: 'istupakov/parakeet-tdt-0.6b-v2-onnx' },
    } as any)
    engine.model = {
      transcribe: vi.fn(async () => ({ utterance_text: 'hello' })),
    } as any
    return engine
  }

  it('resolves with the transcript', async () => {
    installFileReader('load')
    const engine = makeEngine()
    await expect(engine.transcribe(new Blob(['audio']))).resolves.toEqual({ text: 'hello' })
    expect(close).toHaveBeenCalled()
  })

  it('rejects when decodeAudioData throws and still closes the audio context', async () => {
    installFileReader('load')
    decodeAudioData.mockRejectedValue(new Error('decode failed'))
    const engine = makeEngine()
    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('decode failed')
    expect(close).toHaveBeenCalled()
  })

  it('rejects when the model throws and still closes the audio context', async () => {
    installFileReader('load')
    const engine = makeEngine()
    engine.model = {
      transcribe: vi.fn(async () => {
        throw new Error('model failed')
      }),
    } as any
    await expect(engine.transcribe(new Blob(['audio']))).rejects.toThrow('model failed')
    expect(close).toHaveBeenCalled()
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
