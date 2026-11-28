
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import mermaid from 'mermaid'
import { useWindowMock } from '@tests/mocks/window'
import { createI18nMock } from '@tests/mocks'
import MessageItemBodyBlock from '@components/MessageItemBodyBlock.vue'

vi.mock('@services/i18n', async () => {
  return createI18nMock()
})

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg class="rendered"></svg>' })),
  }
}))

enableAutoUnmount(afterEach)

beforeAll(() => {
  useWindowMock()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const mountBlock = async (content: string) => {
  const wrapper = mount(MessageItemBodyBlock, {
    props: { block: { type: 'text', content, start: 0, end: content.length, stable: true }, transient: false },
  })
  await nextTick()
  return wrapper
}

const renderDiagrams = async () => {
  await vi.advanceTimersByTimeAsync(200)
  await nextTick()
}

test('Mermaid receives the diagram source as it was written', async () => {
  const source = 'graph TD\n  A --> B\n  B["x < y"] -->|"a & b > c"| C["<b>bold</b> &amp; done"]'
  const wrapper = await mountBlock(`Here is a diagram:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nDone.`)
  await renderDiagrams()
  expect(mermaid.render).toHaveBeenCalledTimes(1)
  expect(vi.mocked(mermaid.render).mock.calls[0][1]).toBe(`${source}\n`)
  expect(wrapper.find('pre.mermaid svg.rendered').exists()).toBe(true)
})

test('Markup in a mermaid fence never becomes an element', async () => {
  const source = 'graph TD\n<img src=x onerror=alert(1)>\n</pre><img src=y onerror=alert(2)><script>alert(3)</script>'
  const wrapper = await mountBlock(`\`\`\`mermaid\n${source}\n\`\`\``)
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('script').exists()).toBe(false)
  expect(wrapper.find('pre.mermaid').element.children).toHaveLength(0)
  await renderDiagrams()
  expect(vi.mocked(mermaid.render).mock.calls[0][1]).toBe(`${source}\n`)
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('script').exists()).toBe(false)
})
