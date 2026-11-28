
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderMarkdown } from '@main/markdown'

// The html returned by renderMarkdown is assigned with v-html in windows that expose window.api
// (MessageItemBodyBlock, MessageItemTableBlock) and nothing sanitizes it afterwards. Whatever a
// model, a tool result, a web page or an imported chat can get through it runs with the privileges
// of the preload script. These tests only parse the html into an inert <template>: nothing runs.

const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

// the packaged renderer is loaded with loadFile so relative urls resolve against a file: url
const kAppUrl = 'file:///app/renderer/main_window/index.html'
const kAllowedProtocols = ['http:', 'https:', 'mailto:']

// the only inline handler the renderer adds itself: the "Copy code" link below a code block
const kCopyCodeHandler = /^navigator\.clipboard\.writeText\(window\.api\.base64\.decode\('[A-Za-z0-9+/=]*'\)\);this\.innerHTML = 'Copied!'; setTimeout\(\(\) => this\.innerHTML = 'Copy code', 1000\); return false;$/

// elements that markdown has no syntax for
const kActiveElements = 'script, iframe, frame, object, embed, form, input, button, textarea, select, base, meta, link, style, video, audio, svg, math:not(.katex math), img'

const parse = (markdown: string): DocumentFragment => {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(markdown)
  return template.content
}

const describeElement = (el: Element): string => el.outerHTML.slice(0, 120)

const eventHandlers = (root: DocumentFragment): string[] => {
  const found: string[] = []
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.toLowerCase().startsWith('on')) continue
      if (el.matches('a.copy-code') && attr.name === 'onclick' && kCopyCodeHandler.test(attr.value)) continue
      found.push(`${attr.name} on ${describeElement(el)}`)
    }
  }
  return found
}

const activeElements = (root: DocumentFragment): string[] => {
  return Array.from(root.querySelectorAll(kActiveElements))
    // plantuml, dot and ditaa fences are rendered by plantuml.com through an image
    .filter((el) => !(el.matches('div[data-svg="data-diagram-plantuml"] > img') && el.getAttribute('src').startsWith('https://www.plantuml.com/plantuml/svg/')))
    .map(describeElement)
}

const unsafeLinks = (root: DocumentFragment): string[] => {
  const found: string[] = []
  for (const el of root.querySelectorAll('[href], [src], [action], [formaction], [xlink\\:href]')) {
    for (const name of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
      const value = el.getAttribute(name)
      if (value === null || value.startsWith('#')) continue
      let protocol: string
      try {
        protocol = new URL(value, kAppUrl).protocol
      } catch {
        continue // not a url: it cannot be navigated to
      }
      if (!kAllowedProtocols.includes(protocol)) found.push(`${name}="${value}"`)
    }
  }
  return found
}

const violations = (markdown: string): string[] => {
  const root = parse(markdown)
  return [...eventHandlers(root), ...activeElements(root), ...unsafeLinks(root)]
}

