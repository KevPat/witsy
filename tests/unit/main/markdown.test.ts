import { test, expect } from 'vitest'
import path from 'path'
import { MediaResolver, renderMarkdown } from '@main/markdown'
import { resolveMediaUrl } from '@main/media_url'
import { addExtension, closeOpenMarkdownTags, extractCodeBlockContent, extractHtmlContent, getCodeBlocks, isHtmlContent } from '@services/markdown'

test('renders markdown', () => {
  const markdown = '# Hello World'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<h1>Hello World</h1>')
})

test('does not render html', () => {
  const markdown = '<h1>Hello World</h1>'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p>&lt;h1&gt;Hello World&lt;/h1&gt;</p>')
})

test('escapes event handlers in untrusted HTML', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html).not.toContain('<img')
})

test('does not create javascript links', () => {
  const html = renderMarkdown('[click](javascript:alert(1))')
  expect(html).not.toContain('<a')
  expect(html).not.toContain('href=')
})

const parseHtml = (markdown: string): DocumentFragment => {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(markdown)
  return template.content
}

const mermaidBlock = (markdown: string): HTMLElement => {
  return parseHtml(markdown).querySelector<HTMLElement>('pre.mermaid')
}

test('escapes the body of a mermaid fence', () => {
  const markdown = '```mermaid\ngraph TD\n<img src=x onerror=alert(1)>\n</pre><script>alert(1)</script>\n```'
  const html = renderMarkdown(markdown)
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<script')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  const pre = mermaidBlock(markdown)
  expect(pre.children).toHaveLength(0)
  expect(pre.parentNode.querySelectorAll('img, script')).toHaveLength(0)
})

test('keeps the mermaid source intact for the renderer', () => {
  const source = [
    'graph TD',
    '  A --> B',
    '  B["x < y"] -->|"a & b > c"| C[\'single\']',
    '  C --> D["<b>bold</b> &amp; #quot;entity#quot;"]',
    '  D -.-> E{{"100% <br/> done"}}',
  ].join('\n')
  for (const markdown of [`\`\`\`mermaid\n${source}\n\`\`\``, `~~~mermaid\n${source}\n~~~`, `\`\`\`mermaid\n${source}\`\`\``]) {
    const pre = mermaidBlock(markdown)
    expect(pre.getAttribute('data-svg')).toBe('data-diagram-mermaid')
    expect(pre.children).toHaveLength(0)
    expect(pre.textContent).toBe(`${source}\n`)
  }
})

test('leaves other fences to their renderers', () => {
  const plantuml = renderMarkdown('```plantuml\nA -> B\n```')
  expect(plantuml).toMatch(/^<div data-svg="data-diagram-plantuml" class="diagram-m"><img src="https:\/\/www\.plantuml\.com\/plantuml\/svg\/[\w-]+" alt="uml diagram"><\/div>$/)
  const code = renderMarkdown('```mermaidx\nA --> B\n```')
  expect(code).toContain('<pre class="hljs">')
  expect(code).not.toContain('class="mermaid')
})

// test('renders deeplinks', () => {
//   const markdown = 'Click <a href="#section">here</a>'
//   const html = renderMarkdown(markdown)
//   expect(html).toContain('<p>Click <a href="#section">here</a></p>')
// })

test('renders external links that open outside of the app page', () => {
  const markdown = '[link](https://example.com)'
  const html = renderMarkdown(markdown)
  expect(html).toBe('<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>\n')
})

test('renders http, https and mailto links only', () => {
  const root = parseHtml([
    '[a](http://example.com/a) [b](HTTPS://example.com/b?x=1&y=2 "title") <mailto:someone@example.com> <https://example.com/c>',
    '[ref][1] [![logo](https://example.com/logo.png)](https://example.com/d)',
    '[1]: https://example.com/ref',
  ].join('\n\n'))
  const links = Array.from(root.querySelectorAll('a'))
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    'http://example.com/a', 'HTTPS://example.com/b?x=1&y=2', 'mailto:someone@example.com', 'https://example.com/c',
    'https://example.com/ref', 'https://example.com/d',
  ])
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  }
  expect(links[1].getAttribute('title')).toBe('title')
  expect(links[5].querySelector('img').getAttribute('src')).toBe('https://example.com/logo.png')
})

