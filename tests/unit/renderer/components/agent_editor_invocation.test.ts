import { vi, beforeAll, beforeEach, afterAll, expect, test } from 'vitest'
import { mount, VueWrapper, enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { createI18nMock } from '@tests/mocks/index'
import { useWindowMock } from '@tests/mocks/window'
import { store } from '@services/store'
import Editor from '@renderer/agent/Editor.vue'
import Agent, { isLegacyWebhookToken } from '@models/agent'
import Dialog from '@renderer/utils/dialog'
import { nextTick } from 'vue'

enableAutoUnmount(afterAll)

vi.mock('@services/i18n', async () => {
  return createI18nMock()
})

vi.mock('@renderer/utils/dialog', () => ({
  default: {
    show: vi.fn(),
    waitUntilClosed: vi.fn()
  }
}))

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  vi.clearAllMocks()
  store.agents = []
})

test('Shows invocation step with schedule and variables', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}, how are you?', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = { name: 'World' }

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: { 
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Should show Scheduler component
  const scheduler = wrapper.findComponent({ name: 'Scheduler' })
  expect(scheduler.exists()).toBe(true)

  // Should show variables table for prompt inputs
  const variablesTable = wrapper.find('.variables')
  expect(variablesTable.exists()).toBe(true)
  
  const variableRows = variablesTable.findAll('tbody tr')
  expect(variableRows.length).toBe(1)
  expect(variableRows[0].text()).toContain('name')

  // Should show next runs display (since schedule is set)
  const nextRunsSection = wrapper.find('[for="next"]')
  expect(nextRunsSection).toBeTruthy()
})

test('Shows next runs when schedule is set', async () => {
  const agent = new Agent()
  agent.schedule = '0 9 * * *' // 9 AM daily
  agent.steps = [
    { prompt: 'Hello', tools: null, agents: [] }
  ]

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: { 
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Should show next runs section
  const nextRunsLabel = wrapper.find('label[for="next"]')
  expect(nextRunsLabel.exists()).toBe(true)
})

test('Updates invocation variables when typing', async () => {
  
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}, welcome to {{place}}', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = { name: 'John', place: 'Paris' }

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: { 
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Should show variables table with input fields
  const variableInputs = wrapper.findAll('.variables input[type="text"]')
  expect(variableInputs.length).toBe(2)
  
  // Values should be populated
  expect((variableInputs[0].element as HTMLInputElement).value).toBe('John')
  expect((variableInputs[1].element as HTMLInputElement).value).toBe('Paris')

  // Change a value
  await variableInputs[0].setValue('Jane')
  await variableInputs[0].trigger('input')

  // Should update the value
  expect((variableInputs[0].element as HTMLInputElement).value).toBe('Jane')
})

test('Shows variables from all workflow steps (not just step 0)', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}, how are you?', tools: null, agents: [] },
    { prompt: 'You are {{age}} years old', tools: null, agents: [] },
    { prompt: 'You live in {{city}}', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = { name: 'John', age: '30', city: 'Paris' }

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Should show variables table with ALL variables from ALL steps
  const variableRows = wrapper.findAll('.variables tbody tr')
  expect(variableRows.length).toBe(3)

  // Check that all variables are present
  const rowTexts = variableRows.map(row => row.text())
  expect(rowTexts.some(text => text.includes('name'))).toBe(true)
  expect(rowTexts.some(text => text.includes('age'))).toBe(true)
  expect(rowTexts.some(text => text.includes('city'))).toBe(true)
})

test('Shows variables from step 2+ and deduplicates across steps', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}', tools: null, agents: [] },
    { prompt: 'Your name is {{name}} and you are {{age}} years old', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = { name: 'John', age: '30' }

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Should deduplicate 'name' variable and show both name and age
  const variableRows = wrapper.findAll('.variables tbody tr')
  expect(variableRows.length).toBe(2)

  const rowTexts = variableRows.map(row => row.text())
  expect(rowTexts.some(text => text.includes('name'))).toBe(true)
  expect(rowTexts.some(text => text.includes('age'))).toBe(true)
})

