
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { useWindowMock } from '@tests/mocks/window'
import { store } from '@services/store'
import RunInfo from '@renderer/agent/RunInfo.vue'
import Message from '@models/message'
import { Agent, AgentRun } from '@/types/agents'
import enMessages from '@root/locales/en.json'

beforeAll(async () => {
  useWindowMock()

  window.api.config.getI18nMessages = vi.fn(() => ({ en: enMessages }))

  const { initI18n } = await import('@services/i18n')
  initI18n()

  store.load()
  store.config.workspaceId = 'test-workspace'
})

const createMockAgent = (overrides: Partial<Agent> = {}): Agent => ({
  uuid: 'test-agent-456',
  name: 'Test Agent',
  description: 'A test agent',
  prompt: 'You are a helpful assistant',
  engine: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  parameters: {},
  steps: [
    { description: 'Step 1', prompt: 'Do step 1' },
    { description: 'Step 2', prompt: 'Do step 2' },
  ],
  ...overrides,
})

const createMockRun = (overrides: Partial<AgentRun> = {}): AgentRun => {
  const msg1 = new Message('system', 'System message')
  const msg2 = new Message('user', 'User message 1')
  msg2.engine = 'anthropic'
  msg2.model = 'claude-sonnet-4-20250514'
  const msg3 = new Message('assistant', 'Assistant response 1')
  msg3.engine = 'anthropic'
  msg3.model = 'claude-sonnet-4-20250514'

  return {
    uuid: 'test-run-123',
    agentId: 'test-agent-456',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
    trigger: 'manual',
    status: 'success',
    prompt: 'Test prompt',
    messages: [msg1, msg2, msg3],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RunInfo.vue', () => {
  test('renders status hero section', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun(),
      },
    })

    await nextTick()

    expect(wrapper.find('.status-hero').exists()).toBe(true)
    expect(wrapper.find('.status-icon').exists()).toBe(true)
    expect(wrapper.find('.status-info').exists()).toBe(true)
  })

  test('displays correct status for success run', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ status: 'success' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.status-hero.success').exists()).toBe(true)
  })

  test('displays correct status for error run', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ status: 'error', error: 'Test error message' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.status-hero.error').exists()).toBe(true)
    expect(wrapper.find('.error-alert').exists()).toBe(true)
    expect(wrapper.find('.error-message').text()).toBe('Test error message')
  })

  test('displays correct status for running run', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ status: 'running' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.status-hero.running').exists()).toBe(true)
  })

  test('displays stats grid with duration and trigger', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ trigger: 'manual' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.stats-grid').exists()).toBe(true)
    const statCards = wrapper.findAll('.stat-card')
    expect(statCards.length).toBe(2)
  })

  test('displays timeline with created and updated dates', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ status: 'success' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.timeline').exists()).toBe(true)
    const timelineItems = wrapper.findAll('.timeline-item')
    // start + 1 step + end = 3
    expect(timelineItems.length).toBe(3)
  })

  test('hides updated time for running runs', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ status: 'running' }),
      },
    })

    await nextTick()

    const timelineItems = wrapper.findAll('.timeline-item')
    // start + 1 step (no end for running) = 2
    expect(timelineItems.length).toBe(2)
  })

  test('displays model card when engine/model available', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun(),
      },
    })

    await nextTick()

    expect(wrapper.find('.model-card').exists()).toBe(true)
  })

  test('hides model card when no messages', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ messages: [] }),
      },
    })

    await nextTick()

    expect(wrapper.find('.model-card').exists()).toBe(false)
  })

  test('displays output section for successful runs', async () => {
    const msg1 = new Message('system', 'System')
    const msg2 = new Message('user', 'User')
    const msg3 = new Message('assistant', 'Final output')

    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({
          status: 'success',
          messages: [msg1, msg2, msg3],
        }),
      },
    })

    await nextTick()

    expect(wrapper.find('.output-section').exists()).toBe(true)
  })

  describe('links in the output', () => {

    const mountOutput = async (content: string) => {
      const wrapper = mount(RunInfo, {
        attachTo: document.body,
        props: {
          agent: createMockAgent(),
          run: createMockRun({ messages: [new Message('system', 'System'), new Message('user', 'User'), new Message('assistant', content)] }),
        },
      })
      await nextTick()
      return wrapper
    }

    // the click is cancelled once it has gone through the page so that jsdom does not try to navigate
    const click = (link: Element) => {
      const cancel = (event: Event) => event.preventDefault()
      window.addEventListener('click', cancel)
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      window.removeEventListener('click', cancel)
    }

    test('open in a new window', async () => {
      const wrapper = await mountOutput('Read the [report](https://example.com/report) or <mailto:someone@example.com>.')
      const links = wrapper.findAll('.output-content a[href]')
      expect(links.map((link) => link.attributes('href'))).toEqual(['https://example.com/report', 'mailto:someone@example.com'])
      for (const link of links) {
        expect(link.attributes('target')).toBe('_blank')
        expect(link.attributes('rel')).toBe('noopener noreferrer')
      }
      wrapper.unmount()
    })

    test('open in a new window whatever rendered them', async () => {
      const wrapper = await mountOutput('Read the [**full** report](https://example.com/report).')
      const link = wrapper.find('.output-content a[href]').element
      link.removeAttribute('target')
      link.removeAttribute('rel')
      click(link.querySelector('strong'))
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      wrapper.unmount()
    })

    test('are not links when they do not go to the web', async () => {
      const wrapper = await mountOutput('Open [the report](file:///C:/Windows/System32/calc.exe), [the share](smb://evil.example/share) or [settings](#/settings).')
      expect(wrapper.find('.output-content a').exists()).toBe(false)
      expect(wrapper.find('.output-content').text()).toContain('[the report](file:///C:/Windows/System32/calc.exe)')
      wrapper.unmount()
    })

  })

  test('hides output section for non-success runs', async () => {
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ status: 'error' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.output-section').exists()).toBe(false)
  })

  test('calculates duration correctly', async () => {
    const createdAt = Date.now() - 5000 // 5 seconds ago
    const updatedAt = Date.now()

    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ createdAt, updatedAt, status: 'success' }),
      },
    })

    await nextTick()

    const durationStatCard = wrapper.findAll('.stat-card')[0]
    expect(durationStatCard.find('.stat-value').text()).toMatch(/\d+ s/)
  })

  test('shows debug info when debug mode is enabled', async () => {
    window.api.debug.isDebug = true

    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ uuid: 'debug-run-id' }),
      },
    })

    await nextTick()

    expect(wrapper.find('.debug-info').exists()).toBe(true)
    expect(wrapper.find('.debug-info code').text()).toBe('debug-run-id')

    window.api.debug.isDebug = false
  })

  test('updates duration live for running runs', async () => {
    vi.useFakeTimers()

    const createdAt = Date.now()
    const wrapper = mount(RunInfo, {
      props: {
        agent: createMockAgent(),
        run: createMockRun({ createdAt, updatedAt: createdAt, status: 'running' }),
      },
    })

    await nextTick()

    // Advance time
    vi.advanceTimersByTime(2000)
    await nextTick()

    // Duration should have updated
    const durationStatCard = wrapper.findAll('.stat-card')[0]
    const durationText = durationStatCard.find('.stat-value').text()
    expect(durationText).toMatch(/\d+/)

    wrapper.unmount()
    vi.useRealTimers()
  })
})
