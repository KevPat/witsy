import crypto from 'node:crypto'
import { App } from 'electron'
import { Agent, AgentRun, AgentRunTrigger } from 'types/agents'
import { v7 as uuidv7 } from 'uuid'
import { createAgentExecutor } from '../renderer/services/agent_utils'
import { registerAbortController } from './agent_tracker'
import { listAgents } from './agents'
import { LlmContext } from './llm_utils'
import Mcp from './mcp'
import DocumentRepository from './rag/docrepo'
import { listWorkspaces } from './workspace'

/**
 * Generate a unique webhook token for an agent: the token is the only credential
 * of the webhook, so it is 128 bits from the system CSPRNG as 32 hex characters
 * Ensures uniqueness across all agents in all workspaces
 */
export function generateWebhookToken(app: App, workspaceId: string, agentId: string): string {
  const maxAttempts = 1000

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = crypto.randomBytes(16).toString('hex')

    // Check if token is unique across all workspaces
    let isUnique = true
    const workspaces = listWorkspaces(app)

    for (const workspace of workspaces) {
      const agents = listAgents(app, workspace.uuid)
      for (const agent of agents) {
        // Skip the agent we're generating for
        if (workspace.uuid === workspaceId && agent.uuid === agentId) {
          continue
        }
        if (agent.webhookToken === token) {
          isUnique = false
          break
        }
      }
      if (!isUnique) break
    }

    // If unique return
    if (isUnique) {
      return token
    }
  }

  throw new Error('Failed to generate unique webhook token after maximum attempts')
}

/**
 * Find an agent by its webhook token across all workspaces
 */
export function findAgentByWebhookToken(app: App, token: string): { agent: Agent, workspaceId: string } | null {
  const workspaces = listWorkspaces(app)

  for (const workspace of workspaces) {
    const agents = listAgents(app, workspace.uuid)
    const agent = agents.find(a => a.webhookToken === token)

    if (agent) {
      return { agent, workspaceId: workspace.uuid }
    }
  }

  return null
}

export class AgentExecutor extends LlmContext {

  constructor(app: App, mcp: Mcp, docRepo: DocumentRepository) {
    super(app, mcp, docRepo)
  }

  public async runAgent(
    workspaceId: string,
    agent: Agent,
    trigger: AgentRunTrigger,
    values: Record<string, string>,
    runId?: string
  ): Promise<AgentRun> {

    // Initialize LLM context (global mock + i18n)
    const config = this.initializeContext()

    // Create abort controller for this run
    const abortController = new AbortController()
    const actualRunId = runId || uuidv7()

    // Register abort controller so it can be aborted via IPC
    registerAbortController(agent.uuid, actualRunId, abortController)

    // Create executor for this agent
    const executor = createAgentExecutor(config, workspaceId, agent)
    return await executor.run(trigger, values, {
      runId: actualRunId,
      model: agent.model,
      abortSignal: abortController.signal
    })
  }

}

