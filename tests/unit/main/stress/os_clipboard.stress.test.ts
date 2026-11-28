
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clipboard } from 'electron'
import Automation, { AutomationAction } from '@main/automations/automation'
import Automator from '@main/automations/automator'

// A clipboard double that behaves like the real one: writing text replaces the whole clipboard,
// so any image that was there is gone unless it was explicitly saved and restored. Same for the
// platform formats (the files copied in a file manager): any write removes them.
type Img = { empty: boolean, id: string }
const emptyImg: Img = { empty: true, id: '' }
let state: { text: string, image: Img, buffers?: Record<string, Buffer> } = { text: '', image: emptyImg }

vi.mock('electron', () => ({
  clipboard: {
    readText: vi.fn(() => state.text),
    writeText: vi.fn((t: string) => { state = { text: t, image: emptyImg } }),
    readImage: vi.fn(() => state.image),
    writeImage: vi.fn((img: Img) => { state = { text: '', image: img } }),
    readBuffer: vi.fn((format: string) => state.buffers?.[format] ?? Buffer.alloc(0)),
    writeBuffer: vi.fn((format: string, data: Buffer) => { state = { text: '', image: emptyImg, buffers: { [format]: data } } }),
    has: vi.fn((format: string) => format in (state.buffers ?? {})),
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

const platform = process.platform

// the format that lists the files copied in the file manager of each platform
const fileLists: [string, string, Buffer][] = [
  ['win32', 'Shell IDList Array', Buffer.from([2, 0, 0, 0, 12, 0, 0, 0, 9, 9, 9, 9])],
  ['darwin', 'NSFilenamesPboardType', Buffer.from('<plist version="1.0"><array><string>/Users/me/one.txt</string></array></plist>')],
  ['linux', 'x-special/gnome-copied-files', Buffer.from('copy\nfile:///home/me/one.txt')],
]

beforeEach(() => {
  vi.clearAllMocks()
  state = { text: '', image: emptyImg }
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.restoreAllMocks()
})

describe('Automation.automate clipboard save/restore', () => {

  test('on success the original clipboard text is restored', async () => {
    state = { text: 'ORIGINAL', image: emptyImg }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(true)
    expect(state.text).toBe('ORIGINAL')
  })

  test('a non-text clipboard (image) survives an automation', async () => {
    // fails today: save/restore uses readText/writeText only, so the image is overwritten by the
    // LLM text and never put back.
    state = { text: '', image: { empty: false, id: 'screenshot' } }
    await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(clipboard.readImage().empty).toBe(false)
  })

  test('the original clipboard is restored even when pasting throws', async () => {
    // fails today: the restore writeText runs after the paste inside the same try, so a paste
    // failure skips it and leaves the LLM output on the clipboard.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(Automator.prototype.pasteClipboard).mockRejectedValueOnce(new Error('paste failed'))
    state = { text: 'ORIGINAL', image: emptyImg }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(false)
    expect(state.text).toBe('ORIGINAL')
  })

  test.each(fileLists)('%s: files copied in the file manager survive an automation', async (os, format, data) => {
    // before: only text, HTML, RTF and images were saved, so the files were replaced by the LLM text and never put back
    Object.defineProperty(process, 'platform', { value: os, configurable: true })
    state = { text: '', image: emptyImg, buffers: { [format]: data } }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(true)
    // the text was really on the clipboard for the paste, and the files are back after it
    expect(clipboard.writeText).toHaveBeenCalledWith('AI output')
    expect(clipboard.readBuffer(format).equals(data)).toBe(true)
    expect(clipboard.readText()).toBe('')
  })

  test.each(fileLists)('%s: the files are restored even when pasting throws', async (os, format, data) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.defineProperty(process, 'platform', { value: os, configurable: true })
    vi.mocked(Automator.prototype.pasteClipboard).mockRejectedValueOnce(new Error('paste failed'))
    state = { text: '', image: emptyImg, buffers: { [format]: data } }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(false)
    expect(clipboard.readBuffer(format).equals(data)).toBe(true)
  })

  test('a list of files that cannot be written back does not stop the automation from succeeding', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.mocked(clipboard.writeBuffer).mockImplementationOnce(() => { throw new Error('refused') })
    state = { text: '', image: emptyImg, buffers: { 'Shell IDList Array': Buffer.from([1, 2, 3]) } }
    const ok = await Automation.automate('AI output', null, AutomationAction.REPLACE)
    expect(ok).toBe(true)
    expect(Automator.prototype.pasteClipboard).toHaveBeenCalledTimes(1)
    // the clipboard does not keep the text of the automation
    expect(clipboard.readText()).toBe('')
  })

})