test('Shows dialog when saving webhook agent with missing invocation values', async () => {
  // Enable HTTP endpoints in config
  store.config.general.enableHttpEndpoints = true

  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}, you are {{age}} years old', tools: null, agents: [] }
  ]
  agent.webhookToken = 'test-token-123'
  agent.invocationValues = { name: 'John' } // age is missing

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Mock dialog to return that user wants to go back (isConfirmed: true)
  vi.mocked(Dialog.show).mockResolvedValueOnce({ isConfirmed: true })

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Click save button
  const saveButton = wrapper.find('button[name="next"]')
  await saveButton.trigger('click')
  await nextTick()

  // Dialog should have been shown about missing values
  expect(Dialog.show).toHaveBeenCalledWith(expect.objectContaining({
    title: 'agent.create.invocation.missingInputs.title',
    text: 'agent.create.invocation.missingInputs.text',
    confirmButtonText: 'agent.create.invocation.missingInputs.confirmButtonText',
    cancelButtonText: 'agent.create.invocation.missingInputs.cancelButtonText',
    showCancelButton: true
  }))
})

test('Shows dialog when saving scheduled agent with missing invocation values', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Query: {{query}}, sections: {{sections}}', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = {} // all missing

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Mock dialog to return that user wants to go back (isConfirmed: true)
  vi.mocked(Dialog.show).mockResolvedValueOnce({ isConfirmed: true })

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Click save button
  const saveButton = wrapper.find('button[name="next"]')
  await saveButton.trigger('click')
  await nextTick()

  // Dialog should have been shown
  expect(Dialog.show).toHaveBeenCalledWith(expect.objectContaining({
    title: 'agent.create.invocation.missingInputs.title',
    showCancelButton: true
  }))
})

test('Allows "Save anyway" when user cancels missing values dialog', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = {} // missing value

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Mock agents.save to return true
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)

  // Mock dialog to return that user clicks "Save anyway" (isConfirmed: false, isDismissed: false)
  vi.mocked(Dialog.show).mockResolvedValueOnce({ isConfirmed: false, isDismissed: false })

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Click save button
  const saveButton = wrapper.find('button[name="next"]')
  await saveButton.trigger('click')
  await nextTick()

  // Dialog should have been shown
  expect(Dialog.show).toHaveBeenCalledWith(expect.objectContaining({
    title: 'agent.create.invocation.missingInputs.title',
  }))

  // Since user chose "Save anyway", save event should be emitted
  expect(wrapper.emitted('save')).toBeTruthy()
})

test('Does not show dialog when all invocation values are provided', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}', tools: null, agents: [] }
  ]
  agent.schedule = '0 9 * * *'
  agent.invocationValues = { name: 'John' } // all values provided

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Mock agents.save to return true
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Click save button
  const saveButton = wrapper.find('button[name="next"]')
  await saveButton.trigger('click')
  await nextTick()

  // Dialog should NOT have been shown since all values are provided
  expect(Dialog.show).not.toHaveBeenCalled()

  // Save event should be emitted
  expect(wrapper.emitted('save')).toBeTruthy()
})

test('Does not validate invocation values for manual-only agents', async () => {
  const agent = new Agent()
  agent.steps = [
    { prompt: 'Hello {{name}}', tools: null, agents: [] }
  ]
  // No schedule, no webhook - manual only
  agent.invocationValues = {} // missing value, but should not trigger dialog

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Mock agents.save to return true
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  // Click save button
  const saveButton = wrapper.find('button[name="next"]')
  await saveButton.trigger('click')
  await nextTick()

  // Dialog should NOT have been shown for manual-only agents
  expect(Dialog.show).not.toHaveBeenCalled()

  // Save event should be emitted
  expect(wrapper.emitted('save')).toBeTruthy()
})

// obvious dummies: none of these is a real token
const kLegacyToken = 'abc12345'
const kStrongToken = '0123456789abcdef0123456789abcdef'
const kOtherStrongToken = 'fedcba9876543210fedcba9876543210'

const mountWebhookEditor = async (webhookToken: string|null): Promise<VueWrapper<any>> => {

  const agent = new Agent()
  agent.name = 'Webhook Agent'
  agent.steps = [
    { prompt: 'Hello', tools: null, agents: [] }
  ]
  agent.webhookToken = webhookToken

  const wrapper: VueWrapper<any> = mount(Editor, {
    props: {
      mode: 'edit',
      agent: agent
    }
  })
  await nextTick()

  // Navigate to invocation step
  const steps = wrapper.findAll('.wizard-step')
  const invocationStep = steps.find(step => step.text().includes('agent.create.invocation.title'))
  await invocationStep!.trigger('click')
  await nextTick()

  return wrapper
}

