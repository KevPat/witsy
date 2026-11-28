
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Command, Expert, ExpertCategory } from '@/types/index'
import * as commands from '@main/commands'
import * as experts from '@main/experts'
import * as file from '@main/file'
import defaultCommands from '@root/defaults/commands.json'
import defaultExperts from '@root/defaults/experts.json'
import { bug } from './bug'

let root: string
let userData: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
      getLocale: vi.fn(() => 'en-US'),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
    },
  }
})

vi.mock('electron-store', async () => {
  class Store {
    get store() { return {} }
    set() {}
    delete() {}
  }
  return { default: Store }
})

vi.mock('@main/monitor', async () => {
  class Monitor {
    start() {}
    stop() {}
  }
  return { default: Monitor }
})

vi.mock('@main/window', async () => {
  return { emitIpcEventToAll: vi.fn() }
})

vi.mock('@main/windows/index', async () => {
  return { emitIpcEventToAll: vi.fn() }
})

vi.mock('@main/file', async () => {
  return {
    pickFile: vi.fn(),
    pickDirectory: vi.fn(),
  }
})

const workspaceId = 'workspace-1'

const commandsFile = () => path.join(userData, 'commands.json')
const expertsFile = () => path.join(userData, 'workspaces', workspaceId, 'experts.json')

const writeText = (target: string, text: string): string => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return target
}

// true when some file below dir still holds this exact text (the original file or a backup of it)
const isKeptOnDisk = (dir: string, text: string): boolean => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isKeptOnDisk(full, text)) return true
    } else if (fs.readFileSync(full, 'utf-8') === text) {
      return true
    }
  }
  return false
}

const userCommand = (i: number): Command => ({
  id: `user-command-${i}`, type: 'user', icon: '⭐', label: `My command ${i}`, action: 'chat_window',
  template: `Do thing ${i} with {input}`, shortcut: '', state: 'enabled', engine: '', model: '',
})

const userExpert = (i: number): Expert => ({
  id: `user-expert-${i}`, type: 'user', name: `My expert ${i}`, prompt: `You are expert ${i}`,
  state: 'enabled', triggerApps: [],
})

