
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, VueWrapper } from '@vue/test-utils'
import { JSDOM } from 'jsdom'
import { nextTick } from 'vue'
import MessageItemHtmlBlock from '@components/MessageItemHtmlBlock.vue'
import { withChatCallbacks } from '@root/vitest.setup'
import { store } from '@services/store'
import { stubTeleport } from '@tests/mocks/stubs'
import { useWindowMock } from '@tests/mocks/window'

// The preview frame has no allow-same-origin: the app cannot read the document of the artifact
// and only talks to it with messages. The first part checks what the app does with the messages
// it receives, the second part runs the script injected in the artifact in a window of its own.

enableAutoUnmount(afterEach)

const kPage = '<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n</head>\n<body>\n<h1>Quarterly report</h1>\n<script>document.body.dataset.ran = "yes"</script>\n</body>\n</html>'
const kContent = `\`\`\`html\n${kPage}\n\`\`\``

const mountBlock = async (content = kContent, transient = false): Promise<VueWrapper<any>> => {
  const wrapper = mount(MessageItemHtmlBlock, withChatCallbacks({ ...stubTeleport, attachTo: document.body, props: { title: 'Report', content, transient } }))
  await nextTick()
  return wrapper
}

const frameOf = (wrapper: VueWrapper<any>): HTMLIFrameElement => wrapper.find('iframe').element as HTMLIFrameElement

const idOf = (wrapper: VueWrapper<any>): string => wrapper.find('iframe').attributes('srcdoc').match(/const id = '([^']+)'/)[1]

const send = async (source: Window | null, data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data, source }))
  await flushPromises()
}

const askForPdf = async (wrapper: VueWrapper<any>) => {
  await wrapper.find('.download .trigger').trigger('click')
  await nextTick()
  const items = wrapper.findAll('.context-menu .item')
  await items.find((item) => item.text() === 'PDF').trigger('click')
  await flushPromises()
}

const printedHtml = (): string => vi.mocked(window.api.app.printToPdf).mock.calls[0][0]

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  store.config.appearance.chat.autoPreview.html = true
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  expect((window as any).pwned).toBeUndefined()
})

