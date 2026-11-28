
import { describe, expect, test } from 'vitest'
import Splitter from '@main/rag/splitter'
import { Configuration } from '@/types/config'
import { bug } from './bug'

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const splitter = (chunkSize: number, chunkOverlap: number) => new Splitter({ rag: { chunkSize, chunkOverlap } } as Configuration)

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'x', 'yz', 'été', '日本語', 'supercalifragilistic']

const randomText = (rand: () => number, words: number, newline = '\n'): string => {
  let text = ''
  for (let i = 0; i < words; i++) {
    if (i > 0) {
      const r = rand()
      text += r < 0.08 ? newline + newline : r < 0.25 ? newline : ' '
    }
    text += WORDS[Math.floor(rand() * WORDS.length)]
  }
  return text
}

const withoutWhitespace = (text: string) => text.replace(/\s+/g, '')

const hasLoneSurrogate = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

describe('Splitter invariants', () => {

  test('fuzz: no chunk is longer than the chunk size', async () => {
    const rand = mulberry32(20261127)
    for (let i = 0; i < 60; i++) {
      const chunkSize = 20 + Math.floor(rand() * 200)
      const chunkOverlap = Math.floor(rand() * chunkSize / 2)
      const text = randomText(rand, 20 + Math.floor(rand() * 300))
      const chunks = await splitter(chunkSize, chunkOverlap).split(text)
      for (const chunk of chunks) {
        expect(chunk.length, `chunkSize=${chunkSize} overlap=${chunkOverlap} iteration=${i}`).toBeLessThanOrEqual(chunkSize)
      }
    }
  })

  test('fuzz: without overlap every non-whitespace character is kept exactly once and in order', async () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 60; i++) {
      const chunkSize = 20 + Math.floor(rand() * 200)
      const text = randomText(rand, 20 + Math.floor(rand() * 300))
      const chunks = await splitter(chunkSize, 0).split(text)
      expect(withoutWhitespace(chunks.join('')), `chunkSize=${chunkSize} iteration=${i}`).toBe(withoutWhitespace(text))
    }
  })

  test('fuzz: with overlap no word is lost', async () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 40; i++) {
      const chunkSize = 40 + Math.floor(rand() * 200)
      const chunkOverlap = Math.floor(rand() * chunkSize / 2)
      const text = randomText(rand, 20 + Math.floor(rand() * 200))
      const chunks = await splitter(chunkSize, chunkOverlap).split(text)
      const found = new Set(chunks.flatMap(chunk => chunk.split(/\s+/)))
      for (const word of text.split(/\s+/)) {
        expect(found.has(word), `"${word}" chunkSize=${chunkSize} overlap=${chunkOverlap} iteration=${i}`).toBe(true)
      }
    }
  })

  test('fuzz: degenerate configurations terminate', async () => {
    const rand = mulberry32(99)
    const text = randomText(rand, 150)
    for (const [chunkSize, chunkOverlap] of [[1, 0], [2, 1], [10, 10], [10, 50], [50, 49], [1000000, 0], [30, 1000000]]) {
      const chunks = await splitter(chunkSize, chunkOverlap).split(text)
      expect(withoutWhitespace(chunks.join('')).length).toBeGreaterThanOrEqual(withoutWhitespace(text).length)
    }
  })

  test('an aborted signal stops the split', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(splitter(50, 10).split(randomText(mulberry32(1), 500), controller.signal)).rejects.toThrow()
  })

  test('a signal aborted while splitting stops the split', async () => {
    const controller = new AbortController()
    const promise = splitter(50, 10).split(randomText(mulberry32(2), 5000), controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow()
  })

})