const webhookUrlOf = (wrapper: VueWrapper<any>): string => {
  return (wrapper.find('.webhook-url-container input').element as HTMLInputElement).value
}

test('Warns that the webhook URL uses a legacy token', async () => {
  store.config.general.enableHttpEndpoints = true

  const wrapper = await mountWebhookEditor(kLegacyToken)

  // the old url is still the one displayed
  expect(webhookUrlOf(wrapper)).toBe(`http://localhost:8090/api/agent/run/${kLegacyToken}`)

  const warning = wrapper.find('.help.warning')
  expect(warning.exists()).toBe(true)
  expect(warning.text()).toContain('agent.trigger.webhook_legacy')
})

test('Does not warn when the webhook URL uses a strong token', async () => {
  store.config.general.enableHttpEndpoints = true

  const wrapper = await mountWebhookEditor(kStrongToken)

  expect(webhookUrlOf(wrapper)).toBe(`http://localhost:8090/api/agent/run/${kStrongToken}`)
  expect(wrapper.find('.help.warning').exists()).toBe(false)
})

test('Does not warn when the agent has no webhook', async () => {
  store.config.general.enableHttpEndpoints = true

  const wrapper = await mountWebhookEditor(null)

  expect(wrapper.find('.webhook-url-container').exists()).toBe(false)
  expect(wrapper.find('.help.warning').exists()).toBe(false)
})

test('Legacy token warning goes away when the token is regenerated', async () => {
  store.config.general.enableHttpEndpoints = true
  vi.mocked(window.api.agents.generateWebhookToken).mockResolvedValueOnce(kStrongToken)

  const wrapper = await mountWebhookEditor(kLegacyToken)
  expect(wrapper.find('.help.warning').exists()).toBe(true)

  // Click the regenerate button (the second one, after copy)
  const buttons = wrapper.findAll('.webhook-url-container button')
  await buttons[1].trigger('click')
  await flushPromises()

  expect(webhookUrlOf(wrapper)).toBe(`http://localhost:8090/api/agent/run/${kStrongToken}`)
  expect(wrapper.find('.help.warning').exists()).toBe(false)
})

test('Saving from the editor replaces a legacy token with a strong one', async () => {
  store.config.general.enableHttpEndpoints = true
  vi.mocked(window.api.agents.generateWebhookToken).mockResolvedValueOnce(kStrongToken)
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)
  vi.mocked(Dialog.show).mockResolvedValueOnce({ isConfirmed: false, isDismissed: true })

  const wrapper = await mountWebhookEditor(kLegacyToken)

  // Click save button
  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  // a new token was asked for this agent
  expect(window.api.agents.generateWebhookToken).toHaveBeenCalledTimes(1)
  expect(window.api.agents.generateWebhookToken).toHaveBeenCalledWith(store.config.workspaceId, wrapper.props('agent').uuid)

  // and this is the one that was saved
  expect(window.api.agents.save).toHaveBeenCalledTimes(1)
  const savedAgent = vi.mocked(window.api.agents.save).mock.calls[0][1]
  expect(savedAgent.webhookToken).toBe(kStrongToken)
  expect(isLegacyWebhookToken(savedAgent.webhookToken)).toBe(false)
  expect(JSON.stringify(savedAgent)).not.toContain(kLegacyToken)

  // the user is shown the new url
  expect(Dialog.show).toHaveBeenCalledTimes(1)
  expect(Dialog.show).toHaveBeenCalledWith(expect.objectContaining({
    title: 'agent.trigger.webhook_replaced_title',
    text: expect.stringContaining(`http://localhost:8090/api/agent/run/${kStrongToken}`),
    confirmButtonText: 'agent.trigger.webhook_copy',
    showCancelButton: true,
  }))
  expect(vi.mocked(Dialog.show).mock.calls[0][0].text).not.toContain(kLegacyToken)

  // and the editor shows it too, without the warning
  expect(webhookUrlOf(wrapper)).toBe(`http://localhost:8090/api/agent/run/${kStrongToken}`)
  expect(wrapper.find('.help.warning').exists()).toBe(false)

  expect(wrapper.emitted('save')).toBeTruthy()
})

