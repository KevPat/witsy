import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import HuggingFace from '@services/huggingface'
import { listModels } from '@huggingface/hub'

vi.mock('@huggingface/hub', () => ({
  listModels: vi.fn(),
}))

const makeConfig = () => ({
  engines: {
    huggingface: {
      apiKey: 'test-key',
      models: {} as Record<string, { id: string, name: string }[]>,
    },
  },
})

describe('HuggingFace.loadCollection', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(listModels).mockReset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('returns null and logs the task when listModels throws', async () => {
    vi.mocked(listModels).mockRejectedValue(new Error('hub down'))
    const huggingface = new HuggingFace(makeConfig() as any)

    await expect(huggingface.loadCollection('text-to-image', 'image')).resolves.toBeNull()

    expect(errorSpy).toHaveBeenCalled()
    const logged = errorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n')
    expect(logged).toContain('text-to-image')
    expect(logged).not.toContain('ReferenceError')
  })
})
