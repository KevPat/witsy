import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ImageCreator from '@services/image'
import { store } from '@services/store'

const { generateContent } = vi.hoisted(() => ({
  generateContent: vi.fn(),
}))

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = { generateContent }
  }
  return {
    GoogleGenAI,
    PersonGeneration: { ALLOW_ADULT: 'ALLOW_ADULT', ALLOW_ALL: 'ALLOW_ALL' },
    SafetyFilterLevel: { BLOCK_NONE: 'BLOCK_NONE' },
    SubjectReferenceImage: class SubjectReferenceImage {},
  }
})

vi.mock('@fal-ai/client', () => ({
  fal: { config: vi.fn(), subscribe: vi.fn() },
}))

vi.mock('@huggingface/inference', () => ({
  HfInference: class HfInference {},
}))

vi.mock('openai', () => ({
  default: class OpenAI {},
  toFile: vi.fn(),
}))

vi.mock('replicate', () => ({
  default: class Replicate {},
}))

describe('ImageCreator.google_text', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    generateContent.mockReset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.config = {
      engines: { google: { apiKey: 'test-key' } },
      workspaceId: 'ws',
    } as any
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('returns an error when Google returns no candidates', async () => {
    generateContent.mockResolvedValue({ candidates: [] })
    const creator = new ImageCreator()

    const result = await creator.google_text('gemini-image', { prompt: 'a cat' })

    expect(result).toEqual({ error: expect.any(String) })
    expect(result.error.length).toBeGreaterThan(0)
  })

  it('returns the block reason when the prompt is blocked', async () => {
    generateContent.mockResolvedValue({ promptFeedback: { blockReason: 'SAFETY' } })
    const creator = new ImageCreator()

    const result = await creator.google_text('gemini-image', { prompt: 'a cat' })

    expect(result.error).toContain('SAFETY')
  })

  it('returns the candidate finish reason when content is missing', async () => {
    generateContent.mockResolvedValue({
      candidates: [{ finishReason: 'SAFETY' }],
    })
    const creator = new ImageCreator()

    const result = await creator.google_text('gemini-image', { prompt: 'a cat' })

    expect(result.error).toContain('SAFETY')
  })
})
