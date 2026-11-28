
import { Configuration } from 'types/config'
import defaultSettings from '@root/defaults/settings.json'

export default class {

  config: Configuration
  chunkSize: number
  chunkOverlap: number
  separators: string[] = ["\n\n", "\n", " ", ""]

  constructor(config: Configuration) {
    this.config = config
    this.chunkSize = this.config.rag?.chunkSize ?? defaultSettings.rag.chunkSize
    this.chunkOverlap = this.config.rag?.chunkOverlap ?? defaultSettings.rag.chunkOverlap
  }

  // Non-blocking implementation of recursive character text splitting
  // Based on LangChain's RecursiveCharacterTextSplitter but with yields to prevent UI blocking
  async split(text: string, abortSignal?: AbortSignal): Promise<string[]> {
    return this.splitTextRecursive(text, this.separators, abortSignal)
  }

  private async splitTextRecursive(text: string, separators: string[], abortSignal?: AbortSignal): Promise<string[]> {
    const finalChunks: string[] = []

    // Check if cancelled
    if (abortSignal?.aborted) {
      throw new Error()
    }

    // Find appropriate separator
    let separator = separators[separators.length - 1]
    let newSeparators: string[] | undefined

    for (const s of separators) {
      if (s === "") {
        separator = s
        break
      }
      if (this.separatorRegex(s).test(text)) {
        separator = s
        newSeparators = separators.slice(separators.indexOf(s) + 1)
        break
      }
    }

    // Split on separator
    const splits = this.splitOnSeparator(text, separator)

    // Merge and recursively split
    // (splits keep their separator, so they are merged without adding it again)
    const mergeSeparator = ""
    const goodSplits: string[] = []
    let iterationCount = 0

    for (const s of splits) {
      // Yield every 100 iterations to prevent blocking and check for cancellation
      if (++iterationCount % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve))
        if (abortSignal?.aborted) {
          throw new Error()
        }
      }

      if (s.length < this.chunkSize) {
        goodSplits.push(s)
      } else {
        if (goodSplits.length > 0) {
          const mergedText = await this.mergeSplits(goodSplits, mergeSeparator, abortSignal)
          finalChunks.push(...mergedText)
          goodSplits.length = 0
        }

        if (!newSeparators) {
          finalChunks.push(s)
        } else {
          const otherChunks = await this.splitTextRecursive(s, newSeparators, abortSignal)
          finalChunks.push(...otherChunks)
        }
      }
    }

    if (goodSplits.length > 0) {
      const mergedText = await this.mergeSplits(goodSplits, mergeSeparator, abortSignal)
      finalChunks.push(...mergedText)
    }

    return finalChunks
  }

  private splitOnSeparator(text: string, separator: string): string[] {
    if (!separator) {
      // Split on characters, not UTF-16 code units: surrogate pairs and CRLF stay whole
      return text.match(/\r\n|[\s\S]/gu) ?? []
    }
    // Keep separator at start of each split
    const splits = text.split(this.separatorRegex(separator))
    return splits.filter(s => s !== "")
  }

  // Matches the position in front of a separator. A "\n" of the separator also
  // stands for "\r\n", and the position between "\r" and "\n" never matches.
  private separatorRegex(separator: string): RegExp {
    const regexEscapedSeparator = separator.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&").replace(/\n/g, "\\r?\\n")
    return new RegExp(`(?=${regexEscapedSeparator})(?<!\\r(?=\\n))`)
  }

  private async mergeSplits(splits: string[], separator: string, abortSignal?: AbortSignal): Promise<string[]> {
    const docs: string[] = []
    const currentDoc: string[] = []
    let total = 0
    let iterationCount = 0

    for (const d of splits) {
      // Yield every 100 iterations to prevent blocking and check for cancellation
      if (++iterationCount % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve))
        if (abortSignal?.aborted) {
          throw new Error()
        }
      }

      const len = d.length

      if (total + len + currentDoc.length * separator.length > this.chunkSize) {
        if (currentDoc.length > 0) {
          const doc = currentDoc.join(separator)
          if (doc) {
            docs.push(doc)
          }

          // Keep overlap
          while (total > this.chunkOverlap ||
            (total + len + currentDoc.length * separator.length > this.chunkSize && total > 0)) {
            total -= currentDoc[0].length
            currentDoc.shift()
          }
        }
      }

      currentDoc.push(d)
      total += len
    }

    const doc = currentDoc.join(separator)
    if (doc) {
      docs.push(doc)
    }

    return docs
  }

}
