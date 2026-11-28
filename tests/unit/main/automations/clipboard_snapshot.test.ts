
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clipboard } from 'electron'
import { restoreClipboard, saveClipboard } from '@main/automations/clipboard_snapshot'

// A clipboard double that behaves like the real one where it matters here: every write empties
// the clipboard first, and writeBuffer writes one format.
type Img = { empty: boolean, id: string }
type State = { text: string, html: string, rtf: string, image: Img | null, buffers: Record<string, Buffer> }
const empty = (): State => ({ text: '', html: '', rtf: '', image: null, buffers: {} })
let state: State = empty()

vi.mock('electron', () => ({
  clipboard: {
    readText: vi.fn(() => state.text),
    readHTML: vi.fn(() => state.html),
    readRTF: vi.fn(() => state.rtf),
    readImage: vi.fn(() => state.image ?? { empty: true, id: '' }),
    readBuffer: vi.fn((format: string) => state.buffers[format] ?? Buffer.alloc(0)),
    has: vi.fn((format: string) => format in state.buffers),
    writeText: vi.fn((text: string) => { state = { ...empty(), text } }),
    writeImage: vi.fn((image: Img) => { state = { ...empty(), image } }),
    write: vi.fn((data: Partial<State>) => { state = { ...empty(), ...data } }),
    writeBuffer: vi.fn((format: string, data: Buffer) => { state = { ...empty(), buffers: { [format]: data } } }),
  },
}))

const platform = process.platform
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value, configurable: true })

// what an automation does around a paste
const borrow = () => {
  const snapshot = saveClipboard()
  clipboard.writeText('text of the automation')
  return snapshot
}

const idList = Buffer.from([3, 0, 0, 0, 16, 0, 0, 0, 1, 2, 3, 4])
const pathList = Buffer.from('<plist version="1.0"><array><string>/Users/me/one.txt</string><string>/Users/me/two.txt</string></array></plist>')
const fileUrl = Buffer.from('file:///Users/me/one.txt')
const copiedFiles = Buffer.from('copy\nfile:///home/me/one.txt\nfile:///home/me/two.txt')
const uriList = Buffer.from('file:///home/me/one.txt\r\nfile:///home/me/two.txt\r\n')
const screenshot: Img = { empty: false, id: 'screenshot' }

beforeEach(() => {
  vi.clearAllMocks()
  state = empty()
})

afterEach(() => {
  setPlatform(platform)
  vi.restoreAllMocks()
})

describe('files copied in a file manager', () => {

  test('Windows: the list comes back as Shell IDList Array, alone', () => {
    setPlatform('win32')
    state = { ...empty(), buffers: { 'Shell IDList Array': idList, 'FileNameW': Buffer.from('C:\\one.txt\0', 'ucs2'), 'Preferred DropEffect': Buffer.from([5, 0, 0, 0]) } }
    const snapshot = borrow()
    expect(snapshot.files).toEqual({ format: 'Shell IDList Array', data: idList })
    expect(state).toEqual({ ...empty(), text: 'text of the automation' })
    restoreClipboard(snapshot)
    expect(clipboard.writeBuffer).toHaveBeenCalledTimes(1)
    expect(clipboard.writeBuffer).toHaveBeenCalledWith('Shell IDList Array', idList)
    expect(state).toEqual({ ...empty(), buffers: { 'Shell IDList Array': idList } })
  })

  test('Windows: a single file name is not a list of files', () => {
    setPlatform('win32')
    state = { ...empty(), buffers: { 'FileNameW': Buffer.from('C:\\one.txt\0', 'ucs2') } }
    const snapshot = borrow()
    expect(snapshot.files).toBeNull()
    restoreClipboard(snapshot)
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual(empty())
  })

  test('Windows: an image next to a list of files is what comes back', () => {
    setPlatform('win32')
    state = { ...empty(), image: screenshot, buffers: { 'Shell IDList Array': idList } }
    restoreClipboard(borrow())
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual({ ...empty(), image: screenshot })
  })

  test('macOS: the list of paths comes back, whatever text and icon came with it', () => {
    setPlatform('darwin')
    state = { ...empty(), text: 'one.txt\rtwo.txt', image: { empty: false, id: 'icon' }, buffers: { 'NSFilenamesPboardType': pathList, 'public.file-url': fileUrl } }
    const snapshot = borrow()
    expect(snapshot.files).toEqual({ format: 'NSFilenamesPboardType', data: pathList })
    restoreClipboard(snapshot)
    expect(clipboard.writeBuffer).toHaveBeenCalledWith('NSFilenamesPboardType', pathList)
    expect(state).toEqual({ ...empty(), buffers: { 'NSFilenamesPboardType': pathList } })
  })

  test('macOS: one file that only has a url comes back as that url', () => {
    setPlatform('darwin')
    state = { ...empty(), text: 'one.txt', buffers: { 'public.file-url': fileUrl } }
    restoreClipboard(borrow())
    expect(state).toEqual({ ...empty(), buffers: { 'public.file-url': fileUrl } })
  })

  test('macOS: several files never come back as the first one', () => {
    setPlatform('darwin')
    state = { ...empty(), text: 'one.txt\rtwo.txt', buffers: { 'public.file-url': fileUrl } }
    const snapshot = borrow()
    expect(snapshot.files).toBeNull()
    restoreClipboard(snapshot)
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual({ ...empty(), text: 'one.txt\rtwo.txt' })
  })

  test('Linux: the target of the file managers, with its cut or copy mark, is preferred', () => {
    setPlatform('linux')
    state = { ...empty(), text: '/home/me/one.txt\n/home/me/two.txt', buffers: { 'x-special/gnome-copied-files': copiedFiles, 'text/uri-list': uriList } }
    restoreClipboard(borrow())
    expect(state).toEqual({ ...empty(), buffers: { 'x-special/gnome-copied-files': copiedFiles } })
  })

  test('Linux: a list of file urls comes back when it is all there is', () => {
    setPlatform('linux')
    state = { ...empty(), text: '/home/me/one.txt\n/home/me/two.txt', buffers: { 'text/uri-list': uriList } }
    restoreClipboard(borrow())
    expect(state).toEqual({ ...empty(), buffers: { 'text/uri-list': uriList } })
  })

  test('Linux: links copied in a browser are not files, their text comes back', () => {
    setPlatform('linux')
    state = { ...empty(), text: 'https://example.com/', buffers: { 'text/uri-list': Buffer.from('https://example.com/\r\n') } }
    const snapshot = borrow()
    expect(snapshot.files).toBeNull()
    restoreClipboard(snapshot)
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual({ ...empty(), text: 'https://example.com/' })
  })

  test.each(['win32', 'darwin', 'linux'])('%s: the formats of another platform are not looked at', (os) => {
    setPlatform(os)
    const others = { win32: ['NSFilenamesPboardType', 'x-special/gnome-copied-files'], darwin: ['Shell IDList Array', 'x-special/gnome-copied-files'], linux: ['Shell IDList Array', 'NSFilenamesPboardType'] }[os]
    state = { ...empty(), text: 'a\nb', buffers: Object.fromEntries(others.map((format) => [format, idList])) }
    const snapshot = borrow()
    expect(snapshot.files).toBeNull()
    restoreClipboard(snapshot)
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual({ ...empty(), text: 'a\nb' })
  })

  test('a platform without a known format keeps the portable formats', () => {
    setPlatform('freebsd')
    state = { ...empty(), text: 'text', buffers: { 'text/uri-list': uriList } }
    restoreClipboard(borrow())
    expect(state).toEqual({ ...empty(), text: 'text' })
  })

})

