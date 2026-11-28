import { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type PrintPdfOptions = {
  html: string
  landscape?: boolean
}

export const printPdfFromHtml = async (options: PrintPdfOptions): Promise<Buffer> => {
  const tmpFilePath = path.join(os.tmpdir(), `witsy-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
  const printWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    // the document is a static snapshot built by the renderer (images are inlined, canvases
    // are converted): it comes from chat content, so nothing in it may run or read other origins
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: false,
      defaultEncoding: 'UTF-8',
    }
  })

  try {
    await fs.writeFile(tmpFilePath, options.html, 'utf8')
    // resolves once the page and its resources (images, style sheets, fonts in use) are loaded
    await printWindow.loadFile(tmpFilePath)

    return await printWindow.webContents.printToPDF({
      landscape: options.landscape ?? false,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    })
  } finally {
    try {
      await fs.unlink(tmpFilePath)
    } catch {
      // no-op
    }
    if (!printWindow.isDestroyed()) {
      printWindow.destroy()
    }
  }
}
