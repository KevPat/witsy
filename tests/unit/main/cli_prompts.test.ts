import { describe, expect, test } from 'vitest'
import CliPlugin from '@/main/cli_plugin'
import { generateCliInstructions } from '@/main/cli_prompts'

describe('generateCliInstructions', () => {

  test('read-only instructions only describe what the plugin offers', () => {
    const instructions = generateCliInstructions('/work/project', 'ro')
    expect(instructions).toContain('**Access Level**: Read-Only')
    expect(instructions).toContain('/work/project')

    // every action offered with read-only access is presented
    const plugin = new CliPlugin({ workDirPath: '/work/project', workDirAccess: 'ro' })
    const actions = plugin.getParameters().find((parameter) => parameter.name === 'action')?.enum ?? []
    expect(actions).toEqual(['read_file', 'list_files', 'search'])
    for (const action of actions) {
      expect(instructions).toContain(`**${action}**`)
    }

    // shell commands are not: the only mention of run_command says it is refused
    expect(instructions).toContain('Shell commands are not available with read-only access')
    expect(instructions.match(/run_command/g)).toHaveLength(1)
    expect(instructions).toContain('`run_command` is refused')
    expect(instructions).not.toContain('shell tool')
    expect(instructions).not.toContain('Use shell commands')
    expect(instructions).not.toMatch(/grep|Select-String|Get-ChildItem|`ls`/)
    expect(instructions).not.toMatch(/\{\{.*\}\}/)
    for (const action of ['edit_file', 'write_file', 'create_directory', 'delete_file', 'move_file']) {
      expect(instructions).not.toContain(action)
    }
  })

  test('read-write instructions keep the shell tool and the write actions', () => {
    const instructions = generateCliInstructions('/work/project', 'rw')
    expect(instructions).toContain('**Access Level**: Read-Write')
    expect(instructions).toContain('**run_command** - Execute shell commands in the working directory')
    expect(instructions).toContain('Use shell commands')
    expect(instructions).toContain('## Shell Command Safety')
    for (const action of ['edit_file', 'write_file', 'create_directory', 'delete_file', 'move_file']) {
      expect(instructions).toContain(action)
    }
    expect(instructions).not.toContain('Shell commands are not available')
    expect(instructions).not.toMatch(/\{\{.*\}\}/)
  })

})
