
import { ComputerAction, anyDict } from 'types/index'
import { PluginExecutionContext, PluginParameter } from 'multi-llm-ts'
import Plugin, { PluginConfig } from './plugin'

export default class extends Plugin {

  constructor(config: PluginConfig, workspaceId: string) {
    super(config, workspaceId)
  }

  isEnabled(): boolean {
    return true
  }

  getName(): string {
    return 'computer'
  }

  getDescription(): string {
    return ''
  }

  getPreparationDescription(): string {
    return this.getRunningDescription()
  }

  getRunningDescription(): string {
    return 'Using your computer…'
  }

  getParameters(): PluginParameter[] {
    return []
  }

  async execute(context: PluginExecutionContext, parameters: anyDict): Promise<anyDict> {

    // we need an action
    if (!parameters.action) {
      return { content: 'No action specified' }
    }

    // if not screenshot run it first
    if (parameters.action !== 'screenshot') {
      let failure: string | null = null
      try {
        // success is `true` or a cursor position: anything else is a failure
        const result = window.api.computer.executeAction(parameters as ComputerAction)
        if (!result || result.error) {
          failure = typeof result?.error === 'string' ? `: ${result.error}` : ''
        }
      } catch (e) {
        failure = `: ${e instanceof Error ? e.message : String(e)}`
      }
      if (failure !== null) {
        // this result is spread into an Anthropic tool_result block:
        // `is_error` is the only way to flag it (no `error` attribute)
        return {
          content: `An error occurred while executing the "${parameters.action}" action${failure}. Do not assume it was performed.`,
          is_error: true
        }
      }
    }

    // screenshot 
    const sshot = window.api.computer.takeScreenshot()
    return { content: [
      { type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: sshot
        }
      }
    ]}

  }  

}
