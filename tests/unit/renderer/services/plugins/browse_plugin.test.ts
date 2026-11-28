
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { PluginExecutionContext } from 'multi-llm-ts'
import Browse from '@services/plugins/browse'
import { useWindowMock } from '@tests/mocks/window'

const kSecret = 'TOKEN-91c7e2'
const kPage = `<html><head><title>Page title</title></head><body><p>hello ${kSecret}</p></body></html>`

const context: PluginExecutionContext = { model: 'mock' }

const fetchMock = vi.fn()

type FakeResponse = { body?: string, contentType?: string, status?: number, finalUrl?: string }

const respondWith = ({ body = kPage, contentType = 'text/html; charset=utf-8', status = 200, finalUrl }: FakeResponse = {}) => {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url: finalUrl ?? url,
    redirected: finalUrl !== undefined,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => body,
  }))
}

const newPlugin = () => new Browse({ enabled: true }, 'workspace')

beforeAll(() => {
  useWindowMock()
})

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  respondWith()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what is downloaded', () => {

  test('a public page is downloaded as before', async () => {
    const result = await newPlugin().execute(context, { url: 'https://example.com/article?id=1#top' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/article?id=1#top', { signal: undefined })
    expect(result).toEqual({ title: 'Page title', content: `hello ${kSecret}` })
  })

  test.each([
    ['loopback', 'http://127.0.0.1:8090/api/config'],
    ['loopback as a number', 'http://2130706433/'],
    ['loopback in hexadecimal', 'http://0x7f.1/'],
    ['loopback in octal', 'http://0177.0.0.1/'],
    ['localhost', 'http://localhost:11434/api/tags'],
    ['ipv6 loopback', 'http://[::1]:8090/'],
    ['ipv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['unspecified address', 'http://0.0.0.0:8090/'],
    ['cloud metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['cloud metadata name', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['private network', 'http://192.168.1.1/cgi-bin/config'],
    ['carrier-grade nat', 'http://100.64.0.1/'],
    ['unique local ipv6', 'http://[fd00::1]/'],
  ])('%s is refused before anything is sent', async (_, url) => {
    const result = await newPlugin().execute(context, { url })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ error: 'URLs of this machine or of a private network cannot be downloaded' })
  })

  test('a url with credentials is refused', async () => {
    const result = await newPlugin().execute(context, { url: 'https://user:password@example.com/' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ error: 'URLs with credentials cannot be downloaded' })
  })

  test.each(['file:///etc/passwd', 'ftp://example.com/a.txt', 'data:text/plain,hello', 'blob:https://example.com/1'])('%s is refused', async (url) => {
    const result = await newPlugin().execute(context, { url })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ error: 'Only http and https URLs can be downloaded' })
  })

  // fetch would resolve these against the address of the app itself
  test.each(['index.html', '/etc/passwd', '../config.json', '', undefined])('%j is refused as invalid', async (url) => {
    const result = await newPlugin().execute(context, { url })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ error: 'Invalid URL' })
  })

  test('a refusal is reported like any other download error', async () => {
    const plugin = newPlugin()
    const result = await plugin.execute(context, { url: 'http://127.0.0.1/' })
    expect(plugin.getCompletedDescription('', { url: 'http://127.0.0.1/' }, result)).toBe('plugins.browse.error')
  })

})

describe('redirects', () => {

  test('the page a public url redirects to is returned when it is public', async () => {
    respondWith({ finalUrl: 'https://www.example.com/article' })
    const result = await newPlugin().execute(context, { url: 'http://example.com/article' })
    expect(result).toEqual({ title: 'Page title', content: `hello ${kSecret}` })
  })

  test.each([
    'http://127.0.0.1:8090/admin',
    'http://localhost/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///etc/passwd',
  ])('the page behind a redirect to %s is not returned', async (finalUrl) => {
    respondWith({ finalUrl })
    const result = await newPlugin().execute(context, { url: 'https://example.com/redirect' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.error).toBeDefined()
    expect(result.content).toBeUndefined()
    expect(result.title).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(kSecret)
  })

  test('the status of a private page behind a redirect is not reported', async () => {
    respondWith({ finalUrl: 'http://127.0.0.1:8090/admin', status: 403 })
    const result = await newPlugin().execute(context, { url: 'https://example.com/redirect' })
    expect(result).toEqual({ error: 'URLs of this machine or of a private network cannot be downloaded' })
  })

  test('a document behind a redirect to a private address is not extracted', async () => {
    respondWith({ finalUrl: 'http://192.168.1.10/report.pdf', contentType: 'application/pdf' })
    const result = await newPlugin().execute(context, { url: 'https://example.com/report' })
    expect(result.error).toBeDefined()
    expect(window.api.file.extractText).not.toHaveBeenCalled()
  })

})

describe('cancellation', () => {

  // like fetch: pending until the signal fires, then rejected with an AbortError
  const hangUntilAborted = () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    }))
  }

  test('the abort signal is given to fetch', async () => {
    const controller = new AbortController()
    await newPlugin().execute({ model: 'mock', abortSignal: controller.signal }, { url: 'https://example.com/' })
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/', { signal: controller.signal })
  })

  test('aborting a pending download ends it and reports a cancellation', async () => {
    hangUntilAborted()
    const controller = new AbortController()
    const pending = newPlugin().execute({ model: 'mock', abortSignal: controller.signal }, { url: 'https://example.com/slow' })
    controller.abort()
    expect(await pending).toEqual({ error: 'Operation cancelled' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('aborting ends the wait even when the download does not react to the signal', async () => {
    fetchMock.mockImplementation(() => new Promise(() => { /* never settles */ }))
    const controller = new AbortController()
    const pending = newPlugin().execute({ model: 'mock', abortSignal: controller.signal }, { url: 'https://example.com/slow' })
    controller.abort()
    expect(await pending).toEqual({ error: 'Operation cancelled' })
  })

  test('aborting while the body is read reports a cancellation', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html' },
      text: async () => {
        controller.abort()
        throw new DOMException('The operation was aborted.', 'AbortError')
      },
    }))
    const result = await newPlugin().execute({ model: 'mock', abortSignal: controller.signal }, { url: 'https://example.com/big' })
    expect(result).toEqual({ error: 'Operation cancelled' })
  })

  test('nothing is sent when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await newPlugin().execute({ model: 'mock', abortSignal: controller.signal }, { url: 'https://example.com/' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ error: 'Operation cancelled' })
  })

  test('a network error is still reported as such', async () => {
    const failure = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValue(failure)
    const controller = new AbortController()
    const result = await newPlugin().execute({ model: 'mock', abortSignal: controller.signal }, { url: 'https://example.invalid/' })
    expect(result).toEqual({ error: failure })
  })

})
