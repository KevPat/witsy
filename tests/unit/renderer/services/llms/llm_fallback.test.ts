import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { OpenAI } from 'multi-llm-ts'
import { useWindowMock } from '@tests/mocks/window'
import LlmFactory, { favoriteMockEngine } from '@services/llms/llm'
import { store } from '@services/store'

let llmManager = LlmFactory.manager(store.config)

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
  llmManager = LlmFactory.manager(store.config)
})

beforeEach(() => {
  store.loadSettings()
  store.config.engines.openai.apiKey = 'test-key'
})

test('unknown engine falls back to OpenAI', () => {
  const engine = llmManager.igniteEngine('unknown-engine')
  expect(engine).toBeInstanceOf(OpenAI)
})

test('custom engine ignition error does not fall back to OpenAI', () => {
  store.config.engines.customBad = {
    label: 'bad custom',
    api: 'other',
    apiKey: 'test-key',
    models: { chat: [], image: [] },
    model: { chat: '' },
  }
  let engine: OpenAI | undefined
  expect(() => { engine = llmManager.igniteEngine('customBad') as OpenAI }).toThrow('Cannot ignite custom engine customBad')
  expect(engine).toBeUndefined()
})

test('favorite engine ignition error does not fall back to OpenAI', () => {
  store.config.engines.customBad = {
    label: 'bad custom',
    api: 'other',
    apiKey: 'test-key',
    models: { chat: [], image: [] },
    model: { chat: '' },
  }
  store.config.llm.favorites = [{ id: 'fav-missing-api', engine: 'customBad', model: 'chat' }]
  store.config.engines[favoriteMockEngine].model.chat = 'fav-missing-api'
  let engine: OpenAI | undefined
  expect(() => { engine = llmManager.igniteEngine(favoriteMockEngine) as OpenAI }).toThrow('Cannot ignite custom engine customBad')
  expect(engine).toBeUndefined()
})

test('getChatModel returns null when the favorite id is missing', () => {
  store.config.llm.favorites = [
    { id: 'known', engine: 'openai', model: 'gpt-5.2' },
  ]
  store.config.engines.openai.models.chat = [
    { id: 'gpt-5.2', name: 'GPT', capabilities: { tools: true, vision: true, reasoning: false, caching: false } },
  ]
  expect(() => llmManager.getChatModel(favoriteMockEngine, 'missing-id')).not.toThrow()
  expect(llmManager.getChatModel(favoriteMockEngine, 'missing-id')).toBeNull()
  expect(llmManager.getChatModel(favoriteMockEngine, 'known')?.id).toBe('gpt-5.2')
  expect(llmManager.getChatModel('openai', 'missing-model')).toBeNull()
})

test('canProcessFormat does not throw when the model is missing', () => {
  expect(() => llmManager.canProcessFormat('openai', 'missing-model', 'jpg')).not.toThrow()
  store.config.engines.openai.model.vision = ''
  expect(llmManager.canProcessFormat('openai', 'missing-model', 'jpg')).toBe(false)
  store.config.engines.openai.model.vision = 'gpt-5.2'
  expect(llmManager.canProcessFormat('openai', 'missing-model', 'jpg')).toBe(true)
})

test('canProcessFormat does not throw when the engine is missing', () => {
  expect(() => llmManager.canProcessFormat('no-such-engine', 'x', 'jpg')).not.toThrow()
  expect(llmManager.canProcessFormat('no-such-engine', 'x', 'jpg')).toBe(false)
})

test('setChatModel ignores a missing engine', () => {
  const engine = store.config.llm.engine
  const engines = JSON.parse(JSON.stringify(store.config.engines))
  vi.mocked(window.api.config.save).mockClear()
  expect(() => llmManager.setChatModel('no-such-engine', 'x')).not.toThrow()
  expect(store.config.llm.engine).toBe(engine)
  expect(JSON.parse(JSON.stringify(store.config.engines))).toEqual(engines)
  expect(window.api.config.save).not.toHaveBeenCalled()
})

test('setChatModel creates model config when it is missing', () => {
  delete store.config.engines.openai.model
  vi.mocked(window.api.config.save).mockClear()
  expect(() => llmManager.setChatModel('openai', 'gpt-test')).not.toThrow()
  expect(store.config.llm.engine).toBe('openai')
  expect(store.config.engines.openai.model.chat).toBe('gpt-test')
  expect(window.api.config.save).toHaveBeenCalled()
})
