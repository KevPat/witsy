
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableAutoUnmount, mount, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { useWindowMock } from '@tests/mocks/window'
import { createI18nMock } from '@tests/mocks'
import { stubTeleport } from '@tests/mocks/stubs'
import { withChatCallbacks } from '@root/vitest.setup'
import { store } from '@services/store'
import { Agent, AgentRun } from '@/types/agents'
import MessageItem from '@components/MessageItem.vue'
import Chat from '@models/chat'
import Message from '@models/message'
import RunInfo from '@renderer/agent/RunInfo.vue'

// A link in text written by a model must never replace the page of the window it is shown in:
// the page that replaces it would get the preload api. The main process cancels such a navigation
// (see trust_windows); in the page, links carry target=_blank, which sends them to the window-open
// handler. The markdown renderer sets that attribute, a timer in MessageItem sets it again, and
// the output of an agent run, rendered without MessageItem, sets it on click.

vi.mock('@services/i18n', async () => {
  return createI18nMock()
})

vi.mock('@renderer/audio/audio_player', async () => {
  return { default: () => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    play: vi.fn(),
  })}
})

enableAutoUnmount(afterEach)

const kLinks: [string, string, string][] = [
  ['an inline link', 'Read the [report](https://evil.example/report) now.', 'https://evil.example/report'],
  ['an autolink', 'See <https://evil.example/auto>.', 'https://evil.example/auto'],
  ['a reference link', 'Read the [report][1].\n\n[1]: https://evil.example/reference', 'https://evil.example/reference'],
  ['a link around an image', '[![logo](https://evil.example/logo.png)](https://evil.example/image)', 'https://evil.example/image'],
  ['a link in a table', '| a |\n|---|\n| [cell](https://evil.example/table) |', 'https://evil.example/table'],
  ['a link in a list', '- [item](https://evil.example/list)', 'https://evil.example/list'],
]

// what a click does: 'blank' asks for a new window (handled by the main process), 'cancelled' is
// stopped by the page, 'navigates' replaces the page. The click itself is always cancelled at the
// end so that jsdom never tries to load anything.
const clickOutcome = (link: HTMLAnchorElement): 'blank' | 'cancelled' | 'navigates' => {
  let cancelled = false
  const guard = (event: Event) => {
    cancelled = event.defaultPrevented
    event.preventDefault()
  }
  window.addEventListener('click', guard)
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  window.removeEventListener('click', guard)
  if (cancelled) return 'cancelled'
  return link.target === '_blank' ? 'blank' : 'navigates'
}

const linkTo = (wrapper: VueWrapper<any>, href: string): HTMLAnchorElement => {
  const link = Array.from(wrapper.element.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => a.getAttribute('href') === href)
  expect(link, `link to ${href}`).toBeDefined()
  return link
}

const mountMessage = async (content: string | Message): Promise<VueWrapper<any>> => {
  const chat = new Chat('links')
  chat.engine = 'openai'
  const message = typeof content === 'string' ? new Message('assistant', content) : content
  const options = withChatCallbacks({ ...stubTeleport, attachTo: document.body, props: { chat, message, readAloud: vi.fn() } })
  const wrapper = mount(MessageItem, options)
  await nextTick()
  return wrapper
}

const mountRun = async (content: string): Promise<VueWrapper<any>> => {
  const agent = {
    uuid: 'agent',
    name: 'Agent',
    description: '',
    prompt: 'You are a helpful assistant',
    engine: 'openai',
    model: 'gpt',
    parameters: {},
    steps: [{ description: 'Step 1', prompt: 'Summarize the page' }],
  } as unknown as Agent
  const user = new Message('user', 'Summarize https://evil.example/')
  const output = new Message('assistant', content)
  const run = {
    uuid: 'run',
    agentId: 'agent',
    createdAt: 1764201600000,
    updatedAt: 1764201605000,
    trigger: 'manual',
    status: 'success',
    prompt: 'Summarize https://evil.example/',
    messages: [new Message('system', 'System'), user, output],
  } as unknown as AgentRun
  const wrapper = mount(RunInfo, { attachTo: document.body, props: { agent, run } })
  await nextTick()
  return wrapper
}

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
  store.config.workspaceId = 'workspace'
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('links in a chat message', () => {

  test.each(kLinks)('%s opens a new window once the message has settled', async (_, content, href) => {
    const wrapper = await mountMessage(content)
    vi.advanceTimersByTime(500)
    const link = linkTo(wrapper, href)
    expect(link.target).toBe('_blank')
    expect(clickOutcome(link)).toBe('blank')
  })

  test('a link added while the message is streaming opens a new window after the next pass', async () => {
    const message = new Message('assistant', 'Loading')
    const wrapper = await mountMessage(message)
    vi.advanceTimersByTime(500)
    message.setText('Read the [report](https://evil.example/report) now.')
    await vi.advanceTimersByTimeAsync(600)
    expect(clickOutcome(linkTo(wrapper, 'https://evil.example/report'))).toBe('blank')
  })

  test.each(kLinks)('%s cannot replace the page from the moment it is shown', async (_, content, href) => {
    // target=_blank used to be added by a 500 ms setInterval in MessageItem only: until it had run, a click navigated the window
    const wrapper = await mountMessage(content)
    expect(clickOutcome(linkTo(wrapper, href))).not.toBe('navigates')
  })

})

describe('links in the output of an agent run', () => {

  test.each(kLinks)('%s is rendered as a link', async (_, content, href) => {
    const wrapper = await mountRun(content)
    expect(wrapper.find('.output-section').exists()).toBe(true)
    expect(linkTo(wrapper, href).closest('.output-content')).not.toBeNull()
  })

  test.each(kLinks)('%s cannot replace the page', async (_, content, href) => {
    const wrapper = await mountRun(content)
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(clickOutcome(linkTo(wrapper, href))).not.toBe('navigates')
  })

})