describe('Splitter content fidelity', () => {

  bug('words separated by one space are not returned with two spaces', async () => {
    // splits keep their leading separator and are then joined with the separator again
    const chunks = await splitter(30, 5).split('one two three four five six seven eight nine ten eleven twelve')
    expect(chunks.filter(chunk => chunk.includes('  '))).toEqual([])
  })

  bug('paragraph breaks are not doubled', async () => {
    // "\n\n" + join("\n\n") turns one blank line into three
    const chunks = await splitter(40, 0).split('para one.\n\npara two.\n\npara three.\n\npara four.')
    expect(chunks.filter(chunk => chunk.includes('\n\n\n'))).toEqual([])
  })

  bug('fuzz: every chunk is a verbatim excerpt of the source text', async () => {
    // the doubled separators make chunks contain text that is not in the document
    const rand = mulberry32(20261127)
    const invented: string[] = []
    for (let i = 0; i < 40; i++) {
      const chunkSize = 30 + Math.floor(rand() * 200)
      const chunkOverlap = Math.floor(rand() * chunkSize / 3)
      const text = randomText(rand, 20 + Math.floor(rand() * 200))
      const chunks = await splitter(chunkSize, chunkOverlap).split(text)
      invented.push(...chunks.filter(chunk => !text.includes(chunk.trim())))
    }
    expect(invented.slice(0, 3)).toEqual([])
  })

  bug('fuzz: without overlap the chunks add up to the source text', async () => {
    // every merged chunk gains one extra separator per split
    const rand = mulberry32(42)
    for (let i = 0; i < 40; i++) {
      const chunkSize = 30 + Math.floor(rand() * 200)
      const text = randomText(rand, 20 + Math.floor(rand() * 200))
      const chunks = await splitter(chunkSize, 0).split(text)
      expect(chunks.join('').length, `chunkSize=${chunkSize} iteration=${i}`).toBe(text.length)
    }
  })

})

describe('Splitter line endings', () => {

  // each two line paragraph fits in a chunk, two paragraphs never do
  const paragraphs = [
    ['Line one of the first.', 'Line two of the first.'],
    ['Line one of the second.', 'Line two of the second.'],
    ['Line one of the third.', 'Line two of the third.'],
  ]
  const document = (newline: string) => paragraphs.map(lines => lines.join(newline)).join(newline + newline)

  test('LF paragraphs are split on the blank lines', async () => {
    const chunks = await splitter(60, 0).split(document('\n'))
    expect(chunks.map(chunk => chunk.trim())).toEqual(paragraphs.map(lines => lines.join('\n')))
  })

  bug('CRLF paragraphs are split on the blank lines', async () => {
    // "\r\n\r\n" does not contain "\n\n", so the text is split on single lines and paragraphs get mixed
    const chunks = await splitter(60, 0).split(document('\r\n'))
    expect(chunks.map(chunk => chunk.trim())).toEqual(paragraphs.map(lines => lines.join('\r\n')))
  })

  bug('a CRLF pair is never cut in half', async () => {
    // the text is split in front of "\n", which leaves the "\r" at the end of the previous split
    const chunks = await splitter(60, 0).split(document('\r\n'))
    expect(chunks.filter(chunk => chunk.endsWith('\r'))).toEqual([])
  })

  bug('fuzz: CRLF text never yields a chunk that ends with a lone carriage return', async () => {
    // same defect on random documents, whatever the chunk size
    const rand = mulberry32(5)
    const cut: string[] = []
    for (let i = 0; i < 20; i++) {
      const text = randomText(rand, 150, '\r\n')
      const chunks = await splitter(40 + Math.floor(rand() * 200), 0).split(text)
      cut.push(...chunks.filter(chunk => chunk.endsWith('\r')))
    }
    expect(cut.slice(0, 3)).toEqual([])
  })

})

describe('Splitter unicode', () => {

  test('text made of BMP characters only never contains lone surrogates', async () => {
    const chunks = await splitter(7, 2).split('日本語のテキストは空白を含まない'.repeat(20))
    expect(chunks.filter(hasLoneSurrogate)).toEqual([])
  })

  test('emoji separated by spaces are kept whole', async () => {
    const chunks = await splitter(11, 0).split(Array(40).fill('😀👍🏽').join(' '))
    expect(chunks.filter(hasLoneSurrogate)).toEqual([])
  })

  bug('a long run of emoji is not cut inside a surrogate pair', async () => {
    // the last resort separator is "", which splits the string into UTF-16 code units
    const chunks = await splitter(5, 0).split('😀'.repeat(12))
    expect(chunks.filter(hasLoneSurrogate)).toEqual([])
  })

  bug('fuzz: unbroken text with astral characters only yields well formed chunks', async () => {
    // same defect: chunk boundaries are counted in code units, not code points
    const rand = mulberry32(11)
    const alphabet = ['a', 'é', '語', '😀', '𝒳', '🇫🇷', '𠀋']
    const broken: string[] = []
    for (let i = 0; i < 30; i++) {
      let text = ''
      for (let j = 0; j < 200; j++) text += alphabet[Math.floor(rand() * alphabet.length)]
      const chunks = await splitter(5 + Math.floor(rand() * 20), 0).split(text)
      broken.push(...chunks.filter(hasLoneSurrogate))
    }
    expect(broken.slice(0, 3)).toEqual([])
  })

})
