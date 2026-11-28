import { vi, expect, test, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { App } from 'electron'
import { Agent, AgentRun } from '@/types/agents'
import { generateWebhookToken, findAgentByWebhookToken, AgentExecutor } from '@main/agent_utils'
import * as workspaceModule from '@main/workspace'
import * as agentsModule from '@main/agents'
import * as configModule from '@main/config'
import AgentWorkflowExecutor from '@services/agent_executor_workflow'

// Mock dependencies
vi.mock('@main/workspace')
vi.mock('@main/agents')
vi.mock('@main/config')
vi.mock('@services/agent_executor_workflow')
vi.mock('@main/interpreter', () => ({
  runPython: vi.fn()
}))
vi.mock('@main/search', () => ({
  default: vi.fn().mockImplementation(() => ({
    search: vi.fn()
  }))
}))
vi.mock('@main/i18n', () => ({
  getLocaleMessages: vi.fn(() => ({}))
}))
vi.mock('@services/i18n', () => ({
  initI18n: vi.fn()
}))

const mockApp = {} as App

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([])
  vi.mocked(agentsModule.listAgents).mockReturnValue([])
  vi.mocked(agentsModule.saveAgent).mockReturnValue(true)
})

test('generateWebhookToken generates a 32 hex character token from the system CSPRNG', () => {
  const randomBytes = vi.spyOn(crypto, 'randomBytes')
  const mathRandom = vi.spyOn(Math, 'random')

  const token = generateWebhookToken(mockApp, 'workspace-1', 'agent-1')

  // 128 bits, safe in a url path without encoding
  expect(token).toMatch(/^[0-9a-f]{32}$/)
  expect(encodeURIComponent(token)).toBe(token)
  expect(randomBytes).toHaveBeenCalledWith(16)
  expect(mathRandom).not.toHaveBeenCalled()

  vi.restoreAllMocks()
})

test('generateWebhookToken does not depend on Math.random', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)

  const first = generateWebhookToken(mockApp, 'workspace-1', 'agent-1')
  const second = generateWebhookToken(mockApp, 'workspace-1', 'agent-1')

  expect(first).not.toBe(second)

  vi.restoreAllMocks()
})

test('generateWebhookToken never repeats a token', () => {
  const tokens = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    tokens.add(generateWebhookToken(mockApp, 'workspace-1', 'agent-1'))
  }
  expect(tokens.size).toBe(1000)
})

test('generateWebhookToken ensures uniqueness', () => {
  // the first candidate is the token of an existing agent
  const taken = Buffer.alloc(16, 0xaa)
  const randomBytes = vi.spyOn(crypto, 'randomBytes').mockImplementationOnce(() => taken)

  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' }
  ])

  vi.mocked(agentsModule.listAgents).mockReturnValue([
    { uuid: 'existing-agent', webhookToken: taken.toString('hex') },
    { uuid: 'agent-1', webhookToken: null } as any
  ])

  const token = generateWebhookToken(mockApp, 'workspace-1', 'agent-1')

  // Token should be different from existing one
  expect(token).not.toBe(taken.toString('hex'))
  expect(token).toMatch(/^[0-9a-f]{32}$/)
  expect(randomBytes).toHaveBeenCalledTimes(2)

  vi.restoreAllMocks()
})

test('generateWebhookToken may return again the token of the agent it generates for', () => {
  const current = Buffer.alloc(16, 0xbb)
  vi.spyOn(crypto, 'randomBytes').mockImplementationOnce(() => current)

  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' }
  ])
  vi.mocked(agentsModule.listAgents).mockReturnValue([
    { uuid: 'agent-1', webhookToken: current.toString('hex') } as any
  ])

  expect(generateWebhookToken(mockApp, 'workspace-1', 'agent-1')).toBe(current.toString('hex'))

  vi.restoreAllMocks()
})

test('generateWebhookToken returns unique token for agent', () => {
  vi.mocked(agentsModule.listAgents).mockReturnValue([
    { uuid: 'agent-1', webhookToken: null } as any
  ])

  const token = generateWebhookToken(mockApp, 'workspace-1', 'agent-1')

  expect(token).toMatch(/^[0-9a-f]{32}$/)
  expect(agentsModule.saveAgent).not.toHaveBeenCalled()
})

test('generateWebhookToken throws after max attempts', () => {
  // every candidate is the token of an existing agent
  const taken = Buffer.alloc(16, 0xaa)
  const randomBytes = vi.spyOn(crypto, 'randomBytes').mockImplementation(() => taken)

  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' }
  ])

  vi.mocked(agentsModule.listAgents).mockReturnValue([
    { uuid: 'existing', webhookToken: taken.toString('hex') } as any
  ])

  expect(() => {
    generateWebhookToken(mockApp, 'workspace-1', 'agent-1')
  }).toThrow('Failed to generate unique webhook token')
  expect(randomBytes).toHaveBeenCalledTimes(1000)

  vi.restoreAllMocks()
})