test.each([
  ['[link](file://README.md)', '<p>[link](file://README.md)</p>\n'],
  ['[link](file:///Users/test/Application Support/file.md)', '<p>[link](file:///Users/test/Application%20Support/file.md)</p>\n'],
  ['[link](file://C:\\Users\\name\\file.md)', '<p>[link](file://C:/Users/name/file.md)</p>\n'],
  ['[link](file://evil.example/share/invoice.exe)', '<p>[link](file://evil.example/share/invoice.exe)</p>\n'],
  ['[link](search-ms:query=x "title")', '<p>[link](search-ms:query=x)</p>\n'],
  ['<file:///Applications/Calculator.app>', '<p>&lt;file:///Applications/Calculator.app&gt;</p>\n'],
  ['[share](smb://evil.example/share)', '<p>[share](smb://evil.example/share)</p>\n'],
  ['[help](ms-msdt:/id%20PCWDiagnostic)', '<p>[help](ms-msdt:/id%20PCWDiagnostic)</p>\n'],
  ['[open](vscode://file/etc/passwd)', '<p>[open](vscode://file/etc/passwd)</p>\n'],
  ['[x](//evil.example/share/invoice.exe)', '<p>[x](//evil.example/share/invoice.exe)</p>\n'],
  ['[x](/etc/passwd)', '<p>[x](/etc/passwd)</p>\n'],
  ['[x](../other.html)', '<p>[x](../other.html)</p>\n'],
  ['[x](#/settings)', '<p>[x](#/settings)</p>\n'],
  ['[**bold** `code`](file:///etc/passwd)', '<p>[<strong>bold</strong> <code>code</code>](file:///etc/passwd)</p>\n'],
  ['[x][r]\n\n[r]: file:///etc/passwd', '<p>[x](file:///etc/passwd)</p>\n'],
  ['[<b>x</b>](file:///a"onmouseover="alert(1))', '<p>[&lt;b&gt;x&lt;/b&gt;](file:///a%22onmouseover=%22alert(1))</p>\n'],
])('does not make a link of %s', (markdown, expected) => {
  const html = renderMarkdown(markdown)
  expect(html).toBe(expected)
  expect(parseHtml(markdown).querySelector('a')).toBeNull()
})

test('keeps a refused link next to a rendered one as text', () => {
  const root = parseHtml('[a](file:///etc/passwd) [b](https://example.com/) <smb://evil.example/share> <https://example.com/c>')
  expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://example.com/', 'https://example.com/c'])
  expect(root.textContent).toBe('[a](file:///etc/passwd) b <smb://evil.example/share> https://example.com/c\n')
})

test('keeps the links the app uses as actions in its own messages', () => {
  const root = parseHtml('Enter your key in [Settings](#settings_models) or [try again](#retry_without_plugins).')
  const links = Array.from(root.querySelectorAll('a'))
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['#settings_models', '#retry_without_plugins'])
  expect(links.map((a) => a.getAttribute('target'))).toEqual([null, null])
  expect(root.textContent).toBe('Enter your key in Settings or try again.\n')
})

// what the main process does for the renderer, with the app data folder in /data/witsy
// or C:\Users\me\AppData\Roaming\Witsy and no filesystem behind
const posixMedia: MediaResolver = (url) => resolveMediaUrl(url, ['/data/witsy'], { pathImpl: path.posix, realPath: (target) => target })
const winMedia: MediaResolver = (url) => resolveMediaUrl(url, ['C:\\Users\\me\\AppData\\Roaming\\Witsy'], { pathImpl: path.win32, realPath: (target) => target })

const parseMedia = (markdown: string, resolveMedia: MediaResolver = posixMedia): DocumentFragment => {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(markdown, { resolveMedia })
  return template.content
}

test('still renders the images of the app data folder', () => {
  const root = parseMedia('[![logo](file:///data/witsy/images/My Images/logo.png)](https://example.com/)')
  expect(root.querySelector('a').getAttribute('href')).toBe('https://example.com/')
  expect(root.querySelector('a img').getAttribute('src')).toBe('file:///data/witsy/images/My%20Images/logo.png')
  expect(root.querySelector('a img').getAttribute('alt')).toBe('logo')
})

test.each([
  ['![chart](file:///data/witsy/images/chart.png)', 'file:///data/witsy/images/chart.png'],
  ['![chart](file:///data/witsy/workspaces/0b5c/images/chart.png)', 'file:///data/witsy/workspaces/0b5c/images/chart.png'],
  ['![chart](file:///data/witsy/images/../images/chart.png)', 'file:///data/witsy/images/chart.png'],
  ['![chart](file:///data/witsy/images/%63hart.png)', 'file:///data/witsy/images/chart.png'],
  ['![chart](/data/witsy/images/chart.png)', 'file:///data/witsy/images/chart.png'],
  ['![chart][c]\n\n[c]: file:///data/witsy/images/chart.png', 'file:///data/witsy/images/chart.png'],
  ['| a |\n|---|\n| ![chart](file:///data/witsy/images/chart.png) |', 'file:///data/witsy/images/chart.png'],
])('renders the app data image of %s', (markdown, src) => {
  const images = parseMedia(markdown).querySelectorAll('img')
  expect(images).toHaveLength(1)
  expect(images[0].getAttribute('src')).toBe(src)
  expect(images[0].getAttribute('alt')).toBe('chart')
})

