
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { PluginExecutionContext } from 'multi-llm-ts'
import Dialog from '@renderer/utils/dialog'
import Browse from '@services/plugins/browse'
import { useWindowMock } from '@tests/mocks/window'
import { bug } from './bug'

// The browse plugin downloads the url the model gives it and returns the text to the model. The
// url comes from the conversation, so from whatever the model has read. It runs in the renderer,
// which is created with webSecurity: false: no same-origin policy and no CORS stand between it
// and the services of the user's machine or network. fetch is replaced by a recorder that answers
// with a page containing a marker; nothing leaves the test.

const kSecret = 'TOKEN-5f2a9c'
const kPage = `<html><head><title>Internal admin</title></head><body><h1>Settings</h1><p>api key: ${kSecret}</p></body></html>`

const kPublicUrls: [string, string][] = [
  ['an https page', 'https://example.com/article'],
  ['an http page', 'http://example.com/article'],
  ['an https page with a port and a query', 'https://docs.example.com:8443/search?q=witsy#results'],
  ['a public address', 'https://93.184.216.34/'],
]

const kPrivateUrls: [string, string][] = [
  ['the loopback address', 'http://127.0.0.1:8080/admin'],
  ['localhost', 'http://localhost:11434/api/tags'],
  ['localhost with a trailing dot', 'http://localhost.:3000/'],
  ['a name under localhost', 'http://app.localhost:3000/'],
  ['the loopback address in short form', 'http://127.1/'],
  ['the loopback address as a number', 'http://2130706433/'],
  ['the loopback address in hexadecimal', 'http://0x7f.0.0.1/'],
  ['another loopback address', 'http://127.8.9.10/'],
  ['the ipv6 loopback address', 'http://[::1]:8080/'],
  ['an ipv4-mapped ipv6 loopback address', 'http://[::ffff:127.0.0.1]/'],
  ['the unspecified address', 'http://0.0.0.0:8090/'],
  ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
  ['a 10.x address', 'http://10.0.0.5/'],
  ['a 172.16.x address', 'http://172.16.4.1/'],
  ['a 192.168.x address', 'http://192.168.1.1/cgi-bin/config'],
  ['a carrier-grade nat address', 'http://100.64.0.1/'],
  ['an ipv6 unique local address', 'http://[fd00::1]/'],
  ['an ipv6 link-local address', 'http://[fe80::1]/'],
  ['a private address over https', 'https://192.168.1.1/'],
  ['a private address with credentials', 'http://admin:admin@192.168.1.1/'],
]

const kLocalUrls: [string, string][] = [
  ['a local file', 'file:///etc/passwd'],
  ['a local file on windows', 'file:///C:/Users/user/.ssh/id_rsa'],
  ['a file on a share', 'file://fileserver/share/payroll.xlsx'],
  ['a file url in upper case', 'FILE:///etc/passwd'],
]

const context: PluginExecutionContext = { model: 'mock' }

const fetchMock = vi.fn()

const respondWith = (body: string, contentType = 'text/html; charset=utf-8', status = 200) => {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url,
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
  respondWith(kPage)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browse plugin: public pages', () => {

  test.each(kPublicUrls)('%s is downloaded once and returned as text', async (_, url) => {
    const result = await newPlugin().execute(context, { url })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(url)
    expect(result.error).toBeUndefined()
    expect(result.title).toBe('Internal admin')
    expect(result.content).toContain('SETTINGS')
    expect(result.content).not.toContain('<h1>')
  })

  test('a failed download is reported and nothing of the page is returned', async () => {
    respondWith(kPage, 'text/html', 403)
    const result = await newPlugin().execute(context, { url: 'https://example.com/private' })
    expect(result.error).toBe('Failed to fetch URL: 403 Error')
    expect(JSON.stringify(result)).not.toContain(kSecret)
  })

  test('a network error is reported', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('getaddrinfo ENOTFOUND example.invalid') })
    const result = await newPlugin().execute(context, { url: 'https://example.invalid/' })
    expect(result.error).toBeInstanceOf(Error)
    expect(result.content).toBeUndefined()
  })

  test('something that is not a url is reported', async () => {
    fetchMock.mockImplementation(async (url: string) => { new URL(url); return null })
    const result = await newPlugin().execute(context, { url: 'not a url' })
    expect(result.error).toBeDefined()
    expect(result.content).toBeUndefined()
  })

  test('only the parts around the search term are returned when a search is given', async () => {
    respondWith(`intro ${'a'.repeat(500)} needle ${'b'.repeat(500)} outro`, 'text/plain')
    const result = await newPlugin().execute(context, { url: 'https://example.com/long.txt', search: 'needle', chunkLength: 10 })
    expect(result.title).toBe('example.com')
    expect(result.content).toContain('needle')
    expect(result.content.length).toBeLessThan(60)
  })

  test('the user is never asked before a page is downloaded', async () => {
    await newPlugin().execute(context, { url: 'https://example.com/article' })
    expect(Dialog.show).not.toHaveBeenCalled()
    expect(Dialog.alert).not.toHaveBeenCalled()
  })

})

describe('browse plugin: the machine and the network of the user', () => {

  bug.each(kPrivateUrls)('%s is not downloaded', async (_, url) => {
    // execute calls fetch(parameters.url) without looking at the host
    const result = await newPlugin().execute(context, { url })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  bug('the page of a service on the machine does not reach the model', async () => {
    // same defect, seen from the result: the page of the internal service is returned as tool output
    const result = await newPlugin().execute(context, { url: kPrivateUrls[0][1] })
    expect(JSON.stringify(result)).not.toContain(kSecret)
  })

  bug.each(kLocalUrls)('%s is not downloaded', async (_, url) => {
    // execute calls fetch(parameters.url) without looking at the scheme
    respondWith(`root:x:0:0:${kSecret}`, 'text/plain')
    const result = await newPlugin().execute(context, { url })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
    expect(JSON.stringify(result)).not.toContain(kSecret)
  })

  bug('the page behind a redirect to the machine of the user does not reach the model', async () => {
    // fetch is called without options and the final url is never looked at: a public page can bounce to a private one
    fetchMock.mockImplementation(async (url: string, options?: { redirect?: string }) => {
      if (options?.redirect === 'error') throw new TypeError('Failed to fetch')
      if (options?.redirect === 'manual') return { ok: false, status: 0, statusText: '', type: 'opaqueredirect', url, redirected: false, headers: { get: (): string | null => null }, text: async () => '' }
      return { ok: true, status: 200, statusText: 'OK', type: 'basic', url: 'http://127.0.0.1:8080/admin', redirected: true, headers: { get: () => 'text/html' }, text: async () => kPage }
    })
    const result = await newPlugin().execute(context, { url: 'https://example.com/redirect' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain(kSecret)
  })

})