describe('html preview: the frame', () => {

  test('scripts run in the frame but not in the origin of the app', async () => {
    const wrapper = await mountBlock()
    expect(wrapper.find('iframe').attributes('sandbox').split(/\s+/).sort()).toEqual(['allow-forms', 'allow-scripts'])
    expect(wrapper.find('iframe').attributes('srcdoc')).toContain('<script>document.body.dataset.ran = "yes"</script>')
  })

  test('the frame of a streaming message has the same sandbox', async () => {
    const wrapper = await mountBlock('```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n```', true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    await wrapper.setProps({ content: '```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n</head>\n<body>\n<h1>Quarter\n```' })
    expect(wrapper.find('iframe').attributes('sandbox').split(/\s+/).sort()).toEqual(['allow-forms', 'allow-scripts'])
    expect(wrapper.find('iframe').attributes('srcdoc')).toContain('witsy-artifact-height')
  })

  test('each preview has its own channel id', async () => {
    const first = await mountBlock()
    const second = await mountBlock()
    expect(idOf(first)).toMatch(/^[0-9a-f-]{36}$/)
    expect(idOf(first)).not.toBe(idOf(second))
  })

  test.each([
    ['a page without head', '<!DOCTYPE html>\n<html><body><p>Hello</p></body></html>', /^<!DOCTYPE html>\s*<html>\s*<script data-witsy-bridge>/],
    ['a page without doctype', '<html lang="en"><body><p>Hello</p></body></html>', /^<html lang="en">\s*<script data-witsy-bridge>/],
    ['a page with an uppercase head', '<!DOCTYPE html>\n<HTML><HEAD><TITLE>T</TITLE></HEAD><BODY><p>Hello</p></BODY></HTML>', /<TITLE>T<\/TITLE>\s*<script data-witsy-bridge>[^]*<\/script>\s*<\/HEAD>/],
  ])('%s gets the channel script without losing its doctype', async (_, page, expected) => {
    const wrapper = await mountBlock(page)
    const srcdoc = wrapper.find('iframe').attributes('srcdoc')
    expect(srcdoc).toMatch(expected)
    expect(srcdoc).toContain('<p>Hello</p>')
  })

})

describe('html preview: the height reported by the frame', () => {

  test('a report of the frame sets its height', async () => {
    const wrapper = await mountBlock()
    const iframe = frameOf(wrapper)
    await send(iframe.contentWindow, { type: 'witsy-artifact-height', id: idOf(wrapper), height: 432 })
    expect(iframe.style.height).toBe('432px')
    await send(iframe.contentWindow, { type: 'witsy-artifact-height', id: idOf(wrapper), height: 120.4 })
    expect(iframe.style.height).toBe('121px')
  })

  test('a report coming from another window is ignored', async () => {
    const wrapper = await mountBlock()
    const other = await mountBlock()
    const iframe = frameOf(wrapper)
    const message = { type: 'witsy-artifact-height', id: idOf(wrapper), height: 432 }
    await send(window, message)
    await send(null, message)
    await send(frameOf(other).contentWindow, message)
    expect(iframe.style.height).toBe('')
    expect(frameOf(other).style.height).toBe('')
  })

  test.each([
    ['another id', (id: string) => ({ type: 'witsy-artifact-height', id: id.replace(/.$/, 'x'), height: 432 })],
    ['no id', () => ({ type: 'witsy-artifact-height', height: 432 })],
    ['another type', (id: string) => ({ type: 'height', id, height: 432 })],
    ['a height that is a string', (id: string) => ({ type: 'witsy-artifact-height', id, height: '432' })],
    ['a height that is css', (id: string) => ({ type: 'witsy-artifact-height', id, height: '100vh; position: fixed' })],
    ['a height that is not a number', (id: string) => ({ type: 'witsy-artifact-height', id, height: NaN })],
    ['an infinite height', (id: string) => ({ type: 'witsy-artifact-height', id, height: Infinity })],
    ['a height of zero', (id: string) => ({ type: 'witsy-artifact-height', id, height: 0 })],
    ['a negative height', (id: string) => ({ type: 'witsy-artifact-height', id, height: -50 })],
    ['a height that is an object', (id: string) => ({ type: 'witsy-artifact-height', id, height: { valueOf: () => 432 } })],
    ['a string', () => 'witsy-artifact-height'],
    ['nothing', (): null => null],
  ])('a report with %s is ignored', async (_, build) => {
    const wrapper = await mountBlock()
    const iframe = frameOf(wrapper)
    await send(iframe.contentWindow, build(idOf(wrapper)))
    expect(iframe.style.height).toBe('')
  })

  test('a page cannot make its frame taller than the limit', async () => {
    const wrapper = await mountBlock()
    const iframe = frameOf(wrapper)
    await send(iframe.contentWindow, { type: 'witsy-artifact-height', id: idOf(wrapper), height: 1e12 })
    expect(iframe.style.height).toBe('20000px')
  })

  test('reports are not listened to once the preview is gone', async () => {
    const wrapper = await mountBlock()
    const iframe = frameOf(wrapper)
    const source = iframe.contentWindow
    const id = idOf(wrapper)
    const removed = vi.spyOn(window, 'removeEventListener')
    wrapper.unmount()
    expect(removed.mock.calls.some(([event]) => event === 'message')).toBe(true)
    await send(source, { type: 'witsy-artifact-height', id, height: 432 })
    expect(iframe.style.height).toBe('')
    removed.mockRestore()
  })

  test('the body of a streaming page is sent to the frame', async () => {
    const wrapper = await mountBlock('```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n```', true)
    await wrapper.setProps({ content: '```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n</head>\n<body>\n<h1>Quarter\n```' })
    const posted = vi.spyOn(frameOf(wrapper).contentWindow, 'postMessage')
    await wrapper.setProps({ content: '```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n</head>\n<body>\n<h1>Quarterly report</h1>\n```' })
    expect(posted).toHaveBeenLastCalledWith({ type: 'update', body: '\n<h1>Quarterly report</h1>' }, '*')
  })

})

describe('html preview: pdf export', () => {

  const kSnapshot = '<html><head><title>Report</title><script data-witsy-bridge>window.pwned = 1</script></head>'
    + '<body><h1>Quarterly report</h1><p id="rendered">rendered by the page</p>'
    + '<img src="x" onerror="window.pwned = 1"><script>window.pwned = 1</script></body></html>'

  test('the frame is asked for its document and the answer is exported', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBlock()
    const iframe = frameOf(wrapper)
    const posted = vi.spyOn(iframe.contentWindow, 'postMessage')
    await askForPdf(wrapper)
    expect(posted).toHaveBeenCalledWith({ type: 'witsy-artifact-snapshot-request', id: idOf(wrapper) }, '*')
    expect(window.api.app.printToPdf).not.toHaveBeenCalled()

    await send(iframe.contentWindow, { type: 'witsy-artifact-snapshot', id: idOf(wrapper), html: kSnapshot })
    expect(window.api.app.printToPdf).toHaveBeenCalledOnce()
    expect(printedHtml()).toContain('<p id="rendered">rendered by the page</p>')
    expect(printedHtml()).not.toContain('data-witsy-bridge')
    expect(window.api.file.save).toHaveBeenCalledWith({ contents: 'JVBERi0xLjQK', properties: { filename: 'Report.pdf', prompt: true } })

    // the answer was parsed, never inserted in the document of the app
    expect(document.querySelector('#rendered')).toBeNull()

    // nothing more happens when the timeout of the request passes
    await vi.advanceTimersByTimeAsync(5000)
    expect(window.api.app.printToPdf).toHaveBeenCalledOnce()
  })

  test('the source of the page is exported when the frame does not answer', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBlock()
    await askForPdf(wrapper)
    await vi.advanceTimersByTimeAsync(1900)
    expect(window.api.app.printToPdf).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(window.api.app.printToPdf).toHaveBeenCalledOnce()
    expect(printedHtml()).toContain('<h1>Quarterly report</h1>')
    expect(printedHtml()).not.toContain('data-witsy-bridge')
    expect(window.api.file.save).toHaveBeenCalledOnce()
  })

  test.each([
    ['another window', (id: string) => ({ type: 'witsy-artifact-snapshot', id, html: kSnapshot }), false],
    ['another id', (id: string) => ({ type: 'witsy-artifact-snapshot', id: id.replace(/.$/, 'x'), html: kSnapshot }), true],
    ['a document that is not a string', (id: string) => ({ type: 'witsy-artifact-snapshot', id, html: { toString: () => kSnapshot } }), true],
    ['a document that is too large', (id: string) => ({ type: 'witsy-artifact-snapshot', id, html: '<p id="rendered">' + 'x'.repeat(20 * 1024 * 1024) }), true],
  ])('an answer with %s is ignored and the source is exported', async (_, build, fromFrame) => {
    vi.useFakeTimers()
    const wrapper = await mountBlock()
    await askForPdf(wrapper)
    await send(fromFrame ? frameOf(wrapper).contentWindow : window, build(idOf(wrapper)))
    expect(window.api.app.printToPdf).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(window.api.app.printToPdf).toHaveBeenCalledOnce()
    expect(printedHtml()).toContain('<h1>Quarterly report</h1>')
    expect(printedHtml()).not.toContain('id="rendered"')
  })

  test('an answer nobody asked for exports nothing', async () => {
    const wrapper = await mountBlock()
    await send(frameOf(wrapper).contentWindow, { type: 'witsy-artifact-snapshot', id: idOf(wrapper), html: kSnapshot })
    expect(window.api.app.printToPdf).not.toHaveBeenCalled()
    expect(window.api.file.save).not.toHaveBeenCalled()
  })

  test('two requests in a row share one question to the frame', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBlock()
    const iframe = frameOf(wrapper)
    const posted = vi.spyOn(iframe.contentWindow, 'postMessage')
    await askForPdf(wrapper)
    await askForPdf(wrapper)
    expect(posted).toHaveBeenCalledOnce()
    await send(iframe.contentWindow, { type: 'witsy-artifact-snapshot', id: idOf(wrapper), html: kSnapshot })
    expect(window.api.app.printToPdf).toHaveBeenCalledTimes(2)
  })

})