test.each([
  ['![x](file:///Users/me/secret.png)', '<p>![x](file:///Users/me/secret.png)</p>\n'],
  ['![x](/etc/passwd "title")', '<p>![x](/etc/passwd)</p>\n'],
  ['![x](file:///data/witsy)', '<p>![x](file:///data/witsy)</p>\n'],
  ['![x](file:///data/witsy-other/a.png)', '<p>![x](file:///data/witsy-other/a.png)</p>\n'],
  ['![x](file:///data/witsy/../secret.png)', '<p>![x](file:///data/witsy/../secret.png)</p>\n'],
  ['![x](file:///data/witsy/images/../../secret.png)', '<p>![x](file:///data/witsy/images/../../secret.png)</p>\n'],
  ['![x](file:///data/witsy/images/%2e%2e/%2e%2e/secret.png)', '<p>![x](file:///data/witsy/images/%2e%2e/%2e%2e/secret.png)</p>\n'],
  ['![x](file:///data/witsy/images/..%2F..%2Fsecret.png)', '<p>![x](file:///data/witsy/images/..%2F..%2Fsecret.png)</p>\n'],
  ['![x](file:///data/witsy/images/a.png#/../../../secret.png)', '<p>![x](file:///data/witsy/images/a.png#/../../../secret.png)</p>\n'],
  ['![x](file://evil.example/share/pixel.png)', '<p>![x](file://evil.example/share/pixel.png)</p>\n'],
  ['![x](file://C:\\Users\\me\\secret.png)', '<p>![x](file://C:/Users/me/secret.png)</p>\n'],
  ['![x](//evil.example/share/pixel.png)', '<p>![x](//evil.example/share/pixel.png)</p>\n'],
  ['![x](/etc/passwd)', '<p>![x](/etc/passwd)</p>\n'],
  ['![x](../../secret.png)', '<p>![x](../../secret.png)</p>\n'],
  ['![x](images/a.png)', '<p>![x](images/a.png)</p>\n'],
  ['![x](smb://evil.example/share/pixel.png)', '<p>![x](smb://evil.example/share/pixel.png)</p>\n'],
  ['![x][r]\n\n[r]: file:///etc/passwd', '<p>![x](file:///etc/passwd)</p>\n'],
  ['![**b** <i>i</i>](file:///etc/passwd)', '<p>![**b** &lt;i&gt;i&lt;/i&gt;](file:///etc/passwd)</p>\n'],
  ['![x](file:///a"onerror="alert(1))', '<p>![x](file:///a%22onerror=%22alert(1))</p>\n'],
])('does not make an image of %s', (markdown, expected) => {
  expect(renderMarkdown(markdown, { resolveMedia: posixMedia })).toBe(expected)
  expect(parseMedia(markdown).querySelector('img')).toBeNull()
})

test('does not make an image of a local file when the caller names no folder', () => {
  const markdown = '![x](file:///data/witsy/images/chart.png)'
  expect(renderMarkdown(markdown)).toBe(`<p>${markdown}</p>\n`)
  expect(parseHtml('![x](file:///Users/me/secret.png) ![y](/etc/passwd)').querySelector('img')).toBeNull()
})

test('keeps a refused image as text next to a rendered one and inside a link', () => {
  const root = parseMedia('![a](file:///etc/passwd) ![b](file:///data/witsy/images/b.png) [![c](file:///etc/hosts)](https://example.com/)')
  expect(Array.from(root.querySelectorAll('img')).map((img) => img.getAttribute('src'))).toEqual(['file:///data/witsy/images/b.png'])
  expect(root.querySelector('a').getAttribute('href')).toBe('https://example.com/')
  expect(root.querySelector('a').textContent).toBe('![c](file:///etc/hosts)')
  expect(root.textContent).toBe('![a](file:///etc/passwd)  ![c](file:///etc/hosts)\n')
})

test('renders the images of a Windows app data folder only', () => {
  const src = 'file:///C:/Users/me/AppData/Roaming/Witsy/images/a.png'
  for (const markdown of [
    '![a](file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\a.png)',
    '![a](file:///C:/Users/me/AppData/Roaming/Witsy/images/a.png)',
    '![a](file:///c:/Users/me/AppData/Roaming/Witsy/workspaces/../images/a.png)',
  ]) {
    expect(parseMedia(markdown, winMedia).querySelector('img').getAttribute('src').toLowerCase()).toBe(src.toLowerCase())
  }
  for (const markdown of [
    '![a](file://C:\\Users\\me\\secret.png)',
    '![a](file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\..\\..\\..\\secret.png)',
    '![a](file:///C:/Users/me/AppData/Roaming/Witsy/images/..%5C..%5C..%5Csecret.png)',
    '![a](file://\\\\evil.example\\share\\pixel.png)',
    '![a](file://evil.example/share/pixel.png)',
    '![a](//evil.example/share/pixel.png)',
    '![a](file:///D:/Users/me/AppData/Roaming/Witsy/images/a.png)',
  ]) {
    expect(parseMedia(markdown, winMedia).querySelector('img')).toBeNull()
  }
})

test('does not change remote and inline images', () => {
  const data = 'data:image/png;base64,iVBORw0KGgo='
  const root = parseHtml(`![a](https://example.com/a.png?x=1&y=2 "title") ![b](http://example.com/b.png) ![c](${data})`)
  const images = Array.from(root.querySelectorAll('img'))
  expect(images.map((img) => img.getAttribute('src'))).toEqual(['https://example.com/a.png?x=1&y=2', 'http://example.com/b.png', data])
  expect(images.map((img) => img.getAttribute('alt'))).toEqual(['a', 'b', 'c'])
  expect(images[0].getAttribute('title')).toBe('title')
})

