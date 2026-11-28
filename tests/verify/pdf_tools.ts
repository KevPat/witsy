// reading a PDF without depending on the tools of the computer: pdfjs-dist (a dependency of the app)
// for the text, pdftoppm (poppler) for a picture of the first page when it is installed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { commandExists } from './harness'

export const pdfText = async (file: string): Promise<{ pages: number, text: string, hasStructTree: boolean, hasOutline: boolean }> => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(file))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((item: any) => item.str ?? '').join(' ') + '\n'
  }
  const outline = await doc.getOutline()
  const raw = fs.readFileSync(file).toString('latin1')
  const result = { pages: doc.numPages, text, hasStructTree: raw.includes('/StructTreeRoot'), hasOutline: !!outline?.length }
  await doc.destroy()
  return result
}

// renders page 1 to a png; null when poppler is not installed
export const pdfFirstPagePng = (file: string, outBase: string): string | null => {
  if (!commandExists('pdftoppm')) return null
  const res = spawnSync('pdftoppm', ['-png', '-r', '80', '-f', '1', '-l', '1', '-singlefile', file, outBase])
  if (res.status !== 0) return null
  const png = `${outBase}.png`
  return fs.existsSync(png) ? png : null
}

// the share of pixels of a png that are not (almost) white: a blank page is about 0
export const inkRatio = async (png: string): Promise<number> => {
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let ink = 0
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++
  }
  return ink / (data.length / info.channels)
}

export const ensureDir = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); return dir }
export const baseName = (file: string) => path.basename(file, path.extname(file))
