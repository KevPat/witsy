
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { kDefaultWorkspaceId } from '@/consts'
import { deleteWorkspace, initializeWorkspace, listWorkspaces, loadWorkspace, migrateHistoryImagePaths, saveWorkspace } from '@main/workspace'
import { bug } from './bug'

let root: string
let userData: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
    },
  }
})

vi.mock('@main/monitor', async () => {
  class Monitor {
    start() {}
    stop() {}
  }
  return { default: Monitor }
})

vi.mock('@main/windows/index', async () => {
  return { emitIpcEventToAll: vi.fn() }
})

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

const setPlatform = (value: string) => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

const workspaceDir = (id: string) => path.join(userData, 'workspaces', id)
const workspaceFile = (id: string) => path.join(workspaceDir(id), 'workspace.json')
const docrepoFile = () => path.join(userData, 'docrepo.json')

const writeText = (target: string, text: string): string => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return target
}

const readJson = (target: string): any => JSON.parse(fs.readFileSync(target, 'utf-8'))

const count = (text: string, needle: string): number => text.split(needle).length - 1

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-workspace-'))
  userData = path.join(root, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('migrateHistoryImagePaths', () => {

  const workspaceId = 'b0b5c1c2-0000-4000-8000-000000000001'

  type Flavor = { platforms: string[], userDataDirs: string[], sep: string }

  const posix: Flavor = {
    platforms: ['darwin', 'linux'],
    userDataDirs: ['/Users/me/Library/Application Support', '/home/me/.config', '/Users/José María/Library/Application Support', '/home/witsy fan/.config'],
    sep: '/',
  }

  const windows: Flavor = {
    platforms: ['win32'],
    userDataDirs: ['C:\\Users\\me\\AppData\\Roaming', 'D:\\Profiles\\José María\\AppData\\Roaming'],
    sep: '\\',
  }

  const fileNames = ['a.png', 'b0b5c1c2-1111-4222-8333-444455556666.png', 'photo 1.jpg', 'vidéo.mp4', 'x.webp']
  const glue = [' ', ' and ', '\n\n', ' | ', ', then ']

  // a history file whose first message references `urls` images, all inside one JSON string, i.e. on one line of history.json
  const buildHistory = (rand: () => number, flavor: Flavor, urls: number, target: 'legacy' | 'migrated'): string => {
    const base = flavor.userDataDirs[Math.floor(rand() * flavor.userDataDirs.length)]
    const dir = target === 'legacy'
      ? [base, 'Witsy', 'images'].join(flavor.sep)
      : [base, 'Witsy', 'workspaces', workspaceId, 'images'].join(flavor.sep)
    let content = 'Here you go: '
    for (let i = 0; i < urls; i++) {
      const name = fileNames[Math.floor(rand() * fileNames.length)]
      content += `![image ${i}](file://${dir}${flavor.sep}${name})${glue[Math.floor(rand() * glue.length)]}`
    }
    const history = {
      version: 1,
      folders: [] as any[],
      chats: [{ uuid: 'chat-1', title: 'Images', messages: [{ role: 'user', content: 'draw' }, { role: 'assistant', content: content }] }],
      quickPrompts: [] as any[],
    }
    return JSON.stringify(history, null, 2)
  }

  // runs `cases` seeded cases and returns the ones whose image URLs were not all migrated
  const failingCases = (flavor: Flavor, platform: string, seed: number, cases: number, maxUrls: number): string[] => {
    const failures: string[] = []
    for (let i = 0; i < cases; i++) {
      const urls = 1 + Math.floor(mulberry32(seed + i)() * maxUrls)
      const legacy = buildHistory(mulberry32(seed + i), flavor, urls, 'legacy')
      const expected = buildHistory(mulberry32(seed + i), flavor, urls, 'migrated')
      const migrated = migrateHistoryImagePaths(legacy, workspaceId, platform)
      if (migrated !== expected) {
        failures.push(`case ${i}: ${count(migrated, `workspaces${JSON.stringify(flavor.sep).slice(1, -1)}${workspaceId}`)} of ${urls} urls migrated`)
      }
    }
    return failures
  }

  test.each(['darwin', 'linux'])('fuzz: a message with one image is migrated on %s', (platform) => {
    expect(failingCases(posix, platform, 1000, 100, 1)).toEqual([])
  })

  test('fuzz: a message with one or several images is migrated on win32', () => {
    expect(failingCases(windows, 'win32', 2000, 100, 6)).toEqual([])
  })

  bug.each(['darwin', 'linux'])('fuzz: a message with several images has all of them migrated on %s', (platform) => {
    // the posix pattern starts with a greedy "file://(.*)" so only the last URL of a line is rewritten
    expect(failingCases(posix, platform, 3000, 100, 6)).toEqual([])
  })

  test.each([
    ['darwin', posix],
    ['linux', posix],
    ['win32', windows],
  ])('fuzz: a history without legacy image paths is left untouched on %s, so the migration can be run twice', (platform, flavor) => {
    const rand = mulberry32(4000)
    for (let i = 0; i < 50; i++) {
      const urls = platform === 'win32' ? 1 + Math.floor(rand() * 5) : 1
      const once = migrateHistoryImagePaths(buildHistory(rand, flavor, urls, 'legacy'), workspaceId, platform)
      expect(migrateHistoryImagePaths(once, workspaceId, platform)).toBe(once)
    }
    const other = JSON.stringify({ chats: [{ messages: [{ content: 'see file:///tmp/photo.png and https://example.com/images/a.png' }] }] }, null, 2)
    expect(migrateHistoryImagePaths(other, workspaceId, platform)).toBe(other)
  })

})

describe('workspaces on disk', () => {

  test('stress: 60 workspaces are saved, listed, loaded and deleted', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `ws-${String(i).padStart(2, '0')}`)
    for (const id of ids) {
      expect(saveWorkspace(app, { uuid: id, name: `Workspace ${id}`, icon: 'BIconBox', color: '#006edb', models: [], experts: [id], docrepos: [] })).toBe(true)
    }
    expect(listWorkspaces(app).map(ws => ws.uuid).sort()).toEqual(ids)
    for (const id of ids) {
      expect(loadWorkspace(app, id)).toMatchObject({ uuid: id, name: `Workspace ${id}`, experts: [id] })
    }
    for (const id of ids.slice(0, 30)) expect(deleteWorkspace(app, id)).toBe(true)
    expect(listWorkspaces(app).map(ws => ws.uuid).sort()).toEqual(ids.slice(30))
    expect(loadWorkspace(app, ids[0])).toBeNull()
  })

  test('fuzz: a workspace.json truncated at any point is skipped, the other workspaces are still listed', () => {
    const text = JSON.stringify({ uuid: 'broken', name: 'Broken', icon: 'BIconBox', color: '#006edb' }, null, 2)
    saveWorkspace(app, { uuid: 'good', name: 'Good' })
    for (let cut = 0; cut < text.length; cut += 3) {
      writeText(workspaceFile('broken'), text.slice(0, cut))
      expect(listWorkspaces(app).map(ws => ws.uuid), `cut at ${cut}`).toEqual(['good'])
      expect(loadWorkspace(app, 'broken')).toBeNull()
    }
  })

  test('stray files and empty folders in the workspaces folder are ignored', () => {
    saveWorkspace(app, { uuid: 'good', name: 'Good' })
    writeText(path.join(userData, 'workspaces', '.DS_Store'), 'x')
    writeText(path.join(userData, 'workspaces', 'workspace.json'), '{"uuid":"stray","name":"Stray"}')
    fs.mkdirSync(workspaceDir('empty'), { recursive: true })
    expect(listWorkspaces(app).map(ws => ws.uuid)).toEqual(['good'])
  })

  bug.each([
    ['{}'],
    ['[]'],
    ['42'],
    ['{"name":"No id"}'],
  ])('a workspace.json of the wrong shape is not listed as a workspace without an id: %s', (text) => {
    // fromJson copies whatever it finds, so the list holds an entry whose uuid is undefined
    saveWorkspace(app, { uuid: 'good', name: 'Good' })
    writeText(workspaceFile('odd'), text)
    expect(listWorkspaces(app).map(ws => ws.uuid)).toEqual(['good'])
  })

})