test('renders inline code', () => {
  const markdown = 'This is `inline code`'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p>This is <code>inline code</code></p>')
})

test('renders typed code block', () => {
  const markdown = '```python\nprint("Hello World")\n```'
  const html = renderMarkdown(markdown)
  const lines = html.split('\n')
  expect(lines.length).toBe(3)
  expect(lines[0]).toBe('<pre class="hljs"><code class="hljs variable-font-size"><span class="hljs-built_in">print</span>(<span class="hljs-string">&quot;Hello World&quot;</span>)')
  expect(lines[1]).toBe('</code></pre><p><a onclick="navigator.clipboard.writeText(window.api.base64.decode(\'cHJpbnQoIkhlbGxvIFdvcmxkIikK\'));this.innerHTML = \'Copied!\'; setTimeout(() => this.innerHTML = \'Copy code\', 1000); return false;" class="copy-code">Copy code</a></p>')
  expect(lines[2]).toBe('')
})

test('renders auto code block', () => {
  const markdown = '```\nprint("Hello World")\n```'
  const html = renderMarkdown(markdown)
  const lines = html.split('\n')
  expect(lines.length).toBe(3)
  expect(lines[0]).toBe('<pre class="hljs"><code class="hljs variable-font-size"><span class="hljs-function"><span class="hljs-title">print</span><span class="hljs-params">(<span class="hljs-string">&quot;Hello World&quot;</span>)</span></span>')
  expect(lines[1]).toBe('</code></pre><p><a onclick="navigator.clipboard.writeText(window.api.base64.decode(\'cHJpbnQoIkhlbGxvIFdvcmxkIikK\'));this.innerHTML = \'Copied!\'; setTimeout(() => this.innerHTML = \'Copy code\', 1000); return false;" class="copy-code">Copy code</a></p>')
  expect(lines[2]).toBe('')
})

test('renders inline math', () => {
  const markdown = '\\( \\theta^2 \\) \\(\\alpha^2\\)'
  const html = renderMarkdown(markdown)
  expect(html).toContain('θ')
  expect(html).toContain('α')
})

test('renders block math', () => {
  const markdown = '\\[ \\theta^2 \\]'
  const html = renderMarkdown(markdown)
  expect(html).toContain('θ')
})

test('render <think>', () => {
  const markdown = '<think>Thinking</think>'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p><think>Thinking</think></p>')
})

test('render mix', () => {
  const markdown = '<think>Reasoning...</think># <b>instructions.chat.standard:\n"Title"</b>'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p><think>Reasoning...</think># &lt;b&gt;instructions.chat.standard:\n&quot;Title&quot;&lt;/b&gt;</p>')
})

test('render tool with numeric id', () => {
  const markdown = '<tool id="123"></tool>'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p><tool id="123"></tool></p>')
})

test('render tool with alphanumeric id', () => {
  const markdown = '<tool id="call_w6Z8Wj8hhEOaQqRhJbCmLV7e"></tool>'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p><tool id="call_w6Z8Wj8hhEOaQqRhJbCmLV7e"></tool></p>')
})

test('render tool with index', () => {
  const markdown = '<tool index="0"></tool>'
  const html = renderMarkdown(markdown)
  expect(html).toContain('<p><tool index="0"></tool></p>')
})

const codeTexts = (markdown: string): string[] => {
  return Array.from(parseHtml(markdown).querySelectorAll('code')).map((code) => code.textContent.replace(/\n$/, ''))
}

test('does not restore malformed tool tags with injected attributes', () => {
  const html = renderMarkdown('<tool id="safe" onmouseover="alert(1)"></tool>')
  expect(html).toContain('&lt;tool')
  expect(html).not.toContain('<tool')
})

test('does not restore tool and think tags inside attributes', () => {
  const title = '<tool id=" onmouseover=alert(1) style=position:fixed x="><think>'
  for (const markdown of [
    `[x](https://example.com/ '${title}')`,
    `[x][r]\n\n[r]: https://example.com/ '${title}'`,
    `[![alt ${title}](https://example.com/x.png '${title}')](https://example.com/ '${title}')`,
  ]) {
    const root = parseHtml(markdown)
    expect(root.querySelector('tool, think')).toBeNull()
    for (const el of root.querySelectorAll('a, img')) {
      expect(el.getAttributeNames().filter((name) => !['href', 'src', 'alt', 'title', 'target', 'rel'].includes(name))).toEqual([])
      expect(el.getAttribute('title')).toBe(title)
    }
    expect(root.querySelectorAll('a')).toHaveLength(1)
  }
  expect(parseHtml(`![alt ${title}](https://example.com/x.png)`).querySelector('img').getAttribute('alt')).toBe(`alt ${title}`)
})

