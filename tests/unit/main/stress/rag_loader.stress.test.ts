
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Loader from '@main/rag/loader'
import { Configuration } from '@/types/config'
import { bug } from './bug'

let root: string
let loader: Loader

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-loader-stress-'))
  loader = new Loader({} as Configuration)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const sitemap = (urls: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>\n    <loc>${url}</loc>\n    <lastmod>2026-11-27</lastmod>\n  </url>`).join('\n')}
</urlset>`

describe('Loader.isParseable', () => {

  const supported = ['txt', 'md', 'pdf', 'docx', 'pptx', 'xlsx', 'json', 'js', 'html', 'csv']
  const unsupported = ['png', 'jpg', 'zip', 'exe', 'mp4', 'bin']

  const variants = (extension: string) => [extension, extension.toUpperCase(), extension[0].toUpperCase() + extension.slice(1)]

  test.each(supported)('.%s files are supported whatever the case of the extension and the shape of the path', (extension) => {
    for (const variant of variants(extension)) {
      for (const origin of [`/docs/file.${variant}`, `C:\\Docs\\My File.${variant}`, `/docs/archive.tar.v2/notes.final.${variant}`, `relative.${variant}`]) {
        expect(loader.isParseable('file', origin), origin).toBe(true)
      }
    }
  })

  test.each(unsupported)('.%s files are not supported', (extension) => {
    for (const variant of variants(extension)) {
      expect(loader.isParseable('file', `/docs/file.${variant}`)).toBe(false)
    }
  })

  test.each(['/docs/README', '/docs.txt/README', 'C:\\Docs.pdf\\LICENSE', '/docs/', ''])('"%s" has no extension and is not supported', (origin) => {
    expect(loader.isParseable('file', origin)).toBe(false)
  })

  test('folders are not documents, web sources and text always are', () => {
    expect(loader.isParseable('folder', '/docs/folder.txt')).toBe(false)
    expect(loader.isParseable('url', 'not even a url')).toBe(true)
    expect(loader.isParseable('sitemap', 'https://example.com/sitemap.xml')).toBe(true)
    expect(loader.isParseable('text', 'some text')).toBe(true)
  })

})

describe('Loader.loadFile', () => {

  test.each(['notes.txt', 'NOTES.TXT', 'data.json', 'with space and ünïcödé.md'])('%s is read as text', async (name) => {
    const file = path.join(root, name)
    fs.writeFileSync(file, 'line one\r\nline two\n')
    expect(await loader.load('file', file)).toBe('line one\r\nline two\n')
  })

  test('a missing or unsupported file resolves to nothing instead of throwing', async () => {
    expect(await loader.load('file', path.join(root, 'missing.txt'))).toBeFalsy()
    fs.writeFileSync(path.join(root, 'image.png'), 'png')
    expect(await loader.load('file', path.join(root, 'image.png'))).toBeFalsy()
  })

  test('a corrupt pdf or office document resolves to nothing instead of throwing', async () => {
    for (const name of ['broken.pdf', 'broken.docx', 'broken.xlsx']) {
      fs.writeFileSync(path.join(root, name), 'this is not the right format')
      expect(await loader.load('file', path.join(root, name))).toBeFalsy()
    }
  })

})

describe('Loader web sources', () => {

  test('a web page is converted to text', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html><body><p>First paragraph.</p><p>Second &amp; last.</p></body></html>', { status: 200 }))
    expect(await loader.load('url', 'https://example.com/page')).toBe('First paragraph.\n\nSecond & last.')
  })

  test('a network error is reported', async () => {
    await expect(loader.load('url', 'https://example.com/page')).rejects.toThrow('network access is not allowed in tests')
    await expect(loader.getSitemapUrls('https://example.com/sitemap.xml')).rejects.toThrow('Failed to load sitemap')
  })

  bug.each([403, 404, 500, 503])('an HTTP %i error page is not returned as the text of a web page', async (status) => {
    // loadUrl() never looks at response.ok
    vi.mocked(fetch).mockResolvedValue(new Response('<html><body><h1>Error</h1><p>Something went wrong</p></body></html>', { status }))
    const text = await loader.load('url', 'https://example.com/page').catch((): string => null)
    expect(text || null).toBeNull()
  })

  test('stress: a sitemap of 5000 urls is listed completely and in order', async () => {
    const urls = Array.from({ length: 5000 }, (_, i) => `https://example.com/docs/page-${i}?lang=en&amp;v=${i % 7}`)
    vi.mocked(fetch).mockResolvedValue(new Response(sitemap(urls), { status: 200 }))
    const listed = await loader.getSitemapUrls('https://example.com/sitemap.xml')
    expect(listed).toEqual(urls.map(url => url.replace('&amp;', '&')))
  })

  test('a sitemap with one url or none is listed', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(sitemap(['https://example.com/only']), { status: 200 }))
    expect(await loader.getSitemapUrls('https://example.com/sitemap.xml')).toEqual(['https://example.com/only'])
    vi.mocked(fetch).mockResolvedValue(new Response(sitemap([]), { status: 200 }))
    expect(await loader.getSitemapUrls('https://example.com/sitemap.xml')).toEqual([])
  })

  bug.each([403, 404, 500, 503])('an HTTP %i answer to a sitemap request is an error, not an empty sitemap', async (status) => {
    // getSitemapUrls() parses whatever body it gets: the error page has no <urlset>, so the sitemap "has no pages"
    vi.mocked(fetch).mockResolvedValue(new Response('<html><body><h1>Error</h1></body></html>', { status }))
    await expect(loader.getSitemapUrls('https://example.com/sitemap.xml')).rejects.toThrow()
  })

})