describe('html preview: the script injected in the page', () => {

  // the page as the frame gets it, loaded in a window of its own with scripts enabled.
  // That window is its own parent, so what the script posts to its parent is caught here.
  const loadPage = async (content = kContent, height = 432) => {
    const wrapper = await mountBlock(content)
    const posted = vi.fn()
    const dom = new JSDOM(wrapper.find('iframe').attributes('srcdoc'), {
      runScripts: 'dangerously',
      beforeParse: (frame) => {
        frame.postMessage = posted
        Object.defineProperty(frame.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height })
      },
    })
    await vi.waitFor(() => expect(dom.window.document.readyState).toBe('complete'))
    const receive = (data: unknown, source: unknown = dom.window) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: source as any }))
    }
    return { id: idOf(wrapper), dom, posted, receive }
  }

  test('the page reports its height when it is loaded', async () => {
    const { id, dom, posted } = await loadPage()
    expect(dom.window.document.body.dataset.ran).toBe('yes')
    await vi.waitFor(() => expect(posted).toHaveBeenCalledWith({ type: 'witsy-artifact-height', id, height: 432 }, '*'))
    dom.window.close()
  })

  test('the page answers its parent with its document', async () => {
    const { id, dom, posted, receive } = await loadPage()
    dom.window.document.body.insertAdjacentHTML('beforeend', '<p id="rendered">rendered by the page</p>')
    posted.mockClear()
    receive({ type: 'witsy-artifact-snapshot-request', id })
    expect(posted).toHaveBeenCalledOnce()
    const [answer, target] = posted.mock.calls[0]
    expect(target).toBe('*')
    expect(answer).toMatchObject({ type: 'witsy-artifact-snapshot', id })
    expect(answer.html).toMatch(/^<html>/)
    expect(answer.html).toContain('<h1>Quarterly report</h1>')
    expect(answer.html).toContain('<p id="rendered">rendered by the page</p>')
    dom.window.close()
  })

  test('the page does not answer a request with another id', async () => {
    const { dom, posted, receive } = await loadPage()
    posted.mockClear()
    receive({ type: 'witsy-artifact-snapshot-request', id: 'another' })
    receive(null)
    expect(posted).not.toHaveBeenCalled()
    dom.window.close()
  })

  test('the page takes a new body from its parent and reports its height', async () => {
    const { id, dom, posted, receive } = await loadPage()
    posted.mockClear()
    receive({ type: 'update', body: '<h1>Quarterly report</h1><p>More</p>' })
    expect(dom.window.document.body.innerHTML).toBe('<h1>Quarterly report</h1><p>More</p>')
    expect(posted).toHaveBeenCalledWith({ type: 'witsy-artifact-height', id, height: 432 }, '*')
    dom.window.close()
  })

  test('the page ignores what does not come from its parent', async () => {
    const { id, dom, posted, receive } = await loadPage()
    const other = new JSDOM('')
    const body = dom.window.document.body.innerHTML
    posted.mockClear()
    for (const source of [other.window, null]) {
      receive({ type: 'update', body: '<h1>Forged</h1>' }, source)
      receive({ type: 'witsy-artifact-snapshot-request', id }, source)
    }
    expect(dom.window.document.body.innerHTML).toBe(body)
    expect(posted).not.toHaveBeenCalled()
    other.window.close()
    dom.window.close()
  })

})
