import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderMarkdown } from '@main/markdown'
import { bug } from './bug'

// renderMarkdown runs mdPreprocess over the WHOLE markdown string before markdown-it parses it,
// replacing the KaTeX delimiters \[ \] \( \) with $ / $$. That substitution is blind to context,
// so it also rewrites those sequences when they appear inside fenced or inline code - exactly the
// places where backslash-bracket is ordinary program text (sed, regex, awk, LaTeX shown as code).
// These tests only read the text content of the rendered code elements: nothing is executed.

// the first render initialises markdown-it, highlight.js and katex: keep that cost out of the tests
beforeAll(() => {
  renderMarkdown('warm up `code`\n\n```\ncode\n```\n\n```bash\ncode\n```')
})

// katex reports the LaTeX it dislikes with console.warn
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// text content of the first <code> element, with the trailing newline highlight.js keeps removed
const codeText = (markdown: string): string => {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(markdown)
  const code = template.content.querySelector('code')
  return (code?.textContent ?? '').replace(/\n$/, '')
}

describe('renderMarkdown: code that must survive the KaTeX preprocessor', () => {

  // every snippet below is valid program text whose characters must reach the code element verbatim
  const kSnippets: [string, string][] = [
    ['a sed capture group', `sed -E 's/\\(foo\\)\\[0-9\\]/x/' file`],
    ['a grep character class', `grep '\\[0-9\\]' file`],
    ['a bash test', `if [ \\( -f a \\) ]; then echo hi; fi`],
    ['a python regex', `re.match(r'\\(\\d+\\)\\[a\\]', s)`],
    ['escaped square brackets', `arr\\[i\\] = 1`],
    ['escaped parentheses', `call\\(x\\)`],
  ]

  test('highlight.js on its own leaves the characters alone', () => {
    // sanity check that the corruption below comes from the preprocessor, not the highlighter
    for (const [, snippet] of kSnippets) {
      const template = document.createElement('template')
      template.innerHTML = `<pre><code>${snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`
      expect(template.content.querySelector('code')!.textContent).toBe(snippet)
    }
  })

  bug.each(kSnippets)('a fenced code block preserves %s', (_, snippet) => {
    // fails today: mdPreprocess turns \[ \] \( \) into $ / $$ before the fence is parsed
    expect(codeText('```\n' + snippet + '\n```')).toBe(snippet)
  })

  bug.each(kSnippets)('a fenced code block with a language preserves %s', (_, snippet) => {
    // fails today: same substitution, the language tag does not matter
    expect(codeText('```bash\n' + snippet + '\n```')).toBe(snippet)
  })

  bug.each(kSnippets)('an inline code span preserves %s', (_, snippet) => {
    // fails today: inline code is rewritten just like a fenced block
    const inline = snippet.split('\n')[0]
    expect(codeText('here is `' + inline + '` inline')).toBe(inline)
  })

  bug('an escaped bracket in code is not replaced by a dollar sign', () => {
    // the clearest symptom: \[ \] become $$ and \( \) become $
    expect(codeText('`value\\[0\\]`')).not.toContain('$')
  })

})

describe('renderMarkdown: math delimiters outside code are still converted', () => {

  test('a real display equation is handed to katex', () => {
    // this is the behaviour mdPreprocess exists for and must keep working
    const template = document.createElement('template')
    template.innerHTML = renderMarkdown('\\[ x^2 \\]')
    expect(template.content.querySelector('.katex')).not.toBeNull()
  })

})