test('does not restore tool and think tags inside code and diagrams', () => {
  const tags = '<think>hidden</think><tool id="1"></tool>'
  for (const markdown of [`\`${tags}\``, `\`\`\`\n${tags}\n\`\`\``, `    ${tags}`, `\`\`\`mermaid\n${tags}\n\`\`\``, `$\\text{${tags}$`]) {
    const root = parseHtml(markdown)
    expect(root.querySelector('tool, think'), markdown).toBeNull()
    expect(root.textContent, markdown).toContain(tags)
  }
})

test('restores tool and think tags in text wherever the text is', () => {
  const root = parseHtml('# <think>a</think>\n\n- <tool id="call_1"></tool>\n\n> **<tool index="2"></tool>**\n\n| <think>b</think> |\n|---|\n| <tool id="x_y_z"></tool> |')
  expect(Array.from(root.querySelectorAll('think')).map((el) => el.textContent)).toEqual(['a', 'b'])
  expect(Array.from(root.querySelectorAll('tool')).map((el) => el.getAttribute('id') ?? el.getAttribute('index'))).toEqual(['call_1', '2', 'x_y_z'])
})

test('keeps math delimiters in fenced code blocks', () => {
  const code = `sed -E 's/\\(foo\\)\\[0-9\\]/x/' file\nif [ \\( -f a \\) ]; then echo hi; fi`
  const indent = (prefix: string) => code.split('\n').map((line) => `${prefix}${line}`).join('\n')
  for (const markdown of [
    `\`\`\`\n${code}\n\`\`\``,
    `\`\`\`bash\n${code}\n\`\`\``,
    `~~~\n${code}\n~~~`,
    `\`\`\`\`\n${code}\n\`\`\`\``,
    `\`\`\`\n${code}`,
    `\`\`\`\r\n${code.replace('\n', '\r\n')}\r\n\`\`\`\r\n`,
    `- item\n\n  \`\`\`\n${indent('  ')}\n  \`\`\``,
    `> \`\`\`\n${indent('> ')}\n> \`\`\``,
    `text\n\n${indent('    ')}\n\ntext`,
  ]) {
    expect(codeTexts(markdown), markdown).toEqual([code])
  }
})

test('keeps math delimiters in inline code', () => {
  expect(codeTexts('Use `grep \'\\[0-9\\]\'` or `call\\(x\\)` here')).toEqual([`grep '\\[0-9\\]'`, 'call\\(x\\)'])
  expect(codeTexts('Use ``a ` \\(b\\) ` c`` here')).toEqual(['a ` \\(b\\) ` c'])
  expect(codeTexts('Spans `a\\[0\\]\nb\\(1\\)` lines')).toEqual(['a\\[0\\] b\\(1\\)'])
  expect(codeTexts('| `x\\[0\\]` |\n|---|\n| `y\\(1\\)` |')).toEqual(['x\\[0\\]', 'y\\(1\\)'])
})

test('still renders math next to code', () => {
  const root = parseHtml('Inline `\\(x\\)` then \\(\\alpha^2\\)\n\n```latex\n\\[ \\theta \\]\n```\n\n\\[ \\beta^2 \\]\n\n    \\(indented\\)\n\n\\( \\gamma \\)')
  expect(Array.from(root.querySelectorAll('code')).map((code) => code.textContent.trim())).toEqual(['\\(x\\)', '\\[ \\theta \\]', '\\(indented\\)'])
  expect(root.querySelectorAll('.katex-error')).toHaveLength(0)
  const math = Array.from(root.querySelectorAll('.katex-mathml annotation')).map((el) => el.textContent.trim())
  expect(math).toEqual(['\\alpha^2', '\\beta^2', '\\gamma'])
})

test('backticks that do not make a code span do not hide math', () => {
  const rendered = (markdown: string) => Array.from(parseHtml(markdown).querySelectorAll('.katex-mathml annotation')).map((el) => el.textContent.trim())
  expect(rendered('a ` b \\(\\alpha\\)')).toEqual(['\\alpha'])
  expect(rendered('a ` b\n\n\\(\\alpha\\) ` c')).toEqual(['\\alpha'])
  expect(rendered('a `` b \\(\\alpha\\) ` c')).toEqual(['\\alpha'])
  expect(rendered('\\`not code \\(\\alpha\\) \\`')).toEqual(['\\alpha'])
  expect(rendered('`code` \\(\\alpha\\) `code` \\(\\beta\\)')).toEqual(['\\alpha', '\\beta'])
})