// katex reports the LaTeX it does not like with console.warn
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderMarkdown: content that is neutralized today', () => {

  const kRawHtml = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example/"></iframe>',
    '<svg onload=alert(1)><foreignObject><script>alert(1)</script></foreignObject></svg>',
    '<a href="javascript:alert(1)">click</a>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<form action="https://evil.example/"><input name=q><button>go</button></form>',
    '<details open ontoggle=alert(1)>',
    '<div style="position:fixed;inset:0" onclick="alert(1)">',
  ]

  const kContexts: [string, (html: string) => string][] = [
    ['paragraph', (html) => `before ${html} after`],
    ['html block', (html) => `${html}\n\ntext`],
    ['heading', (html) => `# ${html}`],
    ['list item', (html) => `- one\n- ${html}\n- three`],
    ['blockquote', (html) => `> ${html}`],
    ['emphasis', (html) => `**${html}** and _${html}_`],
    ['mark', (html) => `==${html}==`],
    ['table cell', (html) => `| a | b |\n|---|---|\n| ${html} | 1 |`],
    ['link text', (html) => `[${html}](https://example.com/)`],
    ['inline code', (html) => `\`${html}\``],
    ['fenced code', (html) => `\`\`\`\n${html}\n\`\`\``],
    ['fenced code with a language', (html) => `\`\`\`html\n${html}\n\`\`\``],
    ['fenced code with an unknown language', (html) => `\`\`\`nosuchlanguage\n${html}\n\`\`\``],
    ['fence info string', (html) => `\`\`\`${html.replaceAll('`', '')}\ncode\n\`\`\``],
    ['indented code', (html) => `text\n\n    ${html}`],
    ['plantuml fence', (html) => `\`\`\`plantuml\n${html}\n\`\`\``],
    ['dot fence', (html) => `\`\`\`dot\n"><${html}\n\`\`\``],
    ['ditaa fence', (html) => `\`\`\`ditaa\n${html}\n\`\`\``],
    ['inline math', (html) => `$${html}$`],
    ['block math', (html) => `$$\n${html}\n$$`],
    ['think tag', (html) => `<think>${html}</think>`],
    ['error tag', (html) => `<error>${html}</error>`],
  ]

  test.each(kContexts)('raw html in a %s stays text', (_, wrap) => {
    for (const html of kRawHtml) {
      expect(violations(wrap(html)), wrap(html)).toEqual([])
    }
  })

  test.each([
    ['javascript', '[x](javascript:alert(1))'],
    ['javascript, mixed case', '[x](JaVaScRiPt:alert(1))'],
    ['javascript, entity encoded', '[x](javascript&#58;alert(1))'],
    ['javascript, leading whitespace', '[x](  javascript:alert(1))'],
    ['javascript, in angle brackets', '[x](<javascript:alert(1)>)'],
    ['javascript, autolink', '<javascript:alert(1)>'],
    ['javascript, reference', '[x][r]\n\n[r]: javascript:alert(1)'],
    ['vbscript', '[x](vbscript:msgbox(1))'],
    ['data html', '[x](data:text/html,<script>alert(1)</script>)'],
    ['data html, base64', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['javascript image', '![x](javascript:alert(1))'],
    ['data svg image', '![x](data:image/svg+xml,<svg onload=alert(1)>)'],
  ])('a %s url does not become a link or an image', (_, markdown) => {
    const root = parse(markdown)
    expect(root.querySelector('a[href]'), markdown).toBeNull()
    expect(root.querySelector('img'), markdown).toBeNull()
    expect(violations(markdown), markdown).toEqual([])
  })

  test.each([
    ['double quoted title', '[x](https://example.com/ "\\" onmouseover=\\"alert(1)")'],
    ['single quoted title', `[x](https://example.com/ '" onmouseover="alert(1)')`],
    ['parenthesized title', '[x](https://example.com/ (" onmouseover="alert(1)))'],
    ['quote in the url', '[x](https://example.com/"onmouseover="alert(1))'],
    ['quote in an autolink', '<https://example.com/"onmouseover="alert(1)>'],
    ['think tag in a title', `[x](https://example.com/ '<think> onmouseover=alert(1)')`],
    ['error tag in a title', `[x](https://example.com/ '<error>" onmouseover="alert(1)</error>')`],
  ])('a %s cannot break out of the attribute', (_, markdown) => {
    expect(violations(markdown), markdown).toEqual([])
    const links = Array.from(parse(markdown).querySelectorAll('a'))
    for (const link of links) {
      // target and rel are set by the renderer itself so that a link never replaces the app page
      expect(link.getAttributeNames().sort()).toEqual(link.hasAttribute('title') ? ['href', 'rel', 'target', 'title'] : ['href', 'rel', 'target'])
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  test.each([
    ['href', '$\\href{javascript:alert(1)}{x}$'],
    ['url', '$\\url{javascript:alert(1)}$'],
    ['htmlData', '$\\htmlData{onclick=alert(1)}{x}$'],
    ['htmlClass', '$\\htmlClass{copy-code}{x}$'],
    ['htmlStyle', '$\\htmlStyle{position:fixed}{x}$'],
    ['includegraphics', '$\\includegraphics{https://evil.example/x.png}$'],
    ['an unknown command followed by a quote', `$\\nosuchcommand' onmouseover='alert(1)$`],
    ['an unbalanced group followed by a quote', `$$\\frac{a}{b' autofocus onfocus='alert(1)$$`],
  ])('katex %s is not trusted', (_, markdown) => {
    const root = parse(markdown)
    expect(violations(markdown), markdown).toEqual([])
    expect(root.querySelector('a, img, [onclick], [data-onclick], .copy-code')).toBeNull()
    for (const el of root.querySelectorAll('.katex-error')) {
      expect(el.getAttributeNames().sort()).toEqual(['class', 'title'])
    }
  })

  test('the tags the renderer un-escapes on purpose carry no attacker controlled attribute', () => {
    const root = parse('<think>reasoning</think>\n\n<tool id="call_1"></tool>\n\n<tool index="0"></tool>\n\n<tool id="a onmouseover=alert(1)"></tool>')
    expect(root.querySelector('think').textContent).toBe('reasoning')
    const tools = Array.from(root.querySelectorAll('tool'))
    expect(tools).toHaveLength(3)
    expect(tools.map((tool) => tool.getAttributeNames())).toEqual([['id'], ['index'], ['id']])
    expect(tools[2].getAttribute('id')).toBe('a onmouseover=alert(1)')
  })

  test('http, https and mailto links are rendered', () => {
    const root = parse('[a](http://example.com/a) [b](https://example.com/b?x=1&y=2 "title") <mailto:someone@example.com> <https://example.com/c>')
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'http://example.com/a', 'https://example.com/b?x=1&y=2', 'mailto:someone@example.com', 'https://example.com/c',
    ])
    expect(root.querySelector('a[title]').getAttribute('title')).toBe('title')
  })

  test('the copy link of a code block only embeds base64', () => {
    const code = `'); alert(1); ('\n</a><img src=x onerror=alert(1)>\n\\'); alert(2); //`
    const root = parse(`\`\`\`js\n${code}\n\`\`\``)
    const link = root.querySelector('a.copy-code')
    expect(link.getAttribute('onclick')).toMatch(kCopyCodeHandler)
    const base64 = link.getAttribute('onclick').match(/decode\('([^']*)'\)/)[1]
    expect(Buffer.from(base64, 'base64').toString()).toBe(`${code}\n`)
    expect(violations(`\`\`\`js\n${code}\n\`\`\``)).toEqual([])
  })

})

describe('renderMarkdown: mermaid fences', () => {

  const prefix = (body: string, with_: string): string => body.split('\n').map((line) => `${with_}${line}`).join('\n')

  const kFences: [string, (body: string) => string][] = [
    ['backtick fence', (body) => `\`\`\`mermaid\n${body}\n\`\`\``],
    ['tilde fence', (body) => `~~~mermaid\n${body}\n~~~`],
    ['fence with extra info', (body) => `\`\`\`mermaid theme=dark\n${body}\n\`\`\``],
    ['fence in a list', (body) => `- item\n\n  \`\`\`mermaid\n${prefix(body, '  ')}\n  \`\`\``],
    ['fence in a blockquote', (body) => `> \`\`\`mermaid\n${prefix(body, '> ')}\n> \`\`\``],
    ['unterminated fence', (body) => `\`\`\`mermaid\n${body}`],
  ]

  test.each(kFences)('a diagram in a %s is handed to the renderer as text', (_, fence) => {
    const root = parse(fence('graph TD\n  A-->B'))
    const pre = root.querySelector('pre.mermaid')
    expect(pre).not.toBeNull()
    expect(pre.children).toHaveLength(0)
    expect(pre.textContent).toContain('A-->B')
  })

  test.each(kFences)('html in a %s stays text', (_, fence) => {
    // markdown-it-diagram used to copy the fence body into <pre class="mermaid"> without escaping it
    const markdown = fence('graph TD\n<img src=x onerror=alert(1)>')
    expect(violations(markdown), markdown).toEqual([])
  })

  test.each([
    ['an image with an error handler', '<img src=x onerror=alert(1)>'],
    ['an image after closing the pre', '</pre><img src=x onerror=alert(1)>'],
    ['a script', '<script>alert(1)</script>'],
    ['an iframe', '<iframe src="https://evil.example/"></iframe>'],
    ['an svg with a load handler', '<svg onload=alert(1)>'],
    ['a javascript link', '<a href="javascript:alert(1)">click</a>'],
    ['a form', '<form action="https://evil.example/"><button>continue</button></form>'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
    ['a handler on a harmless element', '<b onmouseover=alert(1)>hover</b>'],
  ])('%s in a mermaid fence stays text', (_, payload) => {
    const markdown = `\`\`\`mermaid\n${payload}\n\`\`\``
    expect(violations(markdown), markdown).toEqual([])
    expect(parse(markdown).querySelector('pre.mermaid').children).toHaveLength(0)
  })

  test('a mermaid fence in a user message stays text', () => {
    // user messages (pasted text, text selected in another app) render their fences the same way
    const root = parse('```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"]-->B\n```')
    expect(root.querySelector('img')).toBeNull()
  })

})

describe('renderMarkdown: tool tags inside attributes', () => {

  test.each([
    ['single quoted link title', `[x](https://example.com/ '<tool id=" onmouseover=alert(1) x=">')`],
    ['double quoted link title', '[x](https://example.com/ "<tool id=\\" onmouseover=alert(1) x=\\">")'],
    ['parenthesized link title', '[x](https://example.com/ (<tool id=" onmouseover=location=name x=">))'],
    ['reference link title', `[x][r]\n\n[r]: https://example.com/ '<tool id=" onmouseover=alert(1) x=">'`],
    ['link title using index', `[x](https://example.com/ '<tool index=" onmouseover=alert(1) x=">')`],
    ['link title with a quoted handler', `[x](https://example.com/ "<tool id=\\" onmouseover='alert(1)' x=\\">")`],
    ['link title with an animation', `[x](https://example.com/ '<tool id=" style=animation-name:fadeIn onanimationstart=alert(1) x=">')`],
    ['image title', '![x](https://example.com/x.png "<tool id=\\" onerror=alert(1) x=\\">")'],
  ])('a tool tag in a %s does not add attributes', (_, markdown) => {
    // the tool tag used to be turned back into markup wherever it was, here inside title="..."
    expect(eventHandlers(parse(markdown)), markdown).toEqual([])
    const el = parse(markdown).querySelector('a, img')
    expect(el.getAttributeNames().filter((name) => !['href', 'src', 'alt', 'title', 'target', 'rel'].includes(name))).toEqual([])
    if (el.matches('a')) expect([el.getAttribute('target'), el.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer'])
  })

  test('a tool tag in a link title cannot restyle the link', () => {
    // same un-escaping: style= lets a link cover the whole window even without a handler
    const root = parse(`[x](https://evil.example/ '<tool id=" style=position:fixed;inset:0 x=">')`)
    expect(root.querySelector('a').hasAttribute('style')).toBe(false)
  })

})

describe('renderMarkdown: link schemes', () => {

  test.each([
    ['a local executable', '[report](file:///C:/Windows/System32/calc.exe)'],
    ['a local file', '[notes](file:///etc/passwd)'],
    ['a file on a remote share', '[invoice](file://evil.example/share/invoice.exe)'],
    ['a file url in an autolink', '<file:///Applications/Calculator.app>'],
    ['an smb share', '[share](smb://evil.example/share)'],
    ['ms-msdt', '[help](ms-msdt:/id PCWDiagnostic /skip force)'.replaceAll(' ', '%20')],
    ['search-ms', '[results](search-ms:query=x&crumb=location:%5C%5Cevil.example%5Cshare)'],
    ['ms-officecmd', '[open](ms-officecmd:%7B%22id%22:3%7D)'],
    ['vscode', '[open](vscode://file/etc/passwd)'],
    ['ssh', '[connect](ssh://-oProxyCommand=calc@evil.example)'],
    ['a scheme relative url', '[invoice](//evil.example/share/invoice.exe)'],
  ])('a link to %s is not rendered as a link', (_, markdown) => {
    // validateLink only rejects javascript:, vbscript: and data:, and file: is accepted for images;
    // as a link, the href would reach the window open handler
    expect(unsafeLinks(parse(markdown)), markdown).toEqual([])
  })

  test('a scheme relative url resolves to a remote share in the packaged app', () => {
    expect(new URL('//evil.example/share/invoice.exe', kAppUrl).href).toBe('file://evil.example/share/invoice.exe')
  })

})

describe('renderMarkdown: fuzz', () => {

  const kPayloads = [
    '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>', '</pre>', '</code>', '</a>', '</p>',
    '\' onmouseover=\'alert(1)', '" onmouseover="alert(1)', ' onmouseover=alert(1) x=', '<think>', '</think>', '<error>', '</error>',
    '</tool>', '&lt;img src=x onerror=alert(1)&gt;', '&quot;', '&#34;', '&gt;', 'javascript:alert(1)', '\\', '`', '```', '~~~', '$', '$$',
    '*', '_', '==', '[', ']', '(', ')', '<', '>', '"', '\'', '|', '\n', '\n\n', ' ', 'text', 'graph TD', 'A-->B', '{', '}', '%', '#', '-', '=',
  ]

  const kToolPayloads = ['<tool id="', '<tool index="', '">', '"></tool>', '<tool id=" onmouseover=alert(1) x=">', '<tool index=" style=position:fixed x=">']

  const kSafeLanguages = ['', 'js', 'html', 'python', 'plantuml', 'dot', 'ditaa', 'nosuchlanguage', 'MERMAID ', 'mermaidx']

  const kSafeUrls = ['https://example.com/', 'http://example.com/a?b=c&d=e', 'mailto:a@example.com', 'javascript:alert(1)', 'vbscript:x', 'data:text/html,x', '#anchor']

  const kUnsafeUrls = ['file:///etc/passwd', 'smb://evil.example/share', 'ms-msdt:/id', '//evil.example/share/x.exe']

  const generate = (rand: () => number, payloads: string[], languages: string[], urls: string[]): string => {
    const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]
    const some = (): string => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(payloads)).join('')
    const inline = (): string => some().replaceAll('\n', ' ')
    const blocks: (() => string)[] = [
      () => some(),
      () => `# ${inline()}`,
      () => `- ${inline()}\n- ${inline()}`,
      () => `> ${some()}`,
      () => `**${inline()}** _${inline()}_ ==${inline()}==`,
      () => `[${inline()}](${pick(urls)} "${inline()}")`,
      () => `[x](${pick(urls)} '${inline()}')`,
      () => `[x](${pick(urls)} (${inline()}))`,
      () => `[x](${pick(urls)}${inline().replaceAll(' ', '')})`,
      () => `[x][r]\n\n[r]: ${pick(urls)} '${inline()}'`,
      () => `<${pick(urls)}${inline().replaceAll(' ', '')}>`,
      () => `\`${inline()}\``,
      () => `\`\`\`${pick(languages)}\n${some()}\n\`\`\``,
      () => `~~~${pick(languages)}\n${some()}\n~~~`,
      () => `| ${inline()} | b |\n|---|---|\n| ${inline()} | 1 |`,
      () => `$${inline()}$`,
      () => `$$\n${some()}\n$$`,
      () => `<think>${some()}</think>`,
      () => `<error>${some()}</error>`,
      () => `\\[ ${inline()} \\] \\( ${inline()} \\)`,
    ]
    return Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(blocks)()).join('\n\n')
  }

  test('200 random documents without tool tags, mermaid fences or exotic schemes are neutralized', () => {
    const rand = mulberry32(20261127)
    for (let i = 0; i < 200; i++) {
      const markdown = generate(rand, kPayloads, kSafeLanguages, kSafeUrls)
      expect(violations(markdown), JSON.stringify(markdown)).toEqual([])
    }
  })

  test('rendering random documents never throws and always returns a string', () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 200; i++) {
      const markdown = generate(rand, [...kPayloads, ...kToolPayloads], [...kSafeLanguages, 'mermaid'], [...kSafeUrls, ...kUnsafeUrls])
      expect(typeof renderMarkdown(markdown)).toBe('string')
    }
  })

  test('200 random documents with tool tags are neutralized', () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 200; i++) {
      const markdown = generate(rand, [...kPayloads, ...Array(10).fill(kToolPayloads).flat()], kSafeLanguages, kSafeUrls)
      expect(violations(markdown), JSON.stringify(markdown)).toEqual([])
    }
  })

  test('200 random documents with mermaid fences are neutralized', () => {
    const rand = mulberry32(43)
    for (let i = 0; i < 200; i++) {
      const markdown = generate(rand, kPayloads, [...kSafeLanguages, 'mermaid', 'mermaid'], kSafeUrls)
      expect(violations(markdown), JSON.stringify(markdown)).toEqual([])
    }
  })

  test('200 random documents with exotic schemes are neutralized', () => {
    const rand = mulberry32(44)
    for (let i = 0; i < 200; i++) {
      const markdown = generate(rand, kPayloads, kSafeLanguages, [...kSafeUrls, ...kUnsafeUrls])
      expect(violations(markdown), JSON.stringify(markdown)).toEqual([])
    }
  })

})