test('Copies the new webhook URL when asked to after a legacy token was replaced', async () => {
  store.config.general.enableHttpEndpoints = true
  const writeText = vi.fn()
  Object.assign(navigator, { clipboard: { writeText } })
  vi.mocked(window.api.agents.generateWebhookToken).mockResolvedValueOnce(kStrongToken)
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)
  vi.mocked(Dialog.show).mockResolvedValueOnce({ isConfirmed: true, isDismissed: false })

  const wrapper = await mountWebhookEditor(kLegacyToken)
  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  expect(writeText).toHaveBeenCalledWith(`http://localhost:8090/api/agent/run/${kStrongToken}`)
})

test('Saving from the editor replaces a legacy token even when HTTP endpoints are disabled', async () => {
  store.config.general.enableHttpEndpoints = false
  vi.mocked(window.api.agents.generateWebhookToken).mockResolvedValueOnce(kStrongToken)
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)
  vi.mocked(Dialog.show).mockResolvedValueOnce({ isConfirmed: false, isDismissed: true })

  const wrapper = await mountWebhookEditor(kLegacyToken)
  expect(wrapper.find('.webhook-url-container').exists()).toBe(false)

  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  expect(vi.mocked(window.api.agents.save).mock.calls[0][1].webhookToken).toBe(kStrongToken)
  expect(Dialog.show).toHaveBeenCalledWith(expect.objectContaining({
    title: 'agent.trigger.webhook_replaced_title',
    text: expect.stringContaining(`http://localhost:8090/api/agent/run/${kStrongToken}`),
  }))
  expect(wrapper.emitted('save')).toBeTruthy()

  store.config.general.enableHttpEndpoints = true
})

test('Saving from the editor leaves a strong token untouched', async () => {
  store.config.general.enableHttpEndpoints = true
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)

  const wrapper = await mountWebhookEditor(kOtherStrongToken)

  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  expect(window.api.agents.generateWebhookToken).not.toHaveBeenCalled()
  expect(window.api.agents.save).toHaveBeenCalledTimes(1)
  expect(vi.mocked(window.api.agents.save).mock.calls[0][1].webhookToken).toBe(kOtherStrongToken)
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(wrapper.emitted('save')).toBeTruthy()
})

test('Saving from the editor does not give a token to an agent without webhook', async () => {
  store.config.general.enableHttpEndpoints = true
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)

  const wrapper = await mountWebhookEditor(null)

  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  expect(window.api.agents.generateWebhookToken).not.toHaveBeenCalled()
  expect(vi.mocked(window.api.agents.save).mock.calls[0][1].webhookToken).toBeNull()
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(wrapper.emitted('save')).toBeTruthy()
})

test('Saving from the editor keeps the legacy token when no strong token can be generated', async () => {
  store.config.general.enableHttpEndpoints = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(window.api.agents.generateWebhookToken).mockRejectedValueOnce(new Error('no token'))
  vi.mocked(window.api.agents.save).mockReturnValueOnce(true)

  const wrapper = await mountWebhookEditor(kLegacyToken)

  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  // the agent is saved all the same, its webhook still works and is still flagged
  expect(vi.mocked(window.api.agents.save).mock.calls[0][1].webhookToken).toBe(kLegacyToken)
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(wrapper.find('.help.warning').exists()).toBe(true)
  expect(wrapper.emitted('save')).toBeTruthy()
})

test('Keeps the legacy token in the editor when the save fails', async () => {
  store.config.general.enableHttpEndpoints = true
  vi.mocked(window.api.agents.generateWebhookToken).mockResolvedValueOnce(kStrongToken)
  vi.mocked(window.api.agents.save).mockReturnValueOnce(false)

  const wrapper = await mountWebhookEditor(kLegacyToken)

  await wrapper.find('button[name="next"]').trigger('click')
  await flushPromises()

  // nothing was written: the old url is still the valid one and the editor says so
  expect(window.api.agents.save).toHaveBeenCalledTimes(1)
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(wrapper.emitted('save')).toBeFalsy()
  expect(webhookUrlOf(wrapper)).toBe(`http://localhost:8090/api/agent/run/${kLegacyToken}`)
  expect(wrapper.find('.help.warning').exists()).toBe(true)
})