test('close open markdowntags', () => {

  // invalid
  expect(closeOpenMarkdownTags('This is bold text**')).toBe('This is bold text**')
  expect(closeOpenMarkdownTags('This is bold text*')).toBe('This is bold text*')
  expect(closeOpenMarkdownTags('This is bold text')).toBe('This is bold text')

  // simple cases
  expect(closeOpenMarkdownTags('This is **bold text**')).toBe('This is **bold text**')
  expect(closeOpenMarkdownTags('This is **bold text*')).toBe('This is **bold text**')
  expect(closeOpenMarkdownTags('This is **bold text')).toBe('This is **bold text**')

  // nested cases
  expect(closeOpenMarkdownTags('This is **bold *nested* text**')).toBe('This is **bold *nested* text**')
  // expect(closeOpenMarkdownTags('This is **bold *nested* text*')).toBe('This is **bold *nested* text**')
  expect(closeOpenMarkdownTags('This is **bold *nested* text')).toBe('This is **bold *nested* text**')
  expect(closeOpenMarkdownTags('This is **bold *nested*')).toBe('This is **bold *nested**')
  expect(closeOpenMarkdownTags('This is **bold *nested')).toBe('This is **bold *nested**')

  // underscores in identifiers should not be treated as markdown
  expect(closeOpenMarkdownTags('<artifact title="meditation_timer')).toBe('<artifact title="meditation_timer')

  // inline code cases
  expect(closeOpenMarkdownTags('This is `inline code')).toBe('This is `inline code`')
  expect(closeOpenMarkdownTags('This is `inline **code')).toBe('This is `inline **code`')
  expect(closeOpenMarkdownTags('This is `inline **code*')).toBe('This is `inline **code*`')
  expect(closeOpenMarkdownTags('This is `inline **code**')).toBe('This is `inline **code**`')

  // inline code cases
  expect(closeOpenMarkdownTags('This is ```inline code')).toBe('This is ```inline code```')
  expect(closeOpenMarkdownTags('This is ```inline **code')).toBe('This is ```inline **code```')
  expect(closeOpenMarkdownTags('This is ```inline **code*')).toBe('This is ```inline **code*```')
  expect(closeOpenMarkdownTags('This is ```inline **code**')).toBe('This is ```inline **code**```')

  // links
  expect(closeOpenMarkdownTags('[link](file://README.md)')).toBe('[link](file://README.md)')
  expect(closeOpenMarkdownTags('[link](https://example.com')).toBe('[link](https://example.com)')
  expect(closeOpenMarkdownTags('[link]')).toBe('[link]')
  expect(closeOpenMarkdownTags('[link')).toBe('[link]')

  // Underscore formatting (equivalent to asterisk)
  expect(closeOpenMarkdownTags('This is __bold text__')).toBe('This is __bold text__')
  expect(closeOpenMarkdownTags('This is __bold text_')).toBe('This is __bold text__')
  expect(closeOpenMarkdownTags('This is __bold text')).toBe('This is __bold text__')
  expect(closeOpenMarkdownTags('This is _italic text_')).toBe('This is _italic text_')
  expect(closeOpenMarkdownTags('This is _italic text')).toBe('This is _italic text_')

  // Mixed asterisk and underscore
  expect(closeOpenMarkdownTags('This is **bold _italic_**')).toBe('This is **bold _italic_**')
  expect(closeOpenMarkdownTags('This is **bold _italic_')).toBe('This is **bold _italic_**')
  expect(closeOpenMarkdownTags('This is **bold _italic')).toBe('This is **bold _italic_**')
  expect(closeOpenMarkdownTags('This is _italic **bold**_')).toBe('This is _italic **bold**_')
  expect(closeOpenMarkdownTags('This is _italic **bold**')).toBe('This is _italic **bold**_')
  expect(closeOpenMarkdownTags('This is _italic **bold')).toBe('This is _italic **bold**_')

  // Tilde code blocks
  expect(closeOpenMarkdownTags('~~~code block')).toBe('~~~code block~~~')
  expect(closeOpenMarkdownTags('~~~python\nprint("hello")')).toBe('~~~python\nprint("hello")~~~')
  expect(closeOpenMarkdownTags('~~~\n**bold inside code**')).toBe('~~~\n**bold inside code**~~~')

  // Mixed code block types
  expect(closeOpenMarkdownTags('```code\n~~~nested')).toBe('```code\n~~~nested```')
  expect(closeOpenMarkdownTags('~~~code\n```nested')).toBe('~~~code\n```nested~~~')

  // Multiple unclosed tags
  expect(closeOpenMarkdownTags('**bold _italic `code')).toBe('**bold _italic `code`_**')
  expect(closeOpenMarkdownTags('_italic **bold `code')).toBe('_italic **bold `code`**_')

  // Code blocks with markdown inside (should not process internal markdown)
  expect(closeOpenMarkdownTags('```\n**this should not be processed**\n*neither this*')).toBe('```\n**this should not be processed**\n*neither this*```')
  expect(closeOpenMarkdownTags('`**bold inside inline code**')).toBe('`**bold inside inline code**`')

  // Empty tags at end of input (should not be stacked)
  expect(closeOpenMarkdownTags('Text **')).toBe('Text **')
  expect(closeOpenMarkdownTags('Text *')).toBe('Text *')
  expect(closeOpenMarkdownTags('Text `')).toBe('Text `')
  expect(closeOpenMarkdownTags('Text ```')).toBe('Text ```')
  expect(closeOpenMarkdownTags('Text ~~~')).toBe('Text ~~~')

  // Link edge cases
  expect(closeOpenMarkdownTags('[text](url')).toBe('[text](url)')
  expect(closeOpenMarkdownTags('[text](')).toBe('[text]()')
  expect(closeOpenMarkdownTags('[text]')).toBe('[text]')
  expect(closeOpenMarkdownTags('[incomplete')).toBe('[incomplete]')
  expect(closeOpenMarkdownTags('![image](url')).toBe('![image](url)')
  expect(closeOpenMarkdownTags('![image](')).toBe('![image]()')

  // Complex nested scenarios
  expect(closeOpenMarkdownTags('**bold with `code` inside**')).toBe('**bold with `code` inside**')
  expect(closeOpenMarkdownTags('**bold with `code` inside')).toBe('**bold with `code` inside**')
  expect(closeOpenMarkdownTags('**bold with `unclosed code')).toBe('**bold with `unclosed code`**')

  // Empty string and whitespace
  expect(closeOpenMarkdownTags('')).toBe('')
  expect(closeOpenMarkdownTags('   ')).toBe('   ')
  expect(closeOpenMarkdownTags('**   **')).toBe('**   **')

  // Single characters
  expect(closeOpenMarkdownTags('*')).toBe('*')
  expect(closeOpenMarkdownTags('`')).toBe('`')
  expect(closeOpenMarkdownTags('_')).toBe('_')

  // Multiple separate unclosed tags
  expect(closeOpenMarkdownTags('**bold and _italic')).toBe('**bold and _italic_**')
  expect(closeOpenMarkdownTags('_italic and **bold')).toBe('_italic and **bold**_')

  // Tags separated by completed tags
  expect(closeOpenMarkdownTags('**complete** and **incomplete')).toBe('**complete** and **incomplete**')
  expect(closeOpenMarkdownTags('_complete_ and _incomplete')).toBe('_complete_ and _incomplete_')

  // Code blocks preventing markdown processing
  expect(closeOpenMarkdownTags('```\n**should not close\n_should not close')).toBe('```\n**should not close\n_should not close```')
  expect(closeOpenMarkdownTags('`inline **bold _italic`')).toBe('`inline **bold _italic`')

  // Real-world streaming scenarios
  expect(closeOpenMarkdownTags('Here is some **bold text that is being stre')).toBe('Here is some **bold text that is being stre**')
  expect(closeOpenMarkdownTags('```python\ndef function():\n    print("hello"')).toBe('```python\ndef function():\n    print("hello"```')
  expect(closeOpenMarkdownTags('Check this [link](https://example.com/very/long/url/that/might/be/cut')).toBe('Check this [link](https://example.com/very/long/url/that/might/be/cut)')

  // does not close _ when tool calls
  expect(closeOpenMarkdownTags('<tool call="call_123"></tool>')).toBe('<tool call="call_123"></tool>')

})

