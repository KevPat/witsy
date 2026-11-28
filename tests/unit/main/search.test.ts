
import { vi, expect, test, describe, afterEach } from 'vitest'
import LocalSearch, { fetchPublicUrl } from '@main/search'

// Mock fetch for content fetching
// @ts-expect-error mock
global.fetch = vi.fn(async () => {
  return {
    ok: true,
    headers: {
      get: () => 'text/html',
    },
    text: async () => '<html><body>test</body></html>',
  }
})

vi.mock('electron', async () => {
  const BrowserWindow = vi.fn(function() {
    const handler = (signal: string, callback: () => void) => {
      if (signal === 'dom-ready' || signal === 'did-finish-load') {
        callback()
      }
    }
    // @ts-expect-error mock
    this.webContents = {
      setMaxListeners: vi.fn(),
      session: {
        on: vi.fn(),
        once: vi.fn(),
        setMaxListeners: vi.fn(),
        getUserAgent: vi.fn(() => 'Mozilla/5.0 Witsy/1.0.0 Electron/28.0.0 Safari/537.36'),
        setUserAgent: vi.fn(),
      },
      on: vi.fn(handler),
      once: vi.fn(handler),
      executeJavaScript: vi.fn((script) => {
        if (script === 'document.body.outerHTML') {
          return `<html><body>test</body></html>`
        } else if (script === 'document.title') {
          return 'title'
        } else {
          return [
            { title: 'title1', url: 'https://example.com/url1' },
            { title: 'title2', url: 'https://example.com/url2' },
            { title: 'title3', url: 'https://example.com/url2' },
            { title: 'title4', url: 'https://example.com/url4' },
            { title: 'title5', url: 'https://example.com/url5' },
          ]
        }
      }),
    }
    // @ts-expect-error mock
    this.show = vi.fn()
    // @ts-expect-error mock
    this.hide = vi.fn()
    // @ts-expect-error mock
    let destroyed = false
    // @ts-expect-error mock
    this.isDestroyed = vi.fn(() => destroyed)
    // @ts-expect-error mock
    this.close = vi.fn(() => { destroyed = true })
    // @ts-expect-error mock
    this.destroy = vi.fn(() => { destroyed = true })
  })
  BrowserWindow.prototype.loadURL = vi.fn()
  return { BrowserWindow }
})

test('search', async () => {

  const search = new LocalSearch()
  const res = await search.search('witsy', 3)
  expect(res).toEqual({ results: [
    { title: 'title1', url: 'https://example.com/url1', html: '<html><body>test</body></html>' },
    { title: 'title2', url: 'https://example.com/url2', html: '<html><body>test</body></html>' },
    { title: 'title4', url: 'https://example.com/url4', html: '<html><body>test</body></html>' },
  ]})

})

test('search with abortSignal - basic completion', async () => {
  const search = new LocalSearch()
  const abortController = new AbortController()

  const res = await search.search('witsy', 3, false, abortController.signal)
  expect(res).toEqual({ results: [
    { title: 'title1', url: 'https://example.com/url1', html: '<html><body>test</body></html>' },
    { title: 'title2', url: 'https://example.com/url2', html: '<html><body>test</body></html>' },
    { title: 'title4', url: 'https://example.com/url4', html: '<html><body>test</body></html>' },
  ]})
})

test('search aborted before window opens', async () => {
  const search = new LocalSearch()
  const abortController = new AbortController()

  // Abort immediately
  abortController.abort()

  await expect(
    search.search('witsy', 3, false, abortController.signal)
  ).rejects.toThrow('Operation cancelled')
})

test('search with non-aborted signal completes normally', async () => {
  const search = new LocalSearch()
  const abortController = new AbortController()

  // Don't abort - just pass the signal
  const res = await search.search('witsy', 3, false, abortController.signal)

  // Should complete successfully
  expect(res.results).toHaveLength(3)
  expect(abortController.signal.aborted).toBe(false)
})

test('search without abortSignal works normally', async () => {
  const search = new LocalSearch()

  // No signal provided (undefined)
  const res = await search.search('witsy', 3, false, undefined)
  expect(res.results).toHaveLength(3)
})

test('search accepts abortSignal parameter', async () => {
  const search = new LocalSearch()
  const abortController = new AbortController()

  // Verify the method signature accepts abortSignal
  const res = await search.search('witsy', 3, false, abortController.signal)
  expect(res.results).toHaveLength(3)
})

test('search aborted before execution rejects immediately', async () => {
  const search = new LocalSearch()
  const abortController = new AbortController()

  // Abort before calling search
  abortController.abort()

  await expect(
    search.search('witsy', 3, false, abortController.signal)
  ).rejects.toThrow('Operation cancelled')
})

