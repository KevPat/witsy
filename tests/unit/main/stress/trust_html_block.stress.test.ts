
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableAutoUnmount, mount, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import MessageItemBody from '@components/MessageItemBody.vue'
import MessageItemHtmlBlock from '@components/MessageItemHtmlBlock.vue'
import Message from '@models/message'
import { withChatCallbacks } from '@root/vitest.setup'
import { computeBlocks } from '@services/message_block_parser'
import { store } from '@services/store'
import { useWindowMock } from '@tests/mocks/window'
import { bug } from './bug'

// An assistant message can contain <artifact>...html...</artifact>. The page is written by the
// model, so by whoever controls what the model has read, and it is previewed in an iframe inside
// the chat window without a click. The chat window has the preload api (files, shell, python),
// so the frame must not be able to reach its parent. jsdom does not run the scripts of the frame:
// these tests only look at the attributes that decide what a real browser would allow.

enableAutoUnmount(afterEach)

const kPayload = '<script>parent.api.file.delete(\'/home/user/.ssh/id_rsa\')</script>'
const kPage = `<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n</head>\n<body>\n<h1>Quarterly report</h1>\n${kPayload}\n</body>\n</html>`

const kContents: [string, string][] = [
  ['an html fence', `\`\`\`html\n${kPage}\n\`\`\``],
  ['a plain fence', `\`\`\`\n${kPage}\n\`\`\``],
  ['a bare page', kPage],
  ['a page without doctype', `<html><body>${kPayload}</body></html>`],
]

const kArtifacts = kContents.map(([name, content]): [string, string] => [name, `<artifact title="Report">${content}</artifact>`])

const sandboxTokens = (wrapper: VueWrapper<any>): string[] | null => {
  const sandbox = wrapper.find('iframe').attributes('sandbox')
  return sandbox === undefined ? null : sandbox.toLowerCase().split(/\s+/).filter(Boolean)
}

const mountBlock = async (content: string, transient = false): Promise<VueWrapper<any>> => {
  const wrapper = mount(MessageItemHtmlBlock, withChatCallbacks({ props: { title: 'Report', content, transient } }))
  await nextTick()
  return wrapper
}

const mountMessage = async (content: string): Promise<VueWrapper<any>> => {
  const message = new Message('assistant', content)
  const wrapper = mount(MessageItemBody, withChatCallbacks({ props: { message, toolCallsDisplay: 'none' } }))
  await nextTick()
  return wrapper
}

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  store.config.appearance.chat.autoPreview.html = true
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('html artifacts: how they reach the preview', () => {

  test.each(kArtifacts)('%s in an assistant message becomes an html block', (_, content) => {
    const blocks = computeBlocks(`Here you go:\n\n${content}\n\nDone.`, { role: 'assistant', transient: false, toolCalls: [], toolCallsDisplay: 'none' })
    const html = blocks.filter((block) => block.type === 'html')
    expect(html).toHaveLength(1)
    expect(html[0]).toMatchObject({ title: 'Report' })
    expect((html[0] as any).content).toContain(kPayload)
  })

  test('an artifact that is not html is not previewed', () => {
    const blocks = computeBlocks('<artifact title="Notes">```md\n# Notes\n<script>alert(1)</script>\n```</artifact>', { role: 'assistant', transient: false, toolCalls: [], toolCallsDisplay: 'none' })
    expect(blocks.map((block) => block.type)).toEqual(['artifact'])
  })

  test('a user message never becomes an html block', () => {
    const blocks = computeBlocks(kArtifacts[0][1], { role: 'user', transient: false, toolCalls: [], toolCallsDisplay: 'none' })
    expect(blocks.some((block) => block.type === 'html')).toBe(false)
  })

  test('the preview is on by default and needs no click', async () => {
    expect(store.config.appearance.chat.autoPreview.html).toBe(true)
    const wrapper = await mountMessage(`Here you go:\n\n${kArtifacts[0][1]}`)
    const iframe = wrapper.find('iframe')
    expect(iframe.exists()).toBe(true)
    expect(iframe.attributes('srcdoc')).toContain(kPayload)
  })

  test('the page is passed with srcdoc and never with src', async () => {
    const wrapper = await mountBlock(kContents[0][1])
    const iframe = wrapper.find('iframe')
    expect(iframe.attributes('srcdoc')).toContain('<h1>Quarterly report</h1>')
    expect(iframe.attributes('src')).toBeUndefined()
  })

  test('the user can switch the preview off and sees the source as text', async () => {
    const wrapper = await mountBlock(kContents[0][1])
    await wrapper.find('.preview').trigger('click')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('.panel-body script').exists()).toBe(false)
    expect(wrapper.find('.panel-body').text()).toContain('parent.api.file.delete')
  })

  test('no frame is created when the preview is disabled in the settings', async () => {
    store.config.appearance.chat.autoPreview.html = false
    const wrapper = await mountMessage(kArtifacts[0][1])
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
  })

})

describe('html artifacts: the sandbox of the preview', () => {

  test('the frame is sandboxed', async () => {
    const wrapper = await mountBlock(kContents[0][1])
    expect(sandboxTokens(wrapper)).not.toBeNull()
  })

  test.each([
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-top-navigation-to-custom-protocols',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-modals',
    'allow-downloads',
    'allow-pointer-lock',
  ])('the sandbox does not grant %s', async (token) => {
    const wrapper = await mountBlock(kContents[0][1])
    expect(sandboxTokens(wrapper)).not.toContain(token)
  })

  bug('the sandbox does not combine allow-scripts with allow-same-origin', async () => {
    // sandbox="allow-scripts allow-same-origin allow-forms": a srcdoc frame takes the origin of the
    // chat window, so its scripts can call parent.api or simply remove the sandbox attribute
    const wrapper = await mountBlock(kContents[0][1])
    const tokens = sandboxTokens(wrapper)
    expect(tokens).not.toBeNull()
    expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin'), `sandbox="${tokens.join(' ')}"`).toBe(false)
  })

  bug.each(kArtifacts)('%s in an assistant message is previewed in a frame that cannot reach the chat window', async (_, content) => {
    // same attribute, reached from a message without any interaction
    const wrapper = await mountMessage(`Here you go:\n\n${content}`)
    const tokens = sandboxTokens(wrapper)
    expect(tokens).not.toBeNull()
    expect(wrapper.find('iframe').attributes('srcdoc')).toContain(kPayload)
    expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin'), `sandbox="${tokens.join(' ')}"`).toBe(false)
  })

  bug('the frame of a message that is still streaming has the same restriction', async () => {
    // the frame appears as soon as </head> has been received, with the same sandbox attribute
    const wrapper = await mountBlock('```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n```', true)
    expect(wrapper.find('iframe').exists()).toBe(false)
    await wrapper.setProps({ content: `\`\`\`html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Report</title>\n</head>\n<body>\n${kPayload}\n\`\`\`` })
    expect(wrapper.find('iframe').exists()).toBe(true)
    const tokens = sandboxTokens(wrapper)
    expect(tokens).not.toBeNull()
    expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin'), `sandbox="${tokens.join(' ')}"`).toBe(false)
  })

})
