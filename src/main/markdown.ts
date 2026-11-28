
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs'
import MarkdownItKatex from '@iktakahiro/markdown-it-katex'
import MarkdownItMark from 'markdown-it-mark'
import MarkdownItDiagram from 'markdown-it-diagram'
import hljs from 'highlight.js'
import { isSafeExternalUrl } from './external_links'
import { resolveMediaUrl } from './media_url'

const mdOptions: MarkdownIt.Options = {
  html: false,
  highlight: function (str: string, lang: string) {
    try {
      let code = '<pre class="hljs"><code class="hljs variable-font-size">';
      if (lang && hljs.getLanguage(lang)) {
        code += hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } else {
        code += hljs.highlightAuto(str).value;
      }
      code += '</code></pre>';
      code += '<p><a onclick="navigator.clipboard.writeText(window.api.base64.decode(\'' + Buffer.from(str).toString('base64') + '\'));';
      code += 'this.innerHTML = \'Copied!\'; setTimeout(() => this.innerHTML = \'Copy code\', 1000); return false;" class="copy-code">Copy code</a></p>';
      return code;
    } catch (error) {
      console.log(error)
    }
    return '' // use external default escaping
  }
}

// function addSourceOffsets(md: MarkdownIt) {
//   const originalParse = md.parse.bind(md);

//   md.parse = (srcText, env) => {
//     const tokens = originalParse(srcText, env);
//     const lines = srcText.split('\n');

//     for (const token of tokens) {
//       if (token.map) {
//         const [startLine, endLine] = token.map;
//         const startOffset = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
//         const endOffset = lines.slice(0, endLine).join('\n').length;
//         token.attrSet('data-md-start', startOffset.toString());
//         token.attrSet('data-md-end', endOffset.toString());
//       }

//       if (token.children) {
//         let offset = token.attrGet('data-md-start') ? parseInt(token.attrGet('data-md-start')!) : 0;
//         for (const child of token.children) {
//           const len = child.content.length;
//           child.attrSet('data-md-start', offset.toString());
//           child.attrSet('data-md-end', (offset + len).toString());
//           offset += len;
//         }
//       }
//     }

//     return tokens;
//   };

//   const originalRenderToken = md.renderer.renderToken.bind(md.renderer);

//   md.renderer.renderToken = function (tokens, idx, options) {
//     const token = tokens[idx];
//     if (token.attrs) {
//       const start = token.attrGet('data-md-start');
//       const end = token.attrGet('data-md-end');
//       if (start && end) {
//         token.attrSet('data-md-start', start);
//         token.attrSet('data-md-end', end);
//       }
//     }
//     return originalRenderToken(tokens, idx, options);
//   };
// }

// for katex processing, we need to replace \[ and \] with $$ to trigger processing
// we also need to handle inline equations \(x\) and \( x \)
// until https://github.com/iktakahiro/markdown-it-katex/pull/13 is merged
const convertMathDelimiters = (text: string): string => {
  let converted = text.replaceAll('\\[', '$$$$').replaceAll('\\]', '$$$$')
  converted = converted.replaceAll('\\( ', '$').replaceAll(' \\)', '$')
  return converted.replaceAll('\\(', '$').replaceAll('\\)', '$')
}

// [start, end[ line ranges of the fenced and indented code blocks
const codeBlockLines = (md: MarkdownIt, markdown: string): [number, number][] => {
  const tokens: Token[] = []
  md.block.parse(markdown, md, {}, tokens)
  return tokens
    .filter((token) => (token.type === 'fence' || token.type === 'code_block') && token.map)
    .map((token) => token.map)
}

// end of the code span opened at `from` by `length` backticks, -1 if it is not closed:
// a span is closed by the next run of exactly as many backticks in the same paragraph
const codeSpanEnd = (text: string, from: number, length: number): number => {
  const paragraphEnd = text.slice(from).search(/\n[ \t]*\n/)
  const limit = paragraphEnd === -1 ? text.length : from + paragraphEnd
  const ticks = /`+/g
  ticks.lastIndex = from
  for (let match = ticks.exec(text); match !== null && match.index < limit; match = ticks.exec(text)) {
    if (match[0].length === length) return match.index + length
  }
  return -1
}

const convertOutsideCodeSpans = (text: string, convert: (text: string) => string): string => {
  let result = ''
  let done = 0
  const ticks = /`+/g
  for (let match = ticks.exec(text); match !== null; match = ticks.exec(text)) {
    let start = match.index
    let length = match[0].length
    // a backtick after an odd number of backslashes is escaped: it does not open a span
    let backslashes = 0
    while (start - backslashes > 0 && text[start - backslashes - 1] === '\\') backslashes++
    if (backslashes % 2 === 1) {
      start++
      length--
      if (length === 0) continue
    }
    const end = codeSpanEnd(text, start + length, length)
    if (end === -1) continue
    result += convert(text.slice(done, start)) + text.slice(start, end)
    done = end
    ticks.lastIndex = end
  }
  return result + convert(text.slice(done))
}

// code blocks and code spans hold program text: \[ \( in a regex or a shell command
// are not math delimiters and must reach the reader as they were written
const convertOutsideCode = (md: MarkdownIt, markdown: string, convert: (text: string) => string): string => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks = codeBlockLines(md, lines.join('\n'))
  const converted: string[] = []
  let line = 0
  const convertUpTo = (end: number) => {
    if (end > line) converted.push(convertOutsideCodeSpans(lines.slice(line, end).join('\n'), convert))
  }
  for (const [start, end] of blocks) {
    if (start < line) continue
    convertUpTo(start)
    converted.push(...lines.slice(start, end))
    line = end
  }
  convertUpTo(lines.length)
  return converted.join('\n')
}

