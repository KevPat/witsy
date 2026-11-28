
import { CronExpressionParser } from 'cron-parser'
import { App } from 'electron'
import { AgentExecutor } from './agent_utils'
import { listAgents } from './agents'
import Mcp from './mcp'
import DocumentRepository from './rag/docrepo'
import { listWorkspaces } from './workspace'

export default class Scheduler extends AgentExecutor {

  timeout: NodeJS.Timeout|null = null

  // occurrence already served for each agent: a check that wakes up early (timers can fire
  // before the minute, a resume from sleep, a clock change) sees the same occurrence again
  private served: Map<string, number> = new Map()

  constructor(app: App, mcp: Mcp, docRepo: DocumentRepository) {
    super(app, mcp, docRepo)
  }

  stop() {
    clearTimeout(this.timeout)
    this.timeout = null
  }

  async start(): Promise<void> {

    // clear previous
    this.stop()

    // we want to run on next minute
    const now = new Date()
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
    this.timeout = setTimeout(() => {
      this.timeout = null
      this.check()
    }, delay)

  }

  async check(): Promise<void> {

    try {

      // we need to check is we where 30 seconds before to make sure we don't miss
      const tolerance = 30 * 1000
      const now: number = Date.now()

      // load agents
      const workspaces = listWorkspaces(this.app)
      for (const workspace of workspaces) {

        // iterate over all agents
        const agents = listAgents(this.app, workspace.uuid)
        for (const agent of agents) {

          try {

            // check if agent has a schedule
            if (!agent.schedule) {
              continue
            }

            // check if schedule is due
            const interval = CronExpressionParser.parse(agent.schedule, { currentDate: now - tolerance })
            const next = interval.next().getTime()
            if (Math.abs(next - now) < tolerance) {

              // only once per occurrence
              const key = `${workspace.uuid}:${agent.uuid}`
              if (this.served.get(key) === next) {
                continue
              }
              this.served.set(key, next)

              console.log(`Agent ${agent.name} is due to run`)

              try {

                // run the agent with invocation values
                // (not awaited: an agent must not delay the others, but its failure is ours to handle)
                this.runAgent(workspace.uuid, agent, 'schedule', agent.invocationValues || {})?.catch((error) => {
                  console.log(`Error running agent ${agent.name}`, error)
                })

              } catch (error) {
                console.log(`Error running agent ${agent.name}`, error)
                continue
              }

            }

          } catch (error) {
            console.log(`Error checking schedule for ${agent.name}`, error)
            continue
          }

        }
      }

    } finally {

      // occurrences that are out of the tolerance window cannot be seen again
      for (const [key, occurrence] of this.served) {
        if (Date.now() - occurrence > 2 * 30 * 1000) {
          this.served.delete(key)
        }
      }

      // schedule next
      this.start()

    }

  }

}
