
import { expect, test, describe, beforeEach } from 'vitest'
import Splitter from '@main/rag/splitter'
import { Configuration } from '@/types/config'

const mockConfig: Configuration = {
  rag: {
    chunkSize: 100,
    chunkOverlap: 20,
  }
} as Configuration

describe('Splitter', () => {

  let splitter: Splitter

  beforeEach(() => {
    splitter = new Splitter(mockConfig)
  })

  describe('Basic splitting', () => {

    test('splits text on double newlines', async () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.join('')).toContain('First paragraph')
      expect(chunks.join('')).toContain('Second paragraph')
      expect(chunks.join('')).toContain('Third paragraph')
    })

    test('splits text on single newlines when no double newlines', async () => {
      const text = 'Line one.\nLine two.\nLine three.'
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.join('')).toContain('Line one')
      expect(chunks.join('')).toContain('Line two')
      expect(chunks.join('')).toContain('Line three')
    })

    test('splits text on spaces when no newlines', async () => {
      const text = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15'
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.some(chunk => chunk.includes('word1'))).toBe(true)
    })

    test('splits character by character when text has no separators', async () => {
      const text = 'a'.repeat(150) // 150 characters, no separators
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.every(chunk => chunk.length <= 100)).toBe(true)
    })

  })

  describe('Edge cases', () => {

    test('handles empty string', async () => {
      const chunks = await splitter.split('')
      expect(chunks).toEqual([])
    })

    test('handles text shorter than chunk size', async () => {
      const text = 'Short text.'
      const chunks = await splitter.split(text)

      expect(chunks.length).toBe(1)
      // Note: splitter keeps separators, so result might have spaces preserved
      expect(chunks[0].replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim())
    })

    test('handles text exactly at chunk size', async () => {
      const text = 'a'.repeat(100)
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThanOrEqual(1)
      expect(chunks[0].length).toBeLessThanOrEqual(100)
    })

    test('handles single character', async () => {
      const chunks = await splitter.split('a')
      expect(chunks).toEqual(['a'])
    })

    test('handles text with only separators', async () => {
      const chunks = await splitter.split('\n\n\n\n')
      // Should filter out empty strings
      expect(chunks.every(chunk => chunk.length > 0)).toBe(true)
    })

  })

  describe('Chunk size and overlap', () => {

    test('respects maximum chunk size', async () => {
      const text = 'a'.repeat(500) + '\n\n' + 'b'.repeat(500)
      const chunks = await splitter.split(text)

      // Allow some tolerance for separators
      expect(chunks.every(chunk => chunk.length <= 110)).toBe(true)
    })

    test('maintains overlap between chunks', async () => {
      // Create text that will definitely split
      const text = 'Line1\n'.repeat(50) // Will create multiple chunks
      const chunks = await splitter.split(text)

      if (chunks.length > 1) {
        // Check that consecutive chunks have some overlap
        for (let i = 0; i < chunks.length - 1; i++) {
          const currentChunk = chunks[i]
          const nextChunk = chunks[i + 1]

          // Get the end of current chunk
          const currentEnd = currentChunk.slice(-30) // Look at last 30 chars

          // Check if any part of it appears in next chunk
          const hasOverlap = nextChunk.includes(currentEnd.trim()) ||
                            currentEnd.split('\n').some(line =>
                              line.length > 0 && nextChunk.includes(line)
                            )

          // At least some overlap should exist
          expect(hasOverlap).toBe(true)
        }
      }
    })

    test('uses configured chunk size', async () => {
      const customConfig: Configuration = {
        rag: {
          chunkSize: 50,
          chunkOverlap: 10,
        }
      } as Configuration

      const customSplitter = new Splitter(customConfig)
      const text = 'a'.repeat(200)
      const chunks = await customSplitter.split(text)

      expect(chunks.every(chunk => chunk.length <= 60)).toBe(true)
    })

  })

  describe('Separator hierarchy', () => {

    test('prefers double newlines over single newlines', async () => {
      const text = 'Part1\n\nPart2\nLine2\n\nPart3'
      const chunks = await splitter.split(text)

      // Should split primarily on \n\n
      expect(chunks.some(chunk => chunk.includes('Part1'))).toBe(true)
      expect(chunks.some(chunk => chunk.includes('Part2'))).toBe(true)
    })

    test('falls back to spaces when no newlines available', async () => {
      const text = 'word '.repeat(100)
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThan(1)
    })

    test('keeps separators at start of chunks', async () => {
      const text = 'First\n\nSecond\n\nThird'
      const chunks = await splitter.split(text)

      // Check that separators are preserved
      const rejoined = chunks.join('')
      expect(rejoined).toContain('\n\n')
    })

  })

  describe('Text fidelity', () => {

    const split = (text: string, chunkSize: number, chunkOverlap: number) =>
      new Splitter({ rag: { chunkSize, chunkOverlap } } as Configuration).split(text)

    const hasLoneSurrogate = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

    test('does not add or drop any character when there is no overlap', async () => {
      const text = 'Title\n\nFirst paragraph, line one.\nFirst paragraph, line two.\n\n\nSecond paragraph with   several   spaces.\n\nThird one.\n'
      for (const chunkSize of [1, 2, 5, 10, 25, 40, 100, 1000]) {
        const chunks = await split(text, chunkSize, 0)
        expect(chunks.join(''), `chunkSize=${chunkSize}`).toBe(text)
      }
    })

    test('merges paragraphs without doubling the blank line', async () => {
      const chunks = await split('one.\n\ntwo.\n\nthree.\n\nfour.', 14, 0)
      expect(chunks).toEqual(['one.\n\ntwo.', '\n\nthree.', '\n\nfour.'])
    })

    test('merges words without doubling the space', async () => {
      const chunks = await split('aa bb cc dd ee ff', 9, 3)
      expect(chunks).toEqual(['aa bb cc', ' cc dd ee', ' ee ff'])
    })

    test('consecutive chunks leave no gap and repeat at most the overlap', async () => {
      // every word is unique, so each chunk has exactly one position in the text
      const text = Array.from({ length: 400 }, (_, i) => `w${String(i).padStart(3, '0')}`).join(' ')
      for (const [chunkSize, chunkOverlap] of [[100, 20], [60, 30], [35, 0], [20, 19], [1000, 200]]) {
        const chunks = await split(text, chunkSize, chunkOverlap)
        let covered = 0
        let repeated = 0
        for (const chunk of chunks) {
          const label = `chunkSize=${chunkSize} chunkOverlap=${chunkOverlap} chunk=${JSON.stringify(chunk)}`
          expect(chunk.length, label).toBeLessThanOrEqual(chunkSize)
          const start = text.indexOf(chunk)
          expect(start, label).toBeGreaterThanOrEqual(0)
          expect(text.indexOf(chunk, start + 1), label).toBe(-1)
          expect(start, label).toBeLessThanOrEqual(covered)
          expect(covered - start, label).toBeLessThanOrEqual(chunkOverlap)
          expect(start + chunk.length, label).toBeGreaterThan(covered)
          repeated += covered - start
          covered = start + chunk.length
        }
        expect(covered).toBe(text.length)
        expect(chunks.length).toBeGreaterThan(1)
        if (chunkOverlap > 0) expect(repeated).toBeGreaterThan((chunks.length - 1) * chunkOverlap / 2)
        else expect(repeated).toBe(0)
      }
    })

    test('splits CRLF text on blank lines first, then on lines', async () => {
      const text = 'Para one, line one.\r\nPara one, line two.\r\n\r\nPara two, line one.\r\nPara two, line two.'
      expect(await split(text, 50, 0)).toEqual([
        'Para one, line one.\r\nPara one, line two.',
        '\r\n\r\nPara two, line one.\r\nPara two, line two.',
      ])
      expect(await split(text, 30, 0)).toEqual([
        'Para one, line one.',
        '\r\nPara one, line two.',
        '\r\n\r\nPara two, line one.',
        '\r\nPara two, line two.',
      ])
    })

    test('never separates the two characters of a CRLF, whatever the mix of line endings', async () => {
      const text = 'a\r\n\r\nb\r\n\nc\n\r\nd\r\n\r\n\r\ne\n\n\nf\r\n' + '\r\n'.repeat(30) + 'g\rh\r\r\ni j\r\n k \r\n'
      for (const chunkSize of [1, 2, 3, 4, 5, 7, 16, 50]) {
        const chunks = await split(text, chunkSize, 0)
        expect(chunks.join(''), `chunkSize=${chunkSize}`).toBe(text)
        let boundary = 0
        for (const chunk of chunks.slice(0, -1)) {
          boundary += chunk.length
          expect(text.slice(boundary - 1, boundary + 1), `chunkSize=${chunkSize} boundary=${boundary}`).not.toBe('\r\n')
        }
      }
    })

    test('never separates the two characters of a CRLF when chunks overlap', async () => {
      // every "\n" of this text belongs to a CRLF
      const text = Array.from({ length: 80 }, (_, i) => `w${i}`).map((word, i) => word + (i % 7 === 0 ? '\r\n\r\n' : i % 3 === 0 ? '\r\n' : ' ')).join('') + '\r\n'.repeat(20)
      for (const chunkSize of [1, 2, 3, 5, 12, 40]) {
        for (const chunkOverlap of [1, 2, 6, 100]) {
          const chunks = await split(text, chunkSize, chunkOverlap)
          const label = `chunkSize=${chunkSize} chunkOverlap=${chunkOverlap}`
          expect(chunks.filter(chunk => chunk.startsWith('\n') || chunk.endsWith('\r')), label).toEqual([])
          expect(chunks.filter(chunk => !text.includes(chunk)), label).toEqual([])
        }
      }
    })

    test('never cuts a surrogate pair, with or without overlap', async () => {
      const text = '😀'.repeat(20) + '𠀋語a𝒳é🇫🇷'.repeat(10)
      for (const chunkSize of [1, 2, 3, 4, 5, 8, 33]) {
        for (const chunkOverlap of [0, 1, 2, 3, 100]) {
          const chunks = await split(text, chunkSize, chunkOverlap)
          const label = `chunkSize=${chunkSize} chunkOverlap=${chunkOverlap}`
          expect(chunks.filter(hasLoneSurrogate), label).toEqual([])
          if (chunkOverlap === 0) expect(chunks.join(''), label).toBe(text)
        }
      }
    })

    test('counts the chunk size in UTF-16 units and never exceeds it with astral characters', async () => {
      const chunks = await split('😀'.repeat(10), 5, 0)
      expect(chunks).toEqual(Array(5).fill('😀😀'))
    })

    test('returns a character that cannot be cut on its own when it is longer than the chunk size', async () => {
      expect(await split('a😀\r\nb', 1, 0)).toEqual(['a', '😀', '\r\n', 'b'])
    })

    test('keeps the lone surrogates of the source text as they are', async () => {
      const text = 'ab\uD83Dcd\uDE00ef'
      const chunks = await split(text, 3, 0)
      expect(chunks.join('')).toBe(text)
    })

    test.each([[10, 10], [10, 50], [2, 1], [1, 5]])('terminates and keeps every word with chunk size %i and overlap %i', async (chunkSize, chunkOverlap) => {
      const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
      const chunks = await split(text, chunkSize, chunkOverlap)
      expect(chunks.every(chunk => chunk.length <= chunkSize)).toBe(true)
      expect(chunks.join('').replace(/\s+/g, '').length).toBeGreaterThanOrEqual(text.replace(/\s+/g, '').length)
      if (chunkSize >= 10) {
        for (const word of text.split(' ')) expect(chunks.some(chunk => chunk.includes(word)), word).toBe(true)
      }
    })

    test('a single token longer than the chunk size is cut into chunks of the chunk size', async () => {
      const text = 'x'.repeat(1050)
      const chunks = await split(text, 100, 0)
      expect(chunks.join('')).toBe(text)
      expect(chunks.every(chunk => chunk.length <= 100)).toBe(true)
      expect(chunks.length).toBeLessThanOrEqual(12)
    })

  })

  describe('Large documents', () => {

    test('handles 1MB document without blocking', async () => {
      // Create a 1MB text document
      const paragraph = 'This is a test paragraph that will be repeated many times to create a large document.\n\n'
      const text = paragraph.repeat(1024 * 10) // ~1MB

      const startTime = Date.now()
      const chunks = await splitter.split(text)
      const endTime = Date.now()

      expect(chunks.length).toBeGreaterThan(0)
      expect(endTime - startTime).toBeLessThan(10000) // Should complete within 10 seconds
    })

    test('handles JSON-like structure', async () => {
      // Simulate JSON content
      const json = JSON.stringify({
        data: Array(1000).fill(null).map((_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: 'A'.repeat(100),
        }))
      }, null, 2)

      const chunks = await splitter.split(json)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.every(chunk => chunk.length <= 110)).toBe(true)
    })

  })

  describe('Real-world scenarios', () => {

    test('handles code with various indentation', async () => {
      const code = `
function example() {
  const x = 1;

  if (x > 0) {
    console.log('positive');
  }

  return x;
}

class MyClass {
  constructor() {
    this.value = 0;
  }

  method() {
    return this.value;
  }
}
`.repeat(5)

      const chunks = await splitter.split(code)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.every(chunk => chunk.length <= 110)).toBe(true)
    })

    test('handles markdown document', async () => {
      const markdown = `
# Heading 1

This is a paragraph.

## Heading 2

Another paragraph with some content.

- List item 1
- List item 2
- List item 3

### Heading 3

More content here.
`.repeat(10)

      const chunks = await splitter.split(markdown)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.some(chunk => chunk.includes('# Heading 1'))).toBe(true)
    })

    test('handles text with mixed line endings', async () => {
      const text = 'Line1\n\nLine2\nLine3\n\nLine4'
      const chunks = await splitter.split(text)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.join('')).toContain('Line1')
      expect(chunks.join('')).toContain('Line4')
    })

  })

  describe('Non-blocking behavior', () => {

    test('completes async operation', async () => {
      const text = 'a'.repeat(10000)

      // Should return a promise and complete
      const promise = splitter.split(text)
      expect(promise).toBeInstanceOf(Promise)

      const chunks = await promise
      expect(chunks.length).toBeGreaterThan(0)
    })

    test('handles multiple concurrent splits', async () => {
      const text1 = 'First document\n\n'.repeat(100)
      const text2 = 'Second document\n\n'.repeat(100)
      const text3 = 'Third document\n\n'.repeat(100)

      const [chunks1, chunks2, chunks3] = await Promise.all([
        splitter.split(text1),
        splitter.split(text2),
        splitter.split(text3),
      ])

      expect(chunks1.length).toBeGreaterThan(0)
      expect(chunks2.length).toBeGreaterThan(0)
      expect(chunks3.length).toBeGreaterThan(0)
    })

  })

})