const mdPreprocess = (md: MarkdownIt, markdown: string) => {

  let preprocessed = markdown
  if (/\\[[\]()]/.test(markdown)) {
    preprocessed = convertOutsideCode(md, markdown, convertMathDelimiters)
  }

  // Normalize file:// URLs in markdown links:
  // - Convert Windows backslashes to forward slashes
  // - Encode spaces as %20 (markdown-it doesn't parse URLs with unencoded spaces)
  preprocessed = preprocessed.replace(/\]\(file:\/\/([^)]+)\)/g, (match, path) => {
    const normalized = path.replace(/\\/g, '/').replace(/ /g, '%20')
    return `](file://${normalized})`
  })

  return preprocessed
}

// we want to preserve ollama <think> content as-is: <think>...</think>
// and our own <tool> content as-is: <tool>...</tool>
const restoreKnownTags = (escaped: string) => {
  let restored = escaped
  restored = restored.replace(/&lt;think&gt;/g, '<think>').replace(/&lt;\/think&gt;/g, '</think>')
  restored = restored.replace(/&lt;tool (id|index)=&quot;([^&]+)&quot;&gt;/g, '<tool $1="$2">').replace(/&lt;\/tool&gt;/g, '</tool>')
  return restored
}

// The tags are restored in text only. Doing it on the rendered html also un-escaped
// them inside attributes, where the quotes of <tool id="..."> end the attribute
// (a link title for instance) and what follows becomes attributes of that element.
const preserveKnownTags = (md: MarkdownIt) => {
  md.renderer.rules.text = (tokens, idx) => restoreKnownTags(md.utils.escapeHtml(tokens[idx].content))
}

// markdown-it-diagram copies the body of a mermaid fence into the page as is.
// The renderer reads the diagram source back with textContent, so escaping
// the body keeps the source intact while no markup of the fence goes live.
const escapeMermaidFences = (md: MarkdownIt) => {
  const diagramFence = md.renderer.rules.fence
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
    if (info.split(/\s+/g)[0] !== 'mermaid') {
      return diagramFence(tokens, idx, options, env, self)
    }
    let code = token.content.trim()
    if (code.endsWith('```')) code = code.slice(0, -3)
    return `<pre data-svg="data-diagram-mermaid" class="mermaid diagram-m">\n${md.utils.escapeHtml(code)}\n</pre>\n`
  }
}

// A link is clicked in a window that has the preload api. It must leave that window
// through the window-open handler (target=_blank) and never replace the page, and only
// the urls that handler gives to the system are links at all: anything else (file:,
// smb:, custom schemes, relative urls) keeps its markdown source as text.
// The fragments the app's own messages use as actions (handled in Chat.vue) stay links.
const kActionLink = /^#(settings(_[A-Za-z0-9]+)*|retry_without_(plugins|params))$/
const toText = (token: Token, content: string) => {
  token.type = 'text'
  token.tag = ''
  token.nesting = 0
  token.attrs = null
  token.children = null
  token.content = content
}
const restrictLinks = (md: MarkdownIt) => {
  md.core.ruler.push('restrict_links', (state) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      let refused: Token | null = null
      for (const token of block.children) {
        if (token.type === 'link_open') {
          const href = token.attrGet('href')
          if (href && kActionLink.test(href)) {
            continue
          } else if (isSafeExternalUrl(href)) {
            token.attrSet('target', '_blank')
            token.attrSet('rel', 'noopener noreferrer')
          } else {
            refused = token
          }
        } else if (token.type === 'link_close' && refused) {
          const autolink = token.markup === 'autolink'
          toText(token, autolink ? '>' : `](${refused.attrGet('href') ?? ''})`)
          toText(refused, autolink ? '<' : '[')
          refused = null
        }
      }
    }
  })
}

// An image is loaded as soon as it is rendered, by a page that reads local files and
// network shares as readily as web pages. Its source is the caller's decision
// (see media_url.ts): the url to load instead, or null and the image keeps its markdown
// source as text. Without a caller no local file is an image.
export type MediaResolver = (url: string) => string | null
const resolveRemoteMedia: MediaResolver = (url) => resolveMediaUrl(url, [])
const restrictImages = (md: MarkdownIt) => {
  md.core.ruler.push('restrict_images', (state) => {
    const resolveMedia: MediaResolver = state.env?.resolveMedia ?? resolveRemoteMedia
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      for (const token of block.children) {
        if (token.type !== 'image') continue
        const src = token.attrGet('src') ?? ''
        const resolved = resolveMedia(src)
        if (resolved) {
          token.attrSet('src', resolved)
        } else {
          toText(token, `![${token.content}](${src})`)
        }
      }
    }
  })
}

export type RenderMarkdownOptions = {
  resolveMedia?: MediaResolver
}

let md: MarkdownIt | null = null

export const renderMarkdown = (markdown: string, options: RenderMarkdownOptions = {}): string => {
  
  // init
  if (!md) {

    md = new MarkdownIt(mdOptions)

    // add support for file:// urls: images only and as far as restrictImages
    // lets them through, links are restricted below
    const validateLink = md.validateLink
    md.validateLink = (url) =>  url.startsWith('file://') ? true : validateLink(url)

    // plugins
    md.use(MarkdownItKatex)
    md.use(MarkdownItMark)
    md.use(MarkdownItDiagram)
    escapeMermaidFences(md)
    preserveKnownTags(md)
    restrictLinks(md)
    restrictImages(md)
    // addSourceOffsets(md)
  
  }

  // do it
  return md.render(mdPreprocess(md, markdown), { resolveMedia: options.resolveMedia })
}
