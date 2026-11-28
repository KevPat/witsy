
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { History } from '@/types/index'
import { kHistoryVersion } from '@/consts'
import { loadHistory, saveHistory } from '@main/history'
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

const workspaceId = 'workspace-1'

const historyFile = () => path.join(userData, 'workspaces', workspaceId, 'history.json')

const writeHistoryText = (text: string) => {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true })
  fs.writeFileSync(historyFile(), text)
}

const readHistoryText = (): string => fs.readFileSync(historyFile(), 'utf-8')

const chat = (i: number): any => ({
  uuid: `chat-${i}`,
  title: `Chat ${i} – 日本語 ❤️`,
  createdAt: 1700000000000 + i,
  lastModified: 1700000000000 + i,
  messages: [
    { uuid: `m-${i}-0`, role: 'system', content: 'You are helpful' },
    { uuid: `m-${i}-1`, role: 'user', content: `question ${i}\nwith "quotes" and \\ backslashes` },
    { uuid: `m-${i}-2`, role: 'assistant', content: `answer ${i}` },
  ],
})

const history = (chats: number): History => ({
  version: kHistoryVersion,
  folders: [{ id: 'folder-1', name: 'Folder', chats: chats > 0 ? ['chat-0'] : [] }],
  chats: Array.from({ length: chats }, (_, i) => chat(i)),
  quickPrompts: ['hello'],
})

// what the chat window sends on its next save: the version it got from the last load, and the chats it holds
const saveLikeTheChatWindow = (loaded: History | null, chats: any[]) => {
  saveHistory(app, workspaceId, { version: loaded?.version, folders: loaded?.folders ?? [], chats: chats, quickPrompts: loaded?.quickPrompts ?? [] } as History)
}

// true if a file under dir holds the given text
const isOnDisk = (dir: string, text: string): boolean => {
  if (!fs.existsSync(dir)) return false
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isOnDisk(full, text)) return true
    } else if (fs.readFileSync(full, 'utf-8').includes(text)) {
      return true
    }
  }
  return false
}

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-history-'))
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

describe('history.json', () => {

  test('a workspace without history loads an empty history and does not create the file', async () => {
    expect(await loadHistory(app, workspaceId)).toEqual({ version: kHistoryVersion, folders: [], chats: [], quickPrompts: [] })
    expect(fs.existsSync(historyFile())).toBe(false)
  })

  test('stress: 25 save and reload cycles of a growing history return exactly what was saved', async () => {
    for (let i = 0; i < 25; i++) {
      const saved = history(i * 3)
      saveHistory(app, workspaceId, saved)
      expect(await loadHistory(app, workspaceId)).toEqual(saved)
    }
    expect((await loadHistory(app, workspaceId)).chats).toHaveLength(72)
  })

  test('two workspaces do not see each other\'s history', async () => {
    saveHistory(app, workspaceId, history(2))
    saveHistory(app, 'workspace-2', history(5))
    expect((await loadHistory(app, workspaceId)).chats).toHaveLength(2)
    expect((await loadHistory(app, 'workspace-2')).chats).toHaveLength(5)
    expect((await loadHistory(app, 'workspace-3')).chats).toHaveLength(0)
  })

  test('the legacy format, a plain list of chats, is still loaded', async () => {
    writeHistoryText(JSON.stringify([chat(0), chat(1)]))
    const loaded = await loadHistory(app, workspaceId)
    expect(loaded.version).toBe(kHistoryVersion)
    expect(loaded.chats.map(c => c.uuid)).toEqual(['chat-0', 'chat-1'])
  })

  test('a history written by a newer version is neither shown nor overwritten', async () => {
    const text = JSON.stringify({ ...history(3), version: kHistoryVersion + 1 }, null, 2)
    writeHistoryText(text)
    const loaded = await loadHistory(app, workspaceId)
    expect(loaded).toEqual({ version: kHistoryVersion + 1, folders: [], chats: [], quickPrompts: [] })
    saveLikeTheChatWindow(loaded, [chat(99)])
    expect(readHistoryText()).toBe(text)
  })

  test('fuzz: a history truncated at any point never throws and is never overwritten by the next save', async () => {
    const text = JSON.stringify(history(3), null, 2)
    for (let cut = 0; cut < text.length; cut += 37) {
      const truncated = text.slice(0, cut)
      writeHistoryText(truncated)
      const loaded = await loadHistory(app, workspaceId)
      expect(loaded, `cut at ${cut}`).toBeNull()
      saveLikeTheChatWindow(loaded, [chat(99)])
      expect(readHistoryText()).toBe(truncated)
    }
  })

  test.each([
    ['null'],
    ['42'],
    ['"text"'],
    ['{}'],
    ['{"version":1,"folders":{},"chats":[]}'],
    ['{"version":1,"folders":[null],"chats":[]}'],
  ])('valid JSON of the wrong shape never throws: %s', async (text) => {
    writeHistoryText(text)
    await expect(loadHistory(app, workspaceId)).resolves.toBeNull()
    expect(readHistoryText()).toBe(text)
  })

  bug('chats created after a truncated history failed to load are saved somewhere', async () => {
    // the load returns null, the chat window then keeps an undefined version, and saveHistory silently returns for any version but the current one
    const text = JSON.stringify(history(3), null, 2)
    writeHistoryText(text.slice(0, Math.floor(text.length / 2)))
    const loaded = await loadHistory(app, workspaceId)
    const created = chat(99)
    created.title = 'Written after the failed load'
    saveLikeTheChatWindow(loaded, [created])
    expect(isOnDisk(userData, 'Written after the failed load')).toBe(true)
  })

  bug.each([
    ['without folders', { version: 1, chats: [chat(0)] }],
    ['without folders and version', { chats: [chat(0)] }],
    ['with null folders', { version: 1, folders: null, chats: [chat(0)], quickPrompts: [] }],
  ])('a history %s still loads its chats', async (_, data) => {
    // the backwards compatibility loops iterate history.folders unguarded; the TypeError is caught and the whole history is given up
    writeHistoryText(JSON.stringify(data))
    expect(await loadHistory(app, workspaceId)).toMatchObject({ chats: [{ uuid: 'chat-0' }] })
  })

  bug('an interrupted save leaves the previous history readable', async () => {
    // history.json is rewritten in place; a crash or a full disk mid-write leaves a truncated file, and the previous chats are gone
    saveHistory(app, workspaceId, history(5))
    const realWrite = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file: any, data: any, ...args: any[]) => {
      if (typeof file === 'string' && path.basename(file) === 'history.json') {
        realWrite(file, data.slice(0, Math.floor(data.length / 2)), ...args)
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return realWrite(file, data, ...args)
    })
    saveHistory(app, workspaceId, history(6))
    vi.mocked(fs.writeFileSync).mockRestore()
    const loaded = await loadHistory(app, workspaceId)
    expect(loaded).not.toBeNull()
    expect([5, 6]).toContain(loaded.chats.length)
  })

})
