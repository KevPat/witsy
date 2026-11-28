
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clipboard } from 'electron'
import Automation, { AutomationAction } from '@main/automations/automation'
import Automator from '@main/automations/automator'
import { bug } from './bug'

// A clipboard double that behaves like the real one: writing text replaces the whole clipboard,
// so any image that was there is gone unless it was explicitly saved and restored.
type Img = { empty: boolean, id: string }
const emptyImg: Img = { empty: true, id: '' }
let state: { text: string, image: Img } = { text: '', image: emptyImg }

vi.mock('electron', () => ({
  clipboard: {
    readText: vi.fn(() => state.text),
    writeText: vi.fn((t: string) => { state = { text: t, image: emptyImg } }),
    readImage: vi.fn(() => state.image),
    writeImage: vi.fn((img: Img) => { state = { text: '', image: img } }),
    availableFormats: vi.fn(() => state.image.empty ? (state.text ? ['text/plain'] : []) : ['image/png']),
  },
}))

vi.mock('@excalidraw/markdown-to-text', () => ({ removeMarkdown: (t: string) => t }))
vi.mock('@main/window', () => ({ closePromptAnywhere: vi.fn(async () => undefined) }))
vi.mock('@main/utils', () => ({ wait: vi.fn(async () => undefined) }))

vi.mock('@main/automations/automator', () => {
  const Mock = vi.fn()
  Mock.prototype.moveCaretBelow = vi.fn(async () => undefined)
  Mock.prototype.deleteSelectedText = vi.fn(async () => undefined)
  Mock.prototype.pasteClipboard = vi.fn(async () => undefined)
  Mock.prototype.pasteText = vi.fn(async () => undefined)
  return { default: Mock }
})

beforeEach(() => {
  vi.clearAllMocks()
  state = { text: '', image: emptyImg }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Automation.automate clipboard save/restore', () => {

  test('on success the original clipboard text is restored', async () => {
    state = { text: 'ORIGINAL', image: emptyImg }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(true)
    expect(state.text).toBe('ORIGINAL')
  })

  bug('a non-text clipboard (image) survives an automation', async () => {
    // fails today: save/restore uses readText/writeText only, so the image is overwritten by the
    // LLM text and never put back.
    state = { text: '', image: { empty: false, id: 'screenshot' } }
    await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(clipboard.readImage().empty).toBe(false)
  })

  bug('the original clipboard is restored even when pasting throws', async () => {
    // fails today: the restore writeText runs after the paste inside the same try, so a paste
    // failure skips it and leaves the LLM output on the clipboard.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(Automator.prototype.pasteClipboard).mockRejectedValueOnce(new Error('paste failed'))
    state = { text: 'ORIGINAL', image: emptyImg }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(false)
    expect(state.text).toBe('ORIGINAL')
  })

})