test('getCodeBlocks', () => {

  // no code blocks
  expect(getCodeBlocks('')).toEqual([])
  expect(getCodeBlocks('This is just text')).toEqual([])
  expect(getCodeBlocks('This has **bold** and *italic*')).toEqual([])

  // Simple code blocks
  expect(getCodeBlocks('`inline code`')).toEqual([{ start: 0, end: 12 }])
  expect(getCodeBlocks('```block code```')).toEqual([{ start: 0, end: 15 }])
  expect(getCodeBlocks('~~~block code~~~')).toEqual([{ start: 0, end: 15 }])

  // Code blocks with text before and after
  expect(getCodeBlocks('Here is `code` in text')).toEqual([{ start: 8, end: 13 }])
  expect(getCodeBlocks('Before ```code``` after')).toEqual([{ start: 7, end: 16 }])
  expect(getCodeBlocks('Start ~~~code~~~ end')).toEqual([{ start: 6, end: 15 }])

  // Multiple code blocks
  expect(getCodeBlocks('`first` and `second`')).toEqual([
    { start: 0, end: 6 },
    { start: 12, end: 19 }
  ])
  expect(getCodeBlocks('```first``` and ```second```')).toEqual([
    { start: 0, end: 10 },
    { start: 16, end: 27 }
  ])

  // Mixed code block types
  expect(getCodeBlocks('`inline` and ```block```')).toEqual([
    { start: 0, end: 7 },
    { start: 13, end: 23 }
  ])
  expect(getCodeBlocks('~~~first~~~ and `second`')).toEqual([
    { start: 0, end: 10 },
    { start: 16, end: 23 }
  ])

  // Unclosed code blocks (should extend to end)
  expect(getCodeBlocks('`unclosed code')).toEqual([{ start: 0, end: 13 }])
  expect(getCodeBlocks('```unclosed block')).toEqual([{ start: 0, end: 16 }])
  expect(getCodeBlocks('~~~unclosed block')).toEqual([{ start: 0, end: 16 }])

  // Unclosed with text before
  expect(getCodeBlocks('Text before `unclosed')).toEqual([{ start: 12, end: 20 }])
  expect(getCodeBlocks('Text before ```unclosed')).toEqual([{ start: 12, end: 22 }])

  // Nested scenarios (outer tags win)
  expect(getCodeBlocks('```outer `inner` code```')).toEqual([{ start: 0, end: 23 }])
  expect(getCodeBlocks('~~~outer ```inner``` code~~~')).toEqual([{ start: 0, end: 27 }])
  expect(getCodeBlocks('`outer ```inner``` code`')).toEqual([{ start: 0, end: 23 }])

  // Nested with different types
  expect(getCodeBlocks('```js\n`inline`\nconsole.log();\n```')).toEqual([{ start: 0, end: 32 }])
  expect(getCodeBlocks('~~~\n```nested```\n~~~')).toEqual([{ start: 0, end: 19 }])

  // Adjacent code blocks
  expect(getCodeBlocks('```first``````second```')).toEqual([
    { start: 0, end: 10 },
    { start: 11, end: 22 }
  ])
  expect(getCodeBlocks('`first``second`')).toEqual([
    { start: 0, end: 6 },
    { start: 7, end: 14 }
  ])

  // Edge case: tag characters without forming actual tags
  expect(getCodeBlocks('This has ` but not code')).toEqual([{ start: 9, end: 22 }])
  expect(getCodeBlocks('This has ``` but not')).toEqual([{ start: 9, end: 19 }])

  // Multiple mixed with unclosed
  expect(getCodeBlocks('`closed` and ```unclosed')).toEqual([
    { start: 0, end: 7 },
    { start: 13, end: 23 }
  ])
})

