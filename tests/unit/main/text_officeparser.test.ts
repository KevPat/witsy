// officeparser 8 through Witsy's getTextContent. Expected text is what
// officeparser 5.2.2 returned for the same files (fixtures generated with
// python-docx/python-pptx and checked in LibreOffice).

import { test, expect, beforeAll } from 'vitest'
import fs from 'fs'
import { getTextContent } from '@main/text'

// warm officeparser 8 once (its first import is slow under a full parallel run)
beforeAll(async () => {
  await import('officeparser')
}, 30000)

const fixture = (name: string) => fs.readFileSync(`./tests/fixtures/office/${name}`, 'base64')

test('docx table keeps one cell per line', async () => {
  const text = await getTextContent(fixture('table.docx'), 'docx')
  expect(text).toBe('Before table.\nName\nQty\nPrice\nApple\n3\n1.20\nBanana\n12\n0.25\nAfter table.')
})

test('pptx titles, bullets, notes and tables', async () => {
  const text = await getTextContent(fixture('deck.pptx'), 'pptx')
  expect(text).toBe('Deck Title Slide\nSubtitle here\nSpeaker note for slide one\nAgenda\nPoint A\nPoint B\nSub point B1\nSecond slide notes 🚀\nTable Slide\nK\nV\nalpha\n42\nImage Slide')
})

test('empty pptx gives empty text', async () => {
  // officeparser 5 threw here (with the raw zip bytes in the message)
  await expect(getTextContent(fixture('empty.pptx'), 'pptx')).resolves.toBe('')
})

test('crafted ASF blob is rejected instead of hanging', async () => {
  // 70 bytes: ASF header GUID + a sub-header of size 0. file-type <21.3.1
  // (GHSA-5v7r-6r5c-r473) looped forever on this under officeparser 5
  const started = Date.now()
  for (const format of ['docx', 'pptx', 'xlsx']) {
    await expect(getTextContent(fixture('asf_zero_size_subheader.bin'), format)).rejects.toThrow()
  }
  expect(Date.now() - started).toBeLessThan(10000)
})
