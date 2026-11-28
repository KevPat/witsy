import { Command } from 'types/index'
import { app, App } from 'electron'
import { createI18n } from './i18n.base'
import { getLocaleMessages } from './i18n'
import defaultCommands from '@root/defaults/commands.json'
import Monitor from './monitor'
import * as window from './window'
import * as file from './file'
import { backupCorruptFile, writeFileAtomicSync } from './atomic'
import path from 'path'
import fs from 'fs'

const monitor: Monitor = new Monitor(() => {
  window.emitIpcEventToAll('file-modified', 'commands');
})

const isCommand = (entry: any): boolean => {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string'
}

export const commandsFilePath = (app: App): string => {
  const userDataPath = app.getPath('userData')
  const commandsFilePath = path.join(userDataPath, 'commands.json')
  return commandsFilePath
}

export const loadCommands = (source: App|string): Command[] => {

  // init
  let commands: Command[] = []
  const commandsFile = typeof source === 'string' ? source : commandsFilePath(source)

  // migrations can update
  let updated = false

  // read
  try {
    const json = JSON.parse(fs.readFileSync(commandsFile, 'utf-8'))
    if (Array.isArray(json)) {
      // entries of the wrong shape are dropped instead of crashing at startup (COMMANDS.LOAD is synchronous)
      commands = json.filter(isCommand)
      if (commands.length !== json.length) {
        backupCorruptFile(commandsFile)
        updated = true
      }
    } else {
      // valid JSON that is not a commands file: keep a copy before the defaults replace it
      console.log('Commands file is not a list of commands', commandsFile)
      backupCorruptFile(commandsFile)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // the defaults are saved over this file below: keep a copy
      console.log('Error retrieving commands', error)
      backupCorruptFile(commandsFile)
    }
  }

  // i18n migrate label and template
  const t = createI18n(getLocaleMessages(app), 'en', { missingWarn: false }).global.t as CallableFunction
  for (const command of commands) {
    const key = `commands.commands.${command.id}`
    if (command.label === t(`${key}.label`)) {
      delete command.label
      updated = true
    }
    if (command.template === t(`${key}.template`)) {
      delete command.template
      updated = true
    }
  }

  // now add new commands
  for (const command of defaultCommands) {
    const c = commands.find((cmd: Command) => cmd.id === command.id)
    if (c == null) {
      commands.push(command as Command)
      updated = true
    } else {
      if (c.shortcut === undefined) {
        c.shortcut = command.shortcut || ''
        updated = true
      }
    }
  }

  // save if needed
  if (updated) {
    saveCommands(source, commands)
  }

  // start monitoring
  if (typeof source !== 'string') {
    monitor.start(commandsFile)
  }

  // done
  return commands

}

export const saveCommands = (dest: App|string, content: Command[]) => {
  try {
    const commandsFile = typeof dest === 'string' ? dest : commandsFilePath(dest)
    writeFileAtomicSync(commandsFile, JSON.stringify(content, null, 2))
  } catch (error) {
    console.log('Error saving commands', error)
  }
}

export const exportCommands = (app: App) => {

  // pick a directory
  const filepath = file.pickDirectory(app)
  if (!filepath) {
    return false
  }

  // a fresh install may have no file yet: export what is loaded
  let contents: string
  try {
    contents = fs.readFileSync(commandsFilePath(app), 'utf-8')
  } catch {
    contents = JSON.stringify(loadCommands(app), null, 2)
  }

  // write
  try {
    fs.writeFileSync(path.join(filepath, 'commands.json'), contents)
  } catch (error) {
    console.log('Error exporting commands', error)
    return false
  }

  // done
  return true

}

export const importCommands = (app: App) => {

  // pick the file
  const filename = file.pickFile(app, { location: true, filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (!filename) {
    return false
  }

  // read and check that this is a commands export
  let contents: string
  try {
    contents = fs.readFileSync(filename as string, 'utf-8')
    const json = JSON.parse(contents)
    if (!Array.isArray(json) || !json.length || !json.every(isCommand)) {
      console.log('Refusing to import a file that is not a commands export', filename)
      return false
    }
  } catch (error) {
    console.log('Error importing commands', error)
    return false
  }

  // write
  try {
    writeFileAtomicSync(commandsFilePath(app), contents)
  } catch (error) {
    console.log('Error importing commands', error)
    return false
  }

  // done
  return true

}