test('search in test mode shows window', async () => {
  const search = new LocalSearch()
  const res = await search.search('witsy', 3, true)
  expect(res.results).toHaveLength(3)
})

test('test method returns true on success', async () => {
  const search = new LocalSearch()
  const result = await search.test()
  expect(result).toBe(true)
})

test('search with PDF content', async () => {
  // Mock fetch to return PDF content
  const originalFetch = global.fetch
  // @ts-expect-error mock
  global.fetch = vi.fn(async () => {
    return {
      ok: true,
      headers: {
        get: () => 'application/pdf',
      },
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  })

  // Mock getTextContent
  vi.doMock('@main/text', () => ({
    getTextContent: vi.fn().mockResolvedValue('PDF content text')
  }))

  const search = new LocalSearch()
  const res = await search.search('witsy', 3)

  // Restore original fetch
  global.fetch = originalFetch

  expect(res.results).toBeDefined()
})

test('search handles fetch error', async () => {
  // Mock fetch to simulate error
  const originalFetch = global.fetch
  // @ts-expect-error mock
  global.fetch = vi.fn(async () => {
    throw new Error('Network error')
  })

  const search = new LocalSearch()
  // The search should handle the error gracefully
  const res = await search.search('witsy', 3)

  // Restore original fetch
  global.fetch = originalFetch

  // Results should be empty since all fetches failed
  expect(res.results).toHaveLength(0)
})

describe('result pages come from the web', () => {

  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  const page = (status = 200, location?: string) => ({
    ok: status < 300,
    status,
    headers: { get: (name: string) => name === 'location' ? (location ?? null) : 'text/html' },
    text: async () => '<html><body>page</body></html>',
  })

  test.each([
    'http://localhost:8090/api/conversations',
    'http://127.0.0.1:8090/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/admin',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://printer.local/',
    'https://user:secret@example.com/',
    'file:///etc/passwd',
    'file:///C:/Windows/win.ini',
    'ftp://example.com/',
    '/search?q=relative',
    '',
  ])('does not request %s', async (url) => {
    global.fetch = vi.fn() as any
    await expect(fetchPublicUrl(url)).rejects.toThrow()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('requests a public page without following redirects on its own', async () => {
    global.fetch = vi.fn(async () => page()) as any
    const signal = new AbortController().signal

    const response = await fetchPublicUrl('https://example.com/page', signal)

    expect(await response.text()).toContain('page')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/page', { signal, redirect: 'manual' })
  })

  test('follows a redirect to another public page, relative or not', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(page(301, '/moved'))
      .mockResolvedValueOnce(page(302, 'https://www.example.org/final'))
      .mockResolvedValueOnce(page()) as any

    const response = await fetchPublicUrl('https://example.com/page')

    expect(response.status).toBe(200)
    expect(vi.mocked(global.fetch).mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/page',
      'https://example.com/moved',
      'https://www.example.org/final',
    ])
  })

  test.each([
    'http://127.0.0.1:8090/api/conversations',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'file:///etc/passwd',
    '//192.168.1.1/admin',
  ])('does not follow a redirect to %s', async (location) => {
    global.fetch = vi.fn(async () => page(302, location)) as any

    await expect(fetchPublicUrl('https://example.com/page')).rejects.toThrow()

    // the private address was never requested
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/page', expect.anything())
  })

  test('gives up on a redirect loop', async () => {
    global.fetch = vi.fn(async () => page(302, 'https://example.com/again')) as any

    await expect(fetchPublicUrl('https://example.com/page')).rejects.toThrow('Too many redirects')
    expect(global.fetch).toHaveBeenCalledTimes(6)
  })

  test('a redirect answer without location is returned as it is', async () => {
    global.fetch = vi.fn(async () => page(304)) as any
    expect((await fetchPublicUrl('https://example.com/page')).status).toBe(304)
  })

  test('search skips the results it must not download', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { BrowserWindow } = await import('electron')
    const executeJavaScript = vi.fn(async () => [
      { title: 'local api', url: 'http://localhost:8090/api/conversations' },
      { title: 'metadata', url: 'http://169.254.169.254/latest/meta-data/' },
      { title: 'file', url: 'file:///etc/passwd' },
      { title: 'public', url: 'https://example.com/public' },
    ])
    const windows: any[] = vi.mocked(BrowserWindow).mock.instances
    for (const win of windows) win.webContents.executeJavaScript = executeJavaScript
    global.fetch = vi.fn(async () => page()) as any

    const res = await new LocalSearch().search('witsy', 3)

    expect(executeJavaScript).toHaveBeenCalled()
    expect(res.results).toEqual([{ title: 'public', url: 'https://example.com/public', html: '<html><body>page</body></html>' }])
    expect(vi.mocked(global.fetch).mock.calls.map((call) => call[0])).toEqual(['https://example.com/public'])
  })

})