// what a legacy export looked like: a plain array, no categories, system experts without categoryId
const legacyExperts = (...extraIds: string[]): any[] => [
  ...defaultExperts.experts.slice(0, 3).map(expert => ({ id: expert.id, type: 'system', state: 'enabled' })),
  ...extraIds.map(id => ({ id, type: 'system', state: 'enabled' })),
  { id: 'user-expert-legacy', type: 'user', name: 'Mine', prompt: 'You are mine', state: 'enabled', triggerApps: [] },
]

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-experts-commands-'))
  userData = path.join(root, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('commands.json', () => {

  test('a fresh install gets every default command and the file is created', () => {
    const loaded = commands.loadCommands(app)
    expect(loaded.map(command => command.id)).toEqual(defaultCommands.map(command => command.id))
    expect(JSON.parse(fs.readFileSync(commandsFile(), 'utf-8'))).toHaveLength(defaultCommands.length)
  })

  test('stress: 100 save and reload cycles keep every user command and its order', () => {
    let loaded = commands.loadCommands(app)
    for (let i = 0; i < 100; i++) {
      loaded.splice(i % loaded.length, 0, userCommand(i))
      commands.saveCommands(app, loaded)
      loaded = commands.loadCommands(app)
    }
    const users = loaded.filter(command => command.type === 'user')
    expect(users).toHaveLength(100)
    expect(new Set(users.map(command => command.id)).size).toBe(100)
    expect(loaded).toHaveLength(defaultCommands.length + 100)
    for (const command of users) {
      const i = parseInt(command.id.split('-').pop())
      expect(command).toEqual(userCommand(i))
    }
  })

  test('default commands deleted from the file come back, user edits of the others are kept', () => {
    const loaded = commands.loadCommands(app)
    const removed = loaded.splice(3, 2).map(command => command.id)
    loaded[0].label = 'Renamed by me'
    loaded[0].shortcut = 'Z'
    commands.saveCommands(app, loaded)
    const reloaded = commands.loadCommands(app)
    expect(reloaded).toHaveLength(defaultCommands.length)
    expect(reloaded.map(command => command.id)).toEqual(expect.arrayContaining(removed))
    expect(reloaded[0].label).toBe('Renamed by me')
    expect(reloaded[0].shortcut).toBe('Z')
  })

  test('exportCommands writes an exact copy to the picked directory', () => {
    const loaded = commands.loadCommands(app)
    commands.saveCommands(app, [...loaded, userCommand(1)])
    const target = path.join(root, 'export')
    fs.mkdirSync(target)
    vi.mocked(file.pickDirectory).mockReturnValue(target)
    expect(commands.exportCommands(app)).toBe(true)
    expect(fs.readFileSync(path.join(target, 'commands.json'), 'utf-8')).toBe(fs.readFileSync(commandsFile(), 'utf-8'))
  })

  test('import and export do nothing when the picker is cancelled', () => {
    commands.loadCommands(app)
    const before = fs.readFileSync(commandsFile(), 'utf-8')
    vi.mocked(file.pickDirectory).mockReturnValue(null)
    vi.mocked(file.pickFile).mockReturnValue(null)
    expect(commands.exportCommands(app)).toBe(false)
    expect(commands.importCommands(app)).toBe(false)
    expect(fs.readFileSync(commandsFile(), 'utf-8')).toBe(before)
  })

  bug.each([
    ['{}'],
    ['null'],
    ['42'],
    ['"text"'],
    ['[null]'],
    ['[1,2]'],
    ['[[]]'],
    ['{"commands":[]}'],
  ])('valid JSON of the wrong shape still loads a usable list: %s', (text) => {
    // the parsed value is iterated and searched as if it were a Command[]: COMMANDS.LOAD is a sendSync handler, so this exception freezes every window at startup
    writeText(commandsFile(), text)
    let loaded: Command[]
    expect(() => loaded = commands.loadCommands(app)).not.toThrow()
    expect(loaded.every(command => command !== null && typeof command === 'object' && typeof command.id === 'string')).toBe(true)
    expect(loaded.map(command => command.id)).toEqual(expect.arrayContaining(defaultCommands.map(command => command.id)))
  })

  bug('fuzz: a commands file truncated at any point is not replaced by the defaults without a backup', () => {
    // parse error leaves an empty list, the defaults are appended, and the "updated" list is saved over the user's file
    const full = JSON.stringify([...defaultCommands.slice(0, 4), userCommand(1), userCommand(2)], null, 2)
    const lost: number[] = []
    for (let cut = 1; cut < full.length - 1; cut += 37) {
      fs.rmSync(userData, { recursive: true, force: true })
      const text = full.slice(0, cut)
      writeText(commandsFile(), text)
      commands.loadCommands(app)
      if (!isKeptOnDisk(userData, text)) lost.push(cut)
    }
    expect(lost).toEqual([])
  })

  bug.each([
    ['an experts export', JSON.stringify(defaultExperts)],
    ['a settings file', JSON.stringify({ general: { locale: 'fr' }, engines: {} })],
    ['a truncated commands export', JSON.stringify([userCommand(7)]).slice(0, 40)],
    ['a JSON null', 'null'],
  ])('importing %s is refused and the current commands are kept', (_, text) => {
    // importCommands copies the picked file over commands.json without looking at it
    commands.saveCommands(app, [...commands.loadCommands(app), userCommand(1)])
    const before = fs.readFileSync(commandsFile(), 'utf-8')
    vi.mocked(file.pickFile).mockReturnValue(writeText(path.join(root, 'picked.json'), text))
    let rc: boolean
    expect(() => rc = commands.importCommands(app)).not.toThrow()
    expect(rc).toBe(false)
    expect(fs.readFileSync(commandsFile(), 'utf-8')).toBe(before)
  })

  test('importing a commands export replaces the current commands', () => {
    commands.loadCommands(app)
    const exported = [...defaultCommands.slice(0, 5), userCommand(9)]
    vi.mocked(file.pickFile).mockReturnValue(writeText(path.join(root, 'picked.json'), JSON.stringify(exported)))
    expect(commands.importCommands(app)).toBe(true)
    const loaded = commands.loadCommands(app)
    expect(loaded.find(command => command.id === 'user-command-9')).toEqual(userCommand(9))
    expect(loaded).toHaveLength(defaultCommands.length + 1)
  })

})

describe('experts.json', () => {

  test('a workspace without experts file gets the defaults', () => {
    expect(experts.loadExperts(app, workspaceId).map(expert => expert.id)).toEqual(defaultExperts.experts.map(expert => expert.id))
    expect(experts.loadCategories(app, workspaceId).map(category => category.id)).toEqual(defaultExperts.categories.map(category => category.id))
  })

  test('stress: 20 save and reload cycles keep user experts and user categories', () => {
    for (let i = 0; i < 20; i++) {
      const loaded = experts.loadExperts(app, workspaceId)
      const categories = experts.loadCategories(app, workspaceId)
      experts.saveExperts(app, workspaceId, [...loaded, { ...userExpert(i), categoryId: `user-category-${i}` }])
      experts.saveCategories(app, workspaceId, [...categories, { id: `user-category-${i}`, type: 'user', state: 'enabled', name: `Category ${i}` }])
    }
    const loaded = experts.loadExperts(app, workspaceId)
    const categories = experts.loadCategories(app, workspaceId)
    expect(loaded).toHaveLength(defaultExperts.experts.length + 20)
    expect(categories).toHaveLength(defaultExperts.categories.length + 20)
    for (let i = 0; i < 20; i++) {
      expect(loaded.find(expert => expert.id === `user-expert-${i}`)).toMatchObject({ ...userExpert(i), categoryId: `user-category-${i}` })
      expect(categories.find(category => category.id === `user-category-${i}`)).toMatchObject({ name: `Category ${i}` })
    }
  })

  test('two workspaces do not share experts', () => {
    experts.saveExperts(app, 'workspace-a', [...experts.loadExperts(app, 'workspace-a'), userExpert(1)])
    experts.saveExperts(app, 'workspace-b', [...experts.loadExperts(app, 'workspace-b'), userExpert(2)])
    expect(experts.loadExperts(app, 'workspace-a').filter(expert => expert.type === 'user').map(expert => expert.id)).toEqual(['user-expert-1'])
    expect(experts.loadExperts(app, 'workspace-b').filter(expert => expert.type === 'user').map(expert => expert.id)).toEqual(['user-expert-2'])
  })

  test('a legacy array of experts is migrated: user experts kept, defaults and categories added', () => {
    writeText(expertsFile(), JSON.stringify(legacyExperts()))
    const loaded = experts.loadExperts(app, workspaceId)
    expect(loaded.find(expert => expert.id === 'user-expert-legacy')).toMatchObject({ name: 'Mine', prompt: 'You are mine' })
    expect(loaded.filter(expert => expert.type === 'system')).toHaveLength(defaultExperts.experts.length)
    expect(loaded.filter(expert => expert.type === 'system').every(expert => !!expert.categoryId)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(expertsFile(), 'utf-8'))
    expect(onDisk.categories).toHaveLength(defaultExperts.categories.length)
    expect(onDisk.experts).toHaveLength(defaultExperts.experts.length + 1)
  })

  test.each([
    ['{}'],
    ['null'],
    ['42'],
    ['"text"'],
    ['[]'],
    ['{"categories":[],"experts":null}'],
    ['{"categories":null,"experts":[]}'],
    ['{"experts":[]}'],
  ])('fuzz: shapes that carry no experts fall back to the defaults: %s', (text) => {
    writeText(expertsFile(), text)
    const loaded = experts.loadExperts(app, workspaceId)
    expect(loaded.map(expert => expert.id)).toEqual(expect.arrayContaining(defaultExperts.experts.map(expert => expert.id)))
    expect(experts.loadCategories(app, workspaceId).length).toBeGreaterThanOrEqual(defaultExperts.categories.length)
  })

  bug.each([
    ['doctor, deprecated in the code', '6e197c43-1074-479b-89d5-3ab8d54ad36b'],
    ['removed from the defaults in 2024-11', '07308c44-0e1e-4a2b-be8e-c0a610fd5574'],
    ['removed from the defaults in 2024-09', 'ef640997-0ab8-4d5a-aa8e-10f8c3f4a7f1'],
  ])('a legacy experts file holding a retired system expert still loads (%s)', (_, id) => {
    // experts.ts reads defaultExpert.categoryId without checking that the id still exists in the defaults
    writeText(expertsFile(), JSON.stringify(legacyExperts(id)))
    let loaded: Expert[]
    expect(() => loaded = experts.loadExperts(app, workspaceId)).not.toThrow()
    expect(loaded.find(expert => expert.id === 'user-expert-legacy')).toBeDefined()
    expect(loaded.length).toBeGreaterThanOrEqual(defaultExperts.experts.length + 1)
  })

  bug('a retired system expert in the current file format does not prevent loading either', () => {
    // same unchecked defaultExpert.categoryId, reached through the { categories, experts } branch
    writeText(expertsFile(), JSON.stringify({
      categories: defaultExperts.categories,
      experts: [...defaultExperts.experts, { id: 'retired-system-expert', type: 'system', state: 'enabled' }, userExpert(1)],
    }))
    let loaded: Expert[]
    expect(() => loaded = experts.loadExperts(app, workspaceId)).not.toThrow()
    expect(loaded.find(expert => expert.id === 'user-expert-1')).toBeDefined()
  })

  bug.each([
    ['[null]'],
    ['[1]'],
    ['[{"type":"system"}]'],
    ['{"categories":{},"experts":{}}'],
    ['{"categories":"text","experts":[]}'],
    ['{"categories":[null],"experts":[]}'],
    ['{"categories":[],"experts":[null]}'],
  ])('valid JSON of the wrong shape still loads a usable list: %s', (text) => {
    // entries are dereferenced without validation: EXPERTS.LOAD is a sendSync handler, so this exception freezes the window at startup
    writeText(expertsFile(), text)
    let loaded: Expert[]
    let categories: ExpertCategory[]
    expect(() => {
      loaded = experts.loadExperts(app, workspaceId)
      categories = experts.loadCategories(app, workspaceId)
    }).not.toThrow()
    expect(loaded.every(expert => expert !== null && typeof expert === 'object' && typeof expert.id === 'string')).toBe(true)
    expect(categories.every(category => category !== null && typeof category === 'object' && typeof category.id === 'string')).toBe(true)
  })

  bug('picking the commands export in the experts import does not break the experts', () => {
    // commands are an array of { type: 'system' } entries: taken for a legacy experts file, then crash on defaultExpert.categoryId
    experts.saveExperts(app, workspaceId, [...experts.loadExperts(app, workspaceId), userExpert(1)])
    vi.mocked(file.pickFile).mockReturnValue(writeText(path.join(root, 'commands.json'), JSON.stringify(defaultCommands)))
    let loaded: Expert[]
    expect(() => {
      experts.importExperts(app, workspaceId)
      loaded = experts.loadExperts(app, workspaceId)
    }).not.toThrow()
    const commandIds = defaultCommands.map(command => command.id)
    expect(loaded.filter(expert => commandIds.includes(expert.id))).toEqual([])
  })

  bug('exporting the experts of a fresh workspace does not throw', () => {
    // the defaults are returned without ever being written, and exportExperts copies the file that does not exist yet (ENOENT)
    const target = path.join(root, 'export')
    fs.mkdirSync(target)
    vi.mocked(file.pickDirectory).mockReturnValue(target)
    expect(experts.loadExperts(app, workspaceId).length).toBeGreaterThan(0)
    let rc: boolean
    expect(() => rc = experts.exportExperts(app, workspaceId)).not.toThrow()
    expect(rc === false || fs.existsSync(path.join(target, 'experts.json'))).toBe(true)
  })

  test('exporting works once the experts were saved', () => {
    experts.saveExperts(app, workspaceId, [...experts.loadExperts(app, workspaceId), userExpert(1)])
    const target = path.join(root, 'export')
    fs.mkdirSync(target)
    vi.mocked(file.pickDirectory).mockReturnValue(target)
    expect(experts.exportExperts(app, workspaceId)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(target, 'experts.json'), 'utf-8')).experts.find((expert: Expert) => expert.id === 'user-expert-1')).toBeDefined()
  })

  bug('fuzz: an experts file truncated at any point is not replaced on the next save without a backup', () => {
    // a parse error is treated like a missing file: defaults are returned and the next save (every use of an expert bumps its stats) overwrites the user's file
    const full = JSON.stringify({ categories: defaultExperts.categories, experts: [...defaultExperts.experts.slice(0, 4), userExpert(1), userExpert(2)] }, null, 2)
    const lost: number[] = []
    for (let cut = 1; cut < full.length - 1; cut += 97) {
      fs.rmSync(userData, { recursive: true, force: true })
      const text = full.slice(0, cut)
      writeText(expertsFile(), text)
      const loaded = experts.loadExperts(app, workspaceId)
      experts.saveExperts(app, workspaceId, loaded)
      if (!isKeptOnDisk(userData, text)) lost.push(cut)
    }
    expect(lost).toEqual([])
  })

})
