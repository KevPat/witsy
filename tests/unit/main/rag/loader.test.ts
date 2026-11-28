
import { expect, test, vi, beforeEach } from 'vitest'
import Loader from '@main/rag/loader'
import { Configuration } from '@/types/config'

const mockConfig = {} as Configuration

beforeEach(() => {
  vi.restoreAllMocks()
})

test('isParseable returns true for url', () => {
  const loader = new Loader(mockConfig)
  expect(loader.isParseable('url', 'https://example.com')).toBe(true)
})

test('isParseable returns true for sitemap', () => {
  const loader = new Loader(mockConfig)
  expect(loader.isParseable('sitemap', 'https://example.com/sitemap.xml')).toBe(true)
})

test('isParseable returns true for text', () => {
  const loader = new Loader(mockConfig)
  expect(loader.isParseable('text', 'some text')).toBe(true)
})

test('loadUrl converts HTML to text', async () => {
  const loader = new Loader(mockConfig)
  const html = '<html><body><p>Test</p><p>Content</p></body></html>'

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => html
  })

  const result = await loader.loadUrl('https://example.com')
  expect(result).toContain('Test')
  expect(result).toContain('Content')
  expect(result).not.toContain('<html>')
  expect(result).not.toContain('<body>')
  expect(result).not.toContain('<p>')
})

test.each([
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [500, 'Internal Server Error'],
  [503, 'Service Unavailable'],
])('loadUrl fails on an HTTP %i answer instead of returning the error page', async (status, statusText) => {
  const loader = new Loader(mockConfig)
  global.fetch = vi.fn().mockResolvedValue(new Response('<html><body><h1>Oops</h1></body></html>', { status, statusText }))

  await expect(loader.loadUrl('https://example.com/page')).rejects.toThrow(`Failed to load https://example.com/page: HTTP ${status} ${statusText}`)
  await expect(loader.load('url', 'https://example.com/page')).rejects.toThrow(`HTTP ${status}`)
})

test('loadUrl does not read the body of an HTTP error answer', async () => {
  const loader = new Loader(mockConfig)
  const text = vi.fn(async () => '<html><body>Oops</body></html>')
  const cancel = vi.fn(async () => {})
  global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: '', body: { cancel }, text })

  await expect(loader.loadUrl('https://example.com/page')).rejects.toThrow(/^Failed to load https:\/\/example\.com\/page: HTTP 502$/)
  expect(text).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('loadUrl reports the HTTP error even when the body cannot be dropped', async () => {
  const loader = new Loader(mockConfig)
  const cancel = vi.fn(async () => { throw new Error('locked') })
  global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', body: { cancel } })
  await expect(loader.loadUrl('https://example.com/page')).rejects.toThrow('HTTP 500 Internal Server Error')

  global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', body: null })
  await expect(loader.loadUrl('https://example.com/page')).rejects.toThrow('HTTP 404 Not Found')
})

test('loadUrl accepts any successful HTTP status', async () => {
  const loader = new Loader(mockConfig)
  global.fetch = vi.fn().mockResolvedValue(new Response('<html><body><p>Cached copy</p></body></html>', { status: 203 }))
  expect(await loader.loadUrl('https://example.com/page')).toBe('Cached copy')
})

test.each([403, 404, 500, 503])('getSitemapUrls fails on an HTTP %i answer instead of returning an empty sitemap', async (status) => {
  const loader = new Loader(mockConfig)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  global.fetch = vi.fn().mockResolvedValue(new Response('<html><body><h1>Oops</h1></body></html>', { status }))

  await expect(loader.getSitemapUrls('https://example.com/sitemap.xml')).rejects.toThrow(`Failed to load sitemap: HTTP ${status}`)
})

test('getSitemapUrls extracts URLs from sitemap', async () => {
  const loader = new Loader(mockConfig)
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>`

  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => sitemapXml })

  const urls = await loader.getSitemapUrls('https://example.com/sitemap.xml')
  expect(urls).toEqual(['https://example.com/page1', 'https://example.com/page2'])
})

test('getSitemapUrls handles single URL in sitemap', async () => {
  const loader = new Loader(mockConfig)
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
</urlset>`

  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => sitemapXml })

  const urls = await loader.getSitemapUrls('https://example.com/sitemap.xml')
  expect(urls).toEqual(['https://example.com/page1'])
})

test('getSitemapUrls throws on sitemap fetch error', async () => {
  const loader = new Loader(mockConfig)

  global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

  await expect(loader.getSitemapUrls('https://example.com/sitemap.xml'))
    .rejects.toThrow('Failed to load sitemap')
})

test('getSitemapUrls handles invalid XML gracefully', async () => {
  const loader = new Loader(mockConfig)
  const invalidXml = 'not valid xml'

  global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => invalidXml })

  const urls = await loader.getSitemapUrls('https://example.com/sitemap.xml')
  expect(urls).toEqual([])
})
