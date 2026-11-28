
import { vi, beforeAll, beforeEach, afterEach, expect, test } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { useWindowMock } from '@tests/mocks/window'
import { createI18nMock } from '@tests/mocks'
import { SearchState } from '@/renderer/screens/Chat.vue'
import { Block } from '@services/message_block_parser'
import { store } from '@services/store'
import MessageItemBodyBlock from '@components/MessageItemBodyBlock.vue'
import Dialog from '@renderer/utils/dialog'

const mermaidHooks = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}))

vi.mock('@services/i18n', async () => {
  return createI18nMock()
})

// stands for any child mounted with render(): reports its lifecycle
vi.mock('@components/MessageItemMermaidBlock.vue', async () => {
  const { defineComponent, h, onMounted, onUnmounted } = await import('vue')
  return {
    default: defineComponent({
      props: { src: { type: String, required: true } },
      setup(props) {
        onMounted(() => mermaidHooks.mounted(props.src.trim()))
        onUnmounted(() => mermaidHooks.unmounted(props.src.trim()))
        return () => h('div', { class: 'mermaid-stub' }, props.src)
      },
    })
  }
})

const mermaid = (graph: string) => `Here is a diagram:\n\n\`\`\`mermaid\n${graph}\n\`\`\`\n\nThat is the diagram.`
const textBlock = (content: string): Block => ({ type: 'text', content })

const searchState: SearchState = { filter: ref<string | null>(null), navigate: ref(0), localSearch: ref(false) }

const mountBlock = (block: Block): VueWrapper<any> => {
  return mount(MessageItemBodyBlock, {
    props: { block, transient: false },
    global: { provide: { searchState } },
  })
}

// mdRender defers the custom rendering to the next tick and then to a timer
const flushCustomRender = async () => {
  await nextTick()
  vi.advanceTimersByTime(150)
  await nextTick()
}

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('Mermaid block is mounted after the delay', async () => {
  const wrapper = mountBlock(textBlock(mermaid('graph TD\nA --> B')))
  expect(wrapper.find('pre.mermaid').text()).toContain('graph TD')
  expect(mermaidHooks.mounted).not.toHaveBeenCalled()

  await flushCustomRender()
  expect(mermaidHooks.mounted).toHaveBeenCalledTimes(1)
  expect(mermaidHooks.mounted).toHaveBeenLastCalledWith('graph TD\nA --> B')
  expect(wrapper.find('pre.mermaid .mermaid-stub').exists()).toBe(true)
  expect(mermaidHooks.unmounted).not.toHaveBeenCalled()
  wrapper.unmount()
})

test('Mermaid block is unmounted with the component', async () => {
  const wrapper = mountBlock(textBlock(mermaid('graph TD\nA --> B')))
  await flushCustomRender()
  expect(mermaidHooks.mounted).toHaveBeenCalledTimes(1)
  const container = wrapper.find('pre.mermaid').element

  // the hooks of the child run with the next scheduler flush
  wrapper.unmount()
  expect(container.querySelector('.mermaid-stub')).toBeNull()
  await nextTick()
  expect(mermaidHooks.unmounted).toHaveBeenCalledTimes(1)
  expect(mermaidHooks.unmounted).toHaveBeenLastCalledWith('graph TD\nA --> B')

  // and nothing is rendered again later
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(1000)
  await nextTick()
  expect(mermaidHooks.mounted).toHaveBeenCalledTimes(1)
  expect(mermaidHooks.unmounted).toHaveBeenCalledTimes(1)
})

test('Error icon is unmounted with the component', async () => {
  const wrapper = mountBlock(textBlock('Something failed <error>Boom</error>'))
  await flushCustomRender()
  const placeholder = wrapper.find<HTMLElement>('.error-icon-placeholder').element
  expect(placeholder.querySelector('svg')).not.toBeNull()

  // the rendered icon is live
  await wrapper.find('.error-icon-placeholder span').trigger('click')
  expect(Dialog.show).toHaveBeenCalledWith({ title: 'chat.error.title', text: 'Boom' })

  wrapper.unmount()
  expect(placeholder.querySelector('svg')).toBeNull()
  expect(placeholder.children.length).toBe(0)
})

test('Pending custom render is cancelled on unmount', async () => {
  const wrapper = mountBlock(textBlock(mermaid('graph TD\nA --> B')))
  await nextTick()
  expect(vi.getTimerCount()).toBe(1)

  wrapper.unmount()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(1000)
  await nextTick()
  expect(mermaidHooks.mounted).not.toHaveBeenCalled()
})

test('Custom render is not scheduled when unmounted before the next tick', async () => {
  const wrapper = mountBlock(textBlock(mermaid('graph TD\nA --> B')))
  wrapper.unmount()

  await nextTick()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(1000)
  await nextTick()
  expect(mermaidHooks.mounted).not.toHaveBeenCalled()
})

test('Replaced content unmounts the blocks it contained', async () => {
  const wrapper = mountBlock(textBlock(mermaid('graph TD\nA --> B')))
  await flushCustomRender()
  expect(mermaidHooks.mounted).toHaveBeenCalledTimes(1)
  const container = wrapper.find('pre.mermaid').element

  // new content: v-html drops the previous container
  await wrapper.setProps({ block: textBlock(mermaid('graph LR\nC --> D')) })
  expect(wrapper.find('pre.mermaid').element).not.toBe(container)
  expect(mermaidHooks.unmounted).toHaveBeenCalledTimes(1)
  expect(mermaidHooks.unmounted).toHaveBeenLastCalledWith('graph TD\nA --> B')

  // the new block is rendered in turn
  await flushCustomRender()
  expect(mermaidHooks.mounted).toHaveBeenCalledTimes(2)
  expect(mermaidHooks.mounted).toHaveBeenLastCalledWith('graph LR\nC --> D')

  wrapper.unmount()
  await nextTick()
  expect(mermaidHooks.unmounted).toHaveBeenCalledTimes(2)
  expect(mermaidHooks.unmounted).toHaveBeenLastCalledWith('graph LR\nC --> D')
})

test('Re-render with the same content keeps the mounted blocks', async () => {
  const content = mermaid('graph TD\nA --> B')
  const wrapper = mountBlock(textBlock(content))
  await flushCustomRender()
  const stub = wrapper.find('pre.mermaid .mermaid-stub').element

  // same html: v-html does not touch the DOM
  await wrapper.setProps({ block: textBlock(content) })
  expect(mermaidHooks.unmounted).not.toHaveBeenCalled()
  expect(wrapper.find('pre.mermaid .mermaid-stub').element).toBe(stub)

  wrapper.unmount()
  await nextTick()
  expect(mermaidHooks.unmounted).toHaveBeenCalledTimes(1)
})

test('Switching to another block type unmounts the blocks', async () => {
  const wrapper = mountBlock(textBlock(mermaid('graph TD\nA --> B')))
  await flushCustomRender()
  expect(mermaidHooks.mounted).toHaveBeenCalledTimes(1)

  await wrapper.setProps({ block: { type: 'empty' } })
  expect(wrapper.find('.empty').exists()).toBe(true)
  expect(mermaidHooks.unmounted).toHaveBeenCalledTimes(1)
})
