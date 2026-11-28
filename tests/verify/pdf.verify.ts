//
// pdf (L-05): a chat exported to PDF from its menu, the way a person does it, is a valid PDF that holds
// the text of the chat; the print window runs no script of the document it prints.
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { artifactsDir, chat, historyWith, LaunchedApp, launchApp, makeHome, message, record, stubDialogs, waitFor } from './harness'
import { inkRatio, pdfFirstPagePng, pdfText } from './pdf_tools'

const suite = 'pdf'
let launched: LaunchedApp
const dir = artifactsDir(suite)
const chatPdf = path.join(dir, 'chat-export.pdf')

const markdown = [
  '# Verify PDF heading',
  '',
  'This paragraph holds the marker VERIFY-PDF-MARKER and some **bold** text.',
  '',
  '- first item of the list',
  '- second item of the list',
  '',
  '| Fruit | Count |',
  '|-------|-------|',
  '| apple | 3 |',
  '| pear | 5 |',
  '',
  '```python',
  'print("VERIFY-PDF-CODE")',
  '```',
  '',
  'Raw markup in a message is text: <script>document.title = "SCRIPT-RAN-IN-PDF"</script>',
].join('\n')

beforeAll(async () => {
  fs.rmSync(chatPdf, { force: true })
  const home = makeHome(suite, { history: historyWith([chat('PDF verify', [message('user', 'Write the verification document'), message('assistant', markdown)])]) })
  launched = await launchApp(home)
  await stubDialogs(launched.app, { savePath: chatPdf })
})

afterAll(async () => {
  await launched?.close()
})

test('a chat is exported to PDF from its menu', async () => {
  const { window } = launched
  await window.click('.chats .chat, .chat-list .chat')
  await window.waitForSelector('.messages .message', { timeout: 30000 })
  await window.click('.chat-area header .menu')
  await window.click('text=Export as PDF')
  await waitFor(() => fs.existsSync(chatPdf) && fs.statSync(chatPdf).size > 1000, 60000)
  const head = fs.readFileSync(chatPdf).subarray(0, 5).toString('latin1')
  record(suite, { chatPdf, chatPdfBytes: fs.statSync(chatPdf).size })
  expect(head).toBe('%PDF-')
})

test('the PDF holds the text of the chat, its list, table and code', async () => {
  const info = await pdfText(chatPdf)
  record(suite, { chatPdfPages: info.pages, chatPdfText: info.text.slice(0, 2000), tagged: info.hasStructTree, outline: info.hasOutline })
  expect(info.pages).toBeGreaterThanOrEqual(1)
  const flat = info.text.replace(/\s+/g, ' ')
  for (const expected of ['Verify PDF heading', 'VERIFY-PDF-MARKER', 'first item of the list', 'apple', 'pear', 'VERIFY-PDF-CODE']) {
    expect(flat).toContain(expected)
  }
  // a tagged PDF, as requested by the print options
  expect(info.hasStructTree).toBe(true)
})

test('the first page is not blank', async () => {
  const png = pdfFirstPagePng(chatPdf, path.join(dir, 'chat-export-page1'))
  if (!png) {
    record(suite, { page1Png: null, note: 'pdftoppm not installed: page picture skipped' })
    return
  }
  const ratio = await inkRatio(png)
  record(suite, { page1Png: png, page1InkRatio: ratio })
  expect(ratio).toBeGreaterThan(0.005)
})

test('the print window runs no script of the document (L-05)', async () => {
  const html = '<!DOCTYPE html><html><head><title>t</title></head><body><p id="p">STATIC-TEXT-VERIFY</p>' +
    '<script>document.getElementById("p").textContent = "SCRIPT-RAN-IN-PRINT"; document.body.insertAdjacentHTML("beforeend", "<p>SCRIPT-ADDED</p>")</script></body></html>'
  const base64 = await launched.window.evaluate((html) => (window as any).api.app.printToPdf(html, false), html)
  const file = path.join(dir, 'print-no-script.pdf')
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  const info = await pdfText(file)
  record(suite, { printNoScriptText: info.text.trim() })
  expect(info.text).toContain('STATIC-TEXT-VERIFY')
  expect(info.text).not.toContain('SCRIPT-RAN-IN-PRINT')
  expect(info.text).not.toContain('SCRIPT-ADDED')
})

test('the print window leaves no temporary file behind', async () => {
  const tmp = await launched.app.evaluate(({ app }) => app.getPath('temp'))
  const left = fs.readdirSync(tmp).filter((f) => /^witsy-pdf-.*\.html$/.test(f))
  expect(left).toEqual([])
})