describe('initializeWorkspace', () => {

  const otherWorkspaceId = 'b0b5c1c2-0000-4000-8000-000000000002'

  const legacyHistory = (content: string) => JSON.stringify({
    version: 1,
    folders: [],
    chats: [{ uuid: 'chat-1', title: 'Legacy', messages: [{ role: 'user', content: 'draw' }, { role: 'assistant', content: content }] }],
    quickPrompts: [],
  }, null, 2)

  test('a new workspace is created once, and initializing it again keeps what the user changed', () => {
    initializeWorkspace(app, otherWorkspaceId)
    expect(loadWorkspace(app, otherWorkspaceId)).toMatchObject({ uuid: otherWorkspaceId, name: 'Workspace' })
    saveWorkspace(app, { uuid: otherWorkspaceId, name: 'Renamed', icon: 'BIconStar', color: '#ff0000' })
    for (let i = 0; i < 20; i++) initializeWorkspace(app, otherWorkspaceId)
    expect(loadWorkspace(app, otherWorkspaceId)).toMatchObject({ name: 'Renamed', icon: 'BIconStar', color: '#ff0000' })
  })

  test('a workspace other than the default one does not take over the legacy data', () => {
    writeText(path.join(userData, 'history.json'), legacyHistory('hello'))
    writeText(docrepoFile(), JSON.stringify([{ uuid: 'repo-1', name: 'Docs' }]))
    initializeWorkspace(app, otherWorkspaceId)
    expect(fs.existsSync(path.join(userData, 'history.json'))).toBe(true)
    expect(fs.existsSync(path.join(workspaceDir(otherWorkspaceId), 'history.json'))).toBe(false)
    expect(readJson(docrepoFile())).toEqual([{ uuid: 'repo-1', name: 'Docs' }])
  })

  test('the first run of the default workspace takes over the legacy history, images, agents and document repositories', () => {
    setPlatform('linux')
    writeText(path.join(userData, 'history.json'), legacyHistory('![cat](file:///home/me/.config/Witsy/images/cat.png)'))
    writeText(path.join(userData, 'images', 'cat.png'), 'png')
    writeText(path.join(userData, 'agents', 'agent-1.json'), '{}')
    writeText(docrepoFile(), JSON.stringify([{ uuid: 'repo-1', name: 'Docs' }, { uuid: 'repo-2' }]))
    initializeWorkspace(app, kDefaultWorkspaceId)
    const dir = workspaceDir(kDefaultWorkspaceId)
    expect(fs.existsSync(path.join(userData, 'history.json'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'images', 'cat.png'), 'utf-8')).toBe('png')
    expect(fs.existsSync(path.join(dir, 'agents', 'agent-1.json'))).toBe(true)
    expect(readJson(path.join(dir, 'history.json')).chats[0].messages[1].content).toBe(`![cat](file:///home/me/.config/Witsy/workspaces/${kDefaultWorkspaceId}/images/cat.png)`)
    expect(readJson(docrepoFile())).toEqual([
      { uuid: 'repo-1', name: 'Docs', workspaceId: kDefaultWorkspaceId },
      { uuid: 'repo-2', name: 'Collection 1', workspaceId: kDefaultWorkspaceId },
    ])
    expect(loadWorkspace(app, kDefaultWorkspaceId)).toMatchObject({ uuid: kDefaultWorkspaceId, name: 'MyWorkspace' })
  })

  test('starting again with a healthy default workspace changes nothing', () => {
    initializeWorkspace(app, kDefaultWorkspaceId)
    saveWorkspace(app, { uuid: kDefaultWorkspaceId, name: 'Home', icon: 'BIconStar', color: '#ff0000' })
    const repos = [{ uuid: 'repo-1', name: 'Docs', workspaceId: kDefaultWorkspaceId }, { uuid: 'repo-2', name: 'Work', workspaceId: otherWorkspaceId }]
    writeText(docrepoFile(), JSON.stringify(repos))
    for (let i = 0; i < 20; i++) initializeWorkspace(app, kDefaultWorkspaceId)
    expect(loadWorkspace(app, kDefaultWorkspaceId)).toMatchObject({ name: 'Home', icon: 'BIconStar', color: '#ff0000' })
    expect(readJson(docrepoFile())).toEqual(repos)
  })

  bug.each([
    ['truncated', '{"uuid":"00000000-0000-0000-0000-000000000000","name":"Ho'],
    ['empty', ''],
    ['null', 'null'],
  ])('a default workspace.json that is %s does not move the document repositories of other workspaces', (_, text) => {
    // an unreadable workspace.json makes the default workspace look new, so the one-time legacy migration runs again and claims every repository
    initializeWorkspace(app, kDefaultWorkspaceId)
    initializeWorkspace(app, otherWorkspaceId)
    const repos = [{ uuid: 'repo-1', name: 'Docs', workspaceId: kDefaultWorkspaceId }, { uuid: 'repo-2', name: 'Work', workspaceId: otherWorkspaceId }]
    writeText(docrepoFile(), JSON.stringify(repos))
    writeText(workspaceFile(kDefaultWorkspaceId), text)
    initializeWorkspace(app, kDefaultWorkspaceId)
    expect(readJson(docrepoFile()).map((repo: any) => repo.workspaceId)).toEqual([kDefaultWorkspaceId, otherWorkspaceId])
  })

  bug.each(['darwin', 'linux'])('the first run on %s migrates every image of a message that holds several', (platform) => {
    // greedy pattern of migrateHistoryImagePaths: the first image keeps pointing to the folder that was just moved away
    setPlatform(platform)
    const legacyDir = 'file:///Users/me/Library/Application Support/Witsy/images'
    writeText(path.join(userData, 'history.json'), legacyHistory(`![one](${legacyDir}/one.png) ![two](${legacyDir}/two.png)`))
    initializeWorkspace(app, kDefaultWorkspaceId)
    const content: string = readJson(path.join(workspaceDir(kDefaultWorkspaceId), 'history.json')).chats[0].messages[1].content
    expect(count(content, `/Witsy/workspaces/${kDefaultWorkspaceId}/images/`)).toBe(2)
  })

  bug.each([
    ['truncated', '[{"uuid":"repo-1","na'],
    ['not a list', '{"repos":[]}'],
    ['a list with a null entry', '[null]'],
  ])('a docrepo.json that is %s does not stop the image paths of the legacy history from being migrated', (_, text) => {
    // the document repositories are handled first and their error aborts the migration; it never runs again because the workspace now exists
    setPlatform('linux')
    writeText(path.join(userData, 'history.json'), legacyHistory('![cat](file:///home/me/.config/Witsy/images/cat.png)'))
    writeText(docrepoFile(), text)
    initializeWorkspace(app, kDefaultWorkspaceId)
    initializeWorkspace(app, kDefaultWorkspaceId)
    const content: string = readJson(path.join(workspaceDir(kDefaultWorkspaceId), 'history.json')).chats[0].messages[1].content
    expect(content).toBe(`![cat](file:///home/me/.config/Witsy/workspaces/${kDefaultWorkspaceId}/images/cat.png)`)
  })

})
