
import { beforeEach, expect, test, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import { printPdfFromHtml } from '@main/pdf'

const printWindow = {
  loadFile: vi.fn(async () => undefined),
  isDestroyed: vi.fn(() => false),
  destroy: vi.fn(),
  webContents: {
    printToPDF: vi.fn(async () => Buffer.from('%PDF')),
    executeJavaScript: vi.fn(),
  },
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function() { return printWindow }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

test('the print window cannot run scripts and keeps web security on', async () => {
  await printPdfFromHtml({ html: '<html><body><script>alert(1)</script></body></html>' })
  const options = vi.mocked(BrowserWindow).mock.calls[0][0]
  expect(options.show).toBe(false)
  expect(options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    javascript: false,
  })
  expect(printWindow.webContents.executeJavaScript).not.toHaveBeenCalled()
})

test('the document is printed and the window and temporary file are removed', async () => {
  const data = await printPdfFromHtml({ html: '<html><body>Hello</body></html>', landscape: true })
  expect(data.toString()).toBe('%PDF')
  const file = vi.mocked(printWindow.loadFile).mock.calls[0][0] as string
  expect(printWindow.webContents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({ landscape: true }))
  expect(printWindow.destroy).toHaveBeenCalled()
  await expect(fs.access(file)).rejects.toThrow()
})

test('the window and temporary file are removed when printing fails', async () => {
  printWindow.webContents.printToPDF.mockRejectedValueOnce(new Error('print failed'))
  await expect(printPdfFromHtml({ html: '<html></html>' })).rejects.toThrow('print failed')
  const file = vi.mocked(printWindow.loadFile).mock.calls[0][0] as string
  expect(printWindow.destroy).toHaveBeenCalled()
  await expect(fs.access(file)).rejects.toThrow()
})