test('findAgentByWebhookToken still finds an agent by a token of the former 8 character format', () => {
  const legacyAgent = { uuid: 'legacy', name: 'Legacy Agent', webhookToken: 'abc12345' }
  const recentAgent = { uuid: 'recent', name: 'Recent Agent', webhookToken: 'a'.repeat(32) }

  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' }
  ])
  vi.mocked(agentsModule.listAgents).mockReturnValue([legacyAgent, recentAgent] as any)

  expect(findAgentByWebhookToken(mockApp, 'abc12345')).toEqual({ agent: legacyAgent, workspaceId: 'workspace-1' })
  expect(findAgentByWebhookToken(mockApp, 'a'.repeat(32))).toEqual({ agent: recentAgent, workspaceId: 'workspace-1' })
  expect(findAgentByWebhookToken(mockApp, 'abc1234')).toBeNull()
})

test('findAgentByWebhookToken finds agent in first workspace', () => {
  const targetAgent = {
    uuid: 'agent-1',
    name: 'Test Agent',
    webhookToken: 'abc12345'
  }

  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' },
    { uuid: 'workspace-2', name: 'Workspace 2' }
  ])

  vi.mocked(agentsModule.listAgents).mockImplementation((app: App|string, workspaceId: string) => {
    if (workspaceId === 'workspace-1') {
      return [targetAgent] as any
    }
    return []
  })

  const result = findAgentByWebhookToken(mockApp, 'abc12345')

  expect(result).toEqual({
    agent: targetAgent,
    workspaceId: 'workspace-1'
  })
})

test('findAgentByWebhookToken finds agent in second workspace', () => {
  const targetAgent = {
    uuid: 'agent-2',
    name: 'Test Agent 2',
    webhookToken: 'xyz99999'
  }

  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' },
    { uuid: 'workspace-2', name: 'Workspace 2' }
  ])

  vi.mocked(agentsModule.listAgents).mockImplementation((app: App|string, workspaceId: string) => {
    if (workspaceId === 'workspace-2') {
      return [targetAgent] as any
    }
    return []
  })

  const result = findAgentByWebhookToken(mockApp, 'xyz99999')

  expect(result).toEqual({
    agent: targetAgent,
    workspaceId: 'workspace-2'
  })
})

test('findAgentByWebhookToken returns null for invalid token', () => {
  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' }
  ])

  vi.mocked(agentsModule.listAgents).mockReturnValue([
    { uuid: 'agent-1', webhookToken: 'validtoken' } as any
  ])

  const result = findAgentByWebhookToken(mockApp, 'invalidtoken')

  expect(result).toBeNull()
})

test('findAgentByWebhookToken searches all workspaces', () => {
  vi.mocked(workspaceModule.listWorkspaces).mockReturnValue([
    { uuid: 'workspace-1', name: 'Workspace 1' },
    { uuid: 'workspace-2', name: 'Workspace 2' },
    { uuid: 'workspace-3', name: 'Workspace 3' }
  ])

  vi.mocked(agentsModule.listAgents).mockReturnValue([])

  findAgentByWebhookToken(mockApp, 'notfound')

  expect(agentsModule.listAgents).toHaveBeenCalledTimes(3)
  expect(agentsModule.listAgents).toHaveBeenCalledWith(mockApp, 'workspace-1')
  expect(agentsModule.listAgents).toHaveBeenCalledWith(mockApp, 'workspace-2')
  expect(agentsModule.listAgents).toHaveBeenCalledWith(mockApp, 'workspace-3')
})

test('AgentExecutor sets up mocks and calls AgentWorkflowExecutor', async () => {
  const mockAgent = {
    uuid: 'agent-1',
    name: 'Test Agent'
  } as unknown as Agent

  const mockRun = {
    uuid: 'run-1',
    agentId: 'agent-1',
    status: 'success'
  } as unknown as AgentRun

  const mockExecutor = {
    run: vi.fn().mockResolvedValue(mockRun)
  }

  // @ts-expect-error mocking
  AgentWorkflowExecutor.mockImplementation(() => mockExecutor)

  const mockConfig = {
    general: { locale: 'en-US' },
    llm: { locale: 'en-US' }
  }

  vi.mocked(configModule.loadSettings).mockReturnValue(mockConfig as any)

  const mockMcp = {
    getLlmTools: vi.fn(),
    callTool: vi.fn()
  }

  // @ts-expect-error partial types
  const executor = new AgentExecutor(mockApp, mockMcp)
  const result = await executor.runAgent('workspace-1', mockAgent, 'webhook', { prompt: 'Test prompt' })

  expect(AgentWorkflowExecutor).toHaveBeenCalledWith(mockConfig, 'workspace-1', mockAgent)
  expect(mockExecutor.run).toHaveBeenCalledWith('webhook', { prompt: 'Test prompt' }, expect.objectContaining({
    model: undefined,
    runId: expect.any(String),
    abortSignal: expect.any(AbortSignal)
  }))
  expect(result).toEqual(mockRun)

  // Verify global.window was mocked
  expect(global.window).toBeDefined()
  expect(global.window.api).toBeDefined()
  expect(global.window.api.config).toBeDefined()
  expect(global.window.api.agents).toBeDefined()
  expect(global.window.api.interpreter).toBeDefined()
  expect(global.window.api.search).toBeDefined()
  expect(global.window.api.mcp).toBeDefined()
})
