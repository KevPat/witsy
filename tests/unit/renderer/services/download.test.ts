
import { vi, beforeAll, beforeEach, expect, test } from 'vitest'
import { useWindowMock } from '@tests/mocks/window'
import { downloadWithPrompt } from '@services/download'
import Dialog from '@renderer/utils/dialog'

vi.mock('@renderer/utils/dialog', () => ({
  default: {
    alert: vi.fn(),
  }
}))

beforeAll(() => {
  useWindowMock()
})

beforeEach(() => {
  vi.clearAllMocks()
})

test('asks the main process to download to a place the user picks', () => {
  vi.mocked(window.api.file.download).mockReturnValue('file://downloads/image.png')
  expect(downloadWithPrompt('https://example.com/image.png', 'image.png')).toBe('file://downloads/image.png')
  expect(window.api.file.download).toHaveBeenLastCalledWith({
    url: 'https://example.com/image.png',
    properties: { prompt: true, directory: 'downloads', filename: 'image.png' }
  })
  expect(Dialog.alert).not.toHaveBeenCalled()
})

test('tells the user when the download failed', () => {
  vi.mocked(window.api.file.download).mockReturnValue(null)
  expect(downloadWithPrompt('https://example.com/gone.png', 'image.png')).toBeNull()
  expect(Dialog.alert).toHaveBeenCalledWith('common.downloadError')
})

test('says nothing when the user cancelled the save dialog', () => {
  vi.mocked(window.api.file.download).mockReturnValue('')
  expect(downloadWithPrompt('https://example.com/image.png', 'image.png')).toBe('')
  expect(Dialog.alert).not.toHaveBeenCalled()
})