// Tests for new utility functions

test('extractCodeBlockContent - with backticks', () => {
  const content = '```javascript\nconsole.log("hello")\n```'
  const result = extractCodeBlockContent(content)
  expect(result).toBe('console.log("hello")')
})

test('extractCodeBlockContent - without backticks', () => {
  const content = 'Just plain text'
  const result = extractCodeBlockContent(content)
  expect(result).toBe('Just plain text')
})

test('extractCodeBlockContent - empty content', () => {
  const content = ''
  const result = extractCodeBlockContent(content)
  expect(result).toBe('')
})

test('addExtension - no extension', () => {
  expect(addExtension('myfile', '.txt')).toBe('myfile.txt')
})

test('addExtension - short extension', () => {
  expect(addExtension('file.md', '.txt')).toBe('file.txt')
})

test('addExtension - multiple dots', () => {
  expect(addExtension('my.awesome.file.md', '.txt')).toBe('my.awesome.file.txt')
})

test('addExtension - long filename part after dot', () => {
  expect(addExtension('filewithverylongext', '.txt')).toBe('filewithverylongext.txt')
})

test('isHtmlContent - with ```html code block', () => {
  const content = '```html\n<html><body>test</body></html>\n```'
  expect(isHtmlContent(content)).toBe(true)
})

test('isHtmlContent - with DOCTYPE in code block', () => {
  const content = '```\n<!DOCTYPE html>\n<html><body>test</body></html>\n```'
  expect(isHtmlContent(content)).toBe(true)
})

test('isHtmlContent - with <html> in code block', () => {
  const content = '```\n<html><body>test</body></html>\n```'
  expect(isHtmlContent(content)).toBe(true)
})

test('isHtmlContent - raw DOCTYPE', () => {
  const content = '<!DOCTYPE html>\n<html><body>test</body></html>'
  expect(isHtmlContent(content)).toBe(true)
})

test('isHtmlContent - raw <html>', () => {
  const content = '<html><body>test</body></html>'
  expect(isHtmlContent(content)).toBe(true)
})

test('isHtmlContent - not HTML', () => {
  const content = 'Just some markdown text'
  expect(isHtmlContent(content)).toBe(false)
})

test('isHtmlContent - code block without HTML', () => {
  const content = '```javascript\nconsole.log("test")\n```'
  expect(isHtmlContent(content)).toBe(false)
})

test('extractHtmlContent - from ```html block', () => {
  const content = '```html\n<html><body>test</body></html>\n```'
  const result = extractHtmlContent(content)
  expect(result).toBe('<html><body>test</body></html>')
})

test('extractHtmlContent - from ``` block with DOCTYPE', () => {
  const content = '```\n<!DOCTYPE html>\n<html><body>test</body></html>\n```'
  const result = extractHtmlContent(content)
  expect(result).toBe('<!DOCTYPE html>\n<html><body>test</body></html>')
})

test('extractHtmlContent - from ``` block with <html>', () => {
  const content = '```\n<html><body>test</body></html>\n```'
  const result = extractHtmlContent(content)
  expect(result).toBe('<html><body>test</body></html>')
})

test('extractHtmlContent - raw DOCTYPE', () => {
  const content = '<!DOCTYPE html>\n<html><body>test</body></html>'
  const result = extractHtmlContent(content)
  expect(result).toBe('<!DOCTYPE html>\n<html><body>test</body></html>')
})

test('extractHtmlContent - raw <html>', () => {
  const content = '<html><body>test</body></html>'
  const result = extractHtmlContent(content)
  expect(result).toBe('<html><body>test</body></html>')
})

test('extractHtmlContent - not HTML', () => {
  const content = '```javascript\nconsole.log("test")\n```'
  const result = extractHtmlContent(content)
  expect(result).toBe('')
})