describe('what Electron reads on every platform', () => {

  test.each(['win32', 'darwin', 'linux'])('%s: a text comes back with writeText and no platform format is written', (os) => {
    setPlatform(os)
    state = { ...empty(), text: 'ORIGINAL' }
    const snapshot = borrow()
    expect(snapshot).toEqual({ text: 'ORIGINAL', html: '', rtf: '', image: null, files: null })
    restoreClipboard(snapshot)
    expect(clipboard.writeText).toHaveBeenLastCalledWith('ORIGINAL')
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual({ ...empty(), text: 'ORIGINAL' })
  })

  test('text, HTML, RTF and image come back together', () => {
    setPlatform('win32')
    state = { ...empty(), text: 'plain', html: '<b>plain</b>', rtf: '{\\rtf1 plain}', image: screenshot }
    restoreClipboard(borrow())
    expect(clipboard.write).toHaveBeenCalledWith({ text: 'plain', html: '<b>plain</b>', rtf: '{\\rtf1 plain}', image: screenshot })
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
    expect(state).toEqual({ ...empty(), text: 'plain', html: '<b>plain</b>', rtf: '{\\rtf1 plain}', image: screenshot })
  })

  test('an empty clipboard comes back empty', () => {
    setPlatform('darwin')
    const snapshot = borrow()
    expect(snapshot.files).toBeNull()
    restoreClipboard(snapshot)
    expect(state).toEqual(empty())
  })

})

describe('a platform format that cannot be read or written never breaks the automation', () => {

  test('readBuffer throws: the snapshot is taken without the files and the text comes back', () => {
    setPlatform('win32')
    state = { ...empty(), text: 'ORIGINAL', buffers: { 'Shell IDList Array': idList } }
    vi.mocked(clipboard.readBuffer).mockImplementation(() => { throw new Error('clipboard is busy') })
    const snapshot = borrow()
    expect(snapshot).toEqual({ text: 'ORIGINAL', html: '', rtf: '', image: null, files: null })
    restoreClipboard(snapshot)
    expect(state).toEqual({ ...empty(), text: 'ORIGINAL' })
  })

  test('writeBuffer throws: the portable formats come back instead, and nothing is thrown', () => {
    setPlatform('darwin')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    state = { ...empty(), text: 'one.txt\rtwo.txt', buffers: { 'NSFilenamesPboardType': pathList } }
    const snapshot = borrow()
    vi.mocked(clipboard.writeBuffer).mockImplementationOnce(() => { throw new Error('refused') })
    expect(() => restoreClipboard(snapshot)).not.toThrow()
    expect(state).toEqual({ ...empty(), text: 'one.txt\rtwo.txt' })
  })

  test('the format is not there after writeBuffer: the portable formats come back instead', () => {
    setPlatform('linux')
    state = { ...empty(), text: '/home/me/one.txt', buffers: { 'text/uri-list': uriList } }
    const snapshot = borrow()
    vi.mocked(clipboard.writeBuffer).mockImplementationOnce(() => { state = empty() })
    restoreClipboard(snapshot)
    expect(state).toEqual({ ...empty(), text: '/home/me/one.txt' })
  })

  test('everything throws: restoring still does not', () => {
    setPlatform('win32')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    state = { ...empty(), buffers: { 'Shell IDList Array': idList } }
    const snapshot = borrow()
    vi.mocked(clipboard.writeBuffer).mockImplementationOnce(() => { throw new Error('refused') })
    vi.mocked(clipboard.writeText).mockImplementationOnce(() => { throw new Error('refused') })
    expect(() => restoreClipboard(snapshot)).not.toThrow()
  })

})
