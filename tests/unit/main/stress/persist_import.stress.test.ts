
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app, dialog } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { History } from '@/types/index'
import { kHistoryVersion } from '@/consts'
import * as file from '@main/file'
import { importMarkdown, parseMarkdownChat } from '@main/import_md'
import { importOpenAI, importOpenAIConversations } from '@main/import_oai'
import { bug } from './bug'

let root: string
let userData: string

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(() => userData),
      getLocale: vi.fn(() => 'en-US'),
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
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

vi.mock('@main/windows/index', async () => {
  return { emitIpcEventToAll: vi.fn() }
})

vi.mock('@main/file', async () => {
  return { pickFile: vi.fn() }
})

// real locale messages (the role names of every language), but translations that echo their key
vi.mock('@main/i18n', async (importOriginal) => {
  const mod: any = await importOriginal()
  return { ...mod, useI18n: () => (key: string) => key }
})

// deterministic PRNG so a failing fuzz case can be replayed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const workspaceId = 'workspace-1'

const workspaceDir = () => path.join(userData, 'workspaces', workspaceId)
const historyFile = () => path.join(workspaceDir(), 'history.json')
const workspaceImages = () => path.join(workspaceDir(), 'images')
const legacyImages = () => path.join(userData, 'images')

const writeText = (target: string, text: string | Buffer): string => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return target
}

const readHistory = (): History => JSON.parse(fs.readFileSync(historyFile(), 'utf-8'))

const emptyHistory = (): History => ({ version: kHistoryVersion, folders: [], chats: [], quickPrompts: [] })

const filesUnder = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return []
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(full))
    else result.push(full)
  }
  return result
}

const dialogMessages = (): string[] => vi.mocked(dialog.showMessageBox).mock.calls.map(call => (call[0] as any).message)

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-import-'))
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

describe('markdown import', () => {

  type Turn = { role: 'system' | 'user' | 'assistant', content: string }

  const roleNames = { system: 'System', user: 'You', assistant: 'Assistant' }

  // same layout as the "export as markdown" action of the chat window
  const exportMarkdown = (title: string, turns: Turn[]): string => {
    let content = `# ${title}\n\n`
    for (const turn of turns) content += `## ${roleNames[turn.role]}\n\n${turn.content}\n\n`
    return content
  }

  const pick = (...contents: string[]): string[] => {
    const files = contents.map((content, i) => writeText(path.join(root, 'picked', `chat-${i}.md`), content))
    vi.mocked(file.pickFile).mockReturnValue(files)
    return files
  }

  const validChat = (i: number) => exportMarkdown(`Chat ${i}`, [{ role: 'user', content: `question ${i}` }, { role: 'assistant', content: `answer ${i}` }])

  test('fuzz: 150 exported chats are parsed back with the same roles and contents', () => {
    const rand = mulberry32(20261128)
    const words = ['alpha', 'beta', '# not a title', '### h3', '## Example', '```js', 'const a = 1', '```', '- item', '日本語，です！', 'emoji ❤️', '', '> quote', '|a|b|']
    const roles: Turn['role'][] = ['system', 'user', 'assistant']
    for (let i = 0; i < 150; i++) {
      const turns: Turn[] = []
      const count = 1 + Math.floor(rand() * 8)
      for (let t = 0; t < count; t++) {
        const lines: string[] = [`turn ${t}`]
        const lineCount = Math.floor(rand() * 6)
        for (let l = 0; l < lineCount; l++) lines.push(words[Math.floor(rand() * words.length)])
        lines.push('end')
        turns.push({ role: roles[Math.floor(rand() * 3)], content: lines.join('\n') })
      }
      const chat = parseMarkdownChat(app, exportMarkdown(`Title ${i}`, turns))
      expect(chat.title).toBe(`Title ${i}`)
      expect(chat.messages.map(message => ({ role: message.role, content: message.content })), `chat ${i}`).toEqual(turns)
    }
  })

  test('a single valid file picked from the chat window is returned and not saved', async () => {
    pick(validChat(1))
    const chat = await importMarkdown(app)
    expect(chat.title).toBe('Chat 1')
    expect(chat.messages.map(message => message.content)).toEqual(['question 1', 'answer 1'])
    expect(fs.existsSync(historyFile())).toBe(false)
  })

  test('stress: 40 files picked from the application menu are all saved to the workspace history', async () => {
    pick(...Array.from({ length: 40 }, (_, i) => validChat(i)))
    await importMarkdown(app, workspaceId)
    const history = readHistory()
    expect(history.chats.map(chat => chat.title)).toEqual(Array.from({ length: 40 }, (_, i) => `Chat ${i}`))
    expect(new Set(history.chats.map(chat => chat.uuid)).size).toBe(40)
    expect(dialogMessages()).toEqual(['chat.import.successMultiple'])
  })

  test('from the application menu, valid files are saved and invalid ones are listed', async () => {
    pick(validChat(1), 'just some notes', validChat(2))
    await importMarkdown(app, workspaceId)
    expect(readHistory().chats.map(chat => chat.title)).toEqual(['Chat 1', 'Chat 2'])
    expect(dialogMessages()).toEqual(['chat.import.partialSuccessTitle'])
    expect((vi.mocked(dialog.showMessageBox).mock.calls[0][0] as any).detail).toContain('chat-1.md')
  })

  bug.each([
    ['a markdown file that is not a chat export', '# Release notes\n\nSome text\n\n## Changes\n\n- one\n'],
    ['a file without any heading', 'just some notes'],
    ['a title without messages', '# Title only\n'],
    ['an empty file', ''],
  ])('picking %s from the chat window resolves to null instead of rejecting', async (_, content) => {
    // importSingleFile rethrows, and the IMPORT.MARKDOWN sendSync handler awaits it without a catch: the window stays frozen
    pick(content)
    await expect(importMarkdown(app)).resolves.toBeNull()
  })

  bug('picking a file that cannot be read from the chat window resolves to null instead of rejecting', async () => {
    // same rethrow as above, here for the ENOENT of fs.readFileSync
    vi.mocked(file.pickFile).mockReturnValue([path.join(root, 'picked', 'deleted-meanwhile.md')])
    await expect(importMarkdown(app)).resolves.toBeNull()
  })

  bug('several files picked from the chat window are not silently dropped', async () => {
    // the picker always allows multi-selection, but without a workspace id the parsed chats go nowhere: null, no dialog
    pick(validChat(1), validChat(2))
    const result = await importMarkdown(app)
    const dialogs = vi.mocked(dialog.showMessageBox).mock.calls.length
    expect({ result, dialogs }).not.toEqual({ result: null, dialogs: 0 })
  })

  bug('an import into a workspace whose history cannot be read is reported', async () => {
    // loadHistory returns null for a corrupt file: nothing is counted as success or error, so no dialog is shown at all
    writeText(historyFile(), '{"version":1,"folders":[],"chats":[{"uuid"')
    pick(validChat(1), validChat(2))
    await importMarkdown(app, workspaceId)
    expect(dialogMessages()).toHaveLength(1)
  })

  bug('an export saved with a UTF-8 byte order mark is imported', async () => {
    // the BOM stays in front of the "# " of the title line, which is then not recognised
    pick('\uFEFF' + validChat(1))
    const chat = await importMarkdown(app).catch((error: Error) => error)
    expect(chat).toMatchObject({ title: 'Chat 1' })
  })

  bug('a message holding a heading named like a role survives an export and import round trip', () => {
    // the export does not escape "## System" / "## You" / "## Assistant" lines inside a message, and the import splits on them
    const turns: Turn[] = [
      { role: 'user', content: 'describe the architecture' },
      { role: 'assistant', content: 'Here it is:\n\n## System\n\nThe system has two parts.\n\n## Assistant\n\nThe assistant part.' },
    ]
    const chat = parseMarkdownChat(app, exportMarkdown('Architecture', turns))
    expect(chat.messages.map(message => ({ role: message.role, content: message.content }))).toEqual(turns)
  })

})

describe('ChatGPT import', () => {

  const userId = 'user-abc'

  type Node = { role: string, parts?: any[], attachments?: any[], contentType?: string }

  // builds the "mapping" tree of a conversation of the ChatGPT export
  const conversation = (id: string, nodes: Node[], updateTime = 1700000100): any => {
    const mapping: any = { 'client-created-root': { id: 'client-created-root', message: null, parent: null, children: [`${id}-0`] } }
    nodes.forEach((node, i) => {
      mapping[`${id}-${i}`] = {
        id: `${id}-${i}`,
        parent: i === 0 ? 'client-created-root' : `${id}-${i - 1}`,
        children: i < nodes.length - 1 ? [`${id}-${i + 1}`] : [],
        message: {
          author: { role: node.role },
          create_time: 1700000000 + i,
          end_turn: true,
          recipient: 'all',
          content: { content_type: node.contentType ?? 'text', parts: node.parts ?? [''] },
          metadata: { ...(node.attachments ? { attachments: node.attachments } : {}), ...(node.role === 'assistant' ? { model_slug: 'gpt-4o' } : {}) },
        },
      }
    })
    return { id, title: `Conversation ${id}`, create_time: 1700000000, update_time: updateTime, mapping }
  }

  const textConversation = (id: string, question: string, answer: string, updateTime?: number) => conversation(id, [
    { role: 'system' },
    { role: 'user', parts: [question] },
    { role: 'assistant', parts: [answer] },
  ], updateTime)

  const imagePointer = (id: string, prompt?: string) => ({
    content_type: 'image_asset_pointer',
    asset_pointer: `file-service://${id}`,
    metadata: prompt ? { dalle: { prompt } } : {},
  })

  // conversations with every kind of image the export can hold
  const attachmentConversation = () => conversation('attachment', [
    { role: 'system' },
    { role: 'user', parts: ['what is this?'], attachments: [{ id: 'file-att1', name: 'photo.png', mime_type: 'image/png' }] },
    { role: 'assistant', parts: ['a photo'] },
  ])
  const pointerConversation = () => conversation('pointer', [
    { role: 'system' },
    { role: 'user', contentType: 'multimodal_text', parts: [imagePointer('file-ptr1'), 'and this?'] },
    { role: 'assistant', parts: ['a drawing'] },
  ])
  const dalleConversation = () => conversation('dalle', [
    { role: 'system' },
    { role: 'user', parts: ['draw a cat'] },
    { role: 'assistant', parts: ['here you go'] },
    { role: 'tool', contentType: 'multimodal_text', parts: [imagePointer('file-gen1', 'a cat')] },
  ])

  const exportDir = () => path.join(root, 'chatgpt-export')

  const writeExport = (conversations: any[]): string => {
    writeText(path.join(exportDir(), 'user.json'), JSON.stringify({ id: userId, email: 'me@example.com' }))
    writeText(path.join(exportDir(), 'file-att1-photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
    writeText(path.join(exportDir(), 'file-ptr1-drawing.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]))
    writeText(path.join(exportDir(), 'dalle-generations', 'file-gen1-cat.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46, 3]))
    return writeText(path.join(exportDir(), 'conversations.json'), JSON.stringify(conversations))
  }

  const runImport = async (conversations: any[]): Promise<History> => {
    vi.mocked(file.pickFile).mockReturnValue(writeExport(conversations))
    await importOpenAI(app, workspaceId)
    return fs.existsSync(historyFile()) ? readHistory() : emptyHistory()
  }

  const importText = async (text: string): Promise<string> => {
    const history = emptyHistory()
    const rc = await importOpenAIConversations(userId, [textConversation('c1', 'question', text)], history, exportDir(), workspaceImages())
    expect(rc).toBe(true)
    expect(history.chats).toHaveLength(1)
    return history.chats[0].messages[2].content
  }

  beforeEach(() => {
    fs.mkdirSync(exportDir(), { recursive: true })
  })

  describe('text', () => {

    test('stress: 300 conversations are imported in order into a ChatGPT folder', async () => {
      const conversations = Array.from({ length: 300 }, (_, i) => textConversation(`c${i}`, `question ${i}`, `answer ${i}`))
      const history = await runImport(conversations)
      expect(history.chats).toHaveLength(300)
      expect(history.chats.map(chat => chat.uuid)).toEqual(conversations.map(c => `openai-${c.id}`))
      expect(history.chats[299].messages.map(message => message.content)).toEqual(['', 'question 299', 'answer 299'])
      expect(history.folders).toHaveLength(1)
      expect(history.folders[0].chats).toHaveLength(300)
      expect(dialogMessages()).toEqual(['import.openai.success.title'])
    })

    test('importing the same export again does not duplicate chats, a newer conversation replaces the old one', async () => {
      const conversations = Array.from({ length: 20 }, (_, i) => textConversation(`c${i}`, `question ${i}`, `answer ${i}`))
      await runImport(conversations)
      await runImport(conversations)
      conversations[3] = textConversation('c3', 'question 3', 'a better answer', 1700009999)
      const history = await runImport(conversations)
      expect(history.chats).toHaveLength(20)
      expect(history.folders).toHaveLength(1)
      expect([...history.folders[0].chats].sort()).toEqual(history.chats.map(chat => chat.uuid).sort())
      expect(history.chats.find(chat => chat.uuid === 'openai-c3').messages[2].content).toBe('a better answer')
    })

    test('chats that were already in the history are kept', async () => {
      writeText(historyFile(), JSON.stringify({ ...emptyHistory(), chats: [{ uuid: 'mine', title: 'Mine', messages: [] }] }))
      const history = await runImport([textConversation('c1', 'question', 'answer')])
      expect(history.chats.map(chat => chat.uuid)).toEqual(['mine', 'openai-c1'])
    })

    test.each([
      ['not an array', { conversations: [] }],
      ['an empty array', []],
      ['an array of something else', [{ foo: 'bar' }]],
    ])('a conversations file holding %s is reported as an error and nothing is saved', async (_, data) => {
      vi.mocked(file.pickFile).mockReturnValue(writeExport(data as any))
      await importOpenAI(app, workspaceId)
      expect(dialogMessages()).toEqual(['import.openai.error.title'])
      expect(fs.existsSync(historyFile())).toBe(false)
    })

    test('fuzz: malformed conversations are skipped without losing the valid ones', async () => {
      const valid = (i: number) => textConversation(`ok${i}`, `question ${i}`, `answer ${i}`)
      const broken: any[] = [
        null, 42, 'text', [], {},
        { id: 'no-mapping', title: 'x' },
        { id: 'null-mapping', title: 'x', mapping: null },
        { id: 'empty-mapping', title: 'x', mapping: {} },
        { id: 'null-node', title: 'x', mapping: { 'client-created-root': { children: ['a'] }, a: null } },
        { id: 'dangling-child', title: 'x', mapping: { 'client-created-root': { children: ['missing'] } } },
        { id: 'bad-parts', title: 'x', mapping: { 'client-created-root': { children: ['a'] }, a: { id: 'a', message: { author: { role: 'user' }, content: { parts: 42 } } } } },
        { id: 'bad-pointer', title: 'x', mapping: { 'client-created-root': { children: ['a'] }, a: { id: 'a', message: { author: { role: 'user' }, content: { parts: [{ content_type: 'image_asset_pointer' }] } } } } },
        { title: 'no id', mapping: {} },
        { id: 'ephemeral', title: 'x', is_do_not_remember: true, mapping: textConversation('e', 'q', 'a').mapping },
      ]
      const data = [valid(0)]
      broken.forEach((item, i) => data.push(item, valid(i + 1)))
      const history = emptyHistory()
      expect(await importOpenAIConversations(userId, data, history, exportDir(), workspaceImages())).toBe(true)
      expect(history.chats.map(chat => chat.uuid)).toEqual(Array.from({ length: broken.length + 1 }, (_, i) => `openai-ok${i}`))
    })

  })

  describe('character filter', () => {

    const sample = (cp: number) => `a${String.fromCodePoint(cp)}b`

    const importCodePoints = async (codePoints: number[]): Promise<string[]> => {
      const text = await importText(codePoints.map(sample).join('\n'))
      return text.split('\n')
    }

    test('the private use characters ChatGPT uses as citation markers are removed', async () => {
      expect(await importText('Paris\uE200cite\uE202turn0search0\uE201 is nice\uF8FF.')).toBe('Parisciteturn0search0 is nice.')
      expect(await importCodePoints([0xE000, 0xE123, 0xE200, 0xE206, 0xF000, 0xF8FF])).toEqual(Array(6).fill('ab'))
    })

    test('fuzz: every code point below U+E000 and every astral code point is kept', async () => {
      const rand = mulberry32(57344)
      const codePoints = [0x20, 0x7E, 0xA0, 0xE9, 0x3001, 0x3002, 0x4E2D, 0xAC00, 0xD7FF, 0x10000, 0x1F600, 0x1F1EB, 0x20BB7, 0xF0000, 0x10FFFF]
      while (codePoints.length < 600) {
        const cp = rand() < 0.7 ? 0x20 + Math.floor(rand() * (0xD800 - 0x20)) : 0x10000 + Math.floor(rand() * 0x100000)
        codePoints.push(cp)
      }
      const imported = await importCodePoints(codePoints)
      const altered = codePoints.filter((cp, i) => imported[i] !== sample(cp)).map(cp => `U+${cp.toString(16).toUpperCase()}`)
      expect(altered).toEqual([])
    })

    bug.each([
      ['a fullwidth comma', '你好，世界', 0xFF0C],
      ['a fullwidth exclamation mark', '太好了！', 0xFF01],
      ['a fullwidth question mark', '本当ですか？', 0xFF1F],
      ['a fullwidth colon', '注意：重要', 0xFF1A],
      ['fullwidth parentheses', '東京（とうきょう）', 0xFF08],
      ['fullwidth digits', '２０２６年', 0xFF12],
      ['a fullwidth yen sign', '￥１００', 0xFFE5],
      ['halfwidth katakana', 'ｶﾀｶﾅ', 0xFF76],
      ['an emoji variation selector', 'I ❤️ this ⚠️', 0xFE0F],
      ['a keycap emoji', 'step 1️⃣', 0xFE0F],
      ['a latin ligature', 'ﬁnal ﬂow', 0xFB01],
      ['a CJK compatibility ideograph', '\uF900\uF901', 0xF900],
      ['an arabic presentation form', 'ﷺ', 0xFDFA],
      ['a small form variant', 'a﹐b', 0xFE50],
      ['a vertical form', '︵a︶', 0xFE35],
      ['a replacement character', 'bad byte \uFFFD here', 0xFFFD],
    ])('text with %s is imported unchanged', async (_, text, cp) => {
      // the filter keeps charCode < 57344 (0xE000): it removes the private use area and every assigned character above it
      expect(cp).toBeGreaterThan(0xF8FF)
      expect(text).toContain(String.fromCodePoint(cp))
      expect(await importText(text)).toBe(text)
    })

    bug('fuzz: no code point outside U+E000-U+F8FF is dropped', async () => {
      // everything from U+F900 to U+FFFF is dropped as well: CJK compatibility, presentation forms, half and full width forms
      const rand = mulberry32(63744)
      const codePoints = [0xF900, 0xFAFF, 0xFB00, 0xFE0F, 0xFE30, 0xFF01, 0xFF0C, 0xFFEE, 0xFFFD]
      while (codePoints.length < 300) codePoints.push(0xF900 + Math.floor(rand() * (0xFFFE - 0xF900)))
      const imported = await importCodePoints(codePoints)
      const dropped = codePoints.filter((cp, i) => imported[i] !== sample(cp))
      expect(dropped.length).toBe(0)
    })

  })

  describe('images', () => {

    test('with an images folder that exists, all three kinds of image are imported', async () => {
      writeExport([])
      fs.mkdirSync(workspaceImages(), { recursive: true })
      const history = emptyHistory()
      const data = [attachmentConversation(), pointerConversation(), dalleConversation()]
      expect(await importOpenAIConversations(userId, data, history, exportDir(), workspaceImages())).toBe(true)
      expect(history.chats.map(chat => chat.uuid)).toEqual(['openai-attachment', 'openai-pointer', 'openai-dalle'])
      expect(history.chats[0].messages[1].attachments.map(a => a.url)).toEqual([`file://${path.join(workspaceImages(), 'file-att1-photo.png')}`])
      expect(history.chats[1].messages[1].attachments.map(a => a.url)).toEqual([`file://${path.join(workspaceImages(), 'file-ptr1-drawing.png')}`])
      expect(history.chats[2].messages[2].content).toContain(`![a cat](file://${path.join(workspaceImages(), 'file-gen1-cat.webp')})`)
      expect(fs.readdirSync(workspaceImages()).sort()).toEqual(['file-att1-photo.png', 'file-gen1-cat.webp', 'file-ptr1-drawing.png'])
      expect([...fs.readFileSync(path.join(workspaceImages(), 'file-gen1-cat.webp'))]).toEqual([0x52, 0x49, 0x46, 0x46, 3])
    })

    test('an image the export does not contain is skipped, the conversation is kept', async () => {
      writeExport([])
      fs.mkdirSync(workspaceImages(), { recursive: true })
      const history = emptyHistory()
      const missing = conversation('missing', [
        { role: 'system' },
        { role: 'user', parts: ['what is this?'], attachments: [{ id: 'file-gone', name: 'gone.png', mime_type: 'image/png' }] },
        { role: 'assistant', parts: ['no idea'] },
      ])
      expect(await importOpenAIConversations(userId, [missing], history, exportDir(), workspaceImages())).toBe(true)
      expect(history.chats).toHaveLength(1)
      expect(history.chats[0].messages[1].attachments).toEqual([])
    })

    bug.each([
      ['an uploaded image referenced from the text', pointerConversation, 'openai-pointer'],
      ['a generated image', dalleConversation, 'openai-dalle'],
    ])('a conversation with %s is not lost when the image cannot be copied', async (_, build, uuid) => {
      // the copy error (here: target folder missing) is thrown up to the per-conversation catch, which skips the conversation and still returns true
      writeExport([])
      const history = emptyHistory()
      const rc = await importOpenAIConversations(userId, [build()], history, exportDir(), path.join(root, 'missing', 'images'))
      expect({ rc, chats: history.chats.map(chat => chat.uuid) }).not.toEqual({ rc: true, chats: [] })
      expect(rc === false || history.chats[0].uuid === uuid).toBe(true)
    })

    bug.each([
      ['an uploaded image referenced from the text', pointerConversation, 'openai-pointer'],
      ['a generated image', dalleConversation, 'openai-dalle'],
    ])('importOpenAI on a current install keeps a conversation with %s', async (_, build, uuid) => {
      // images are written to <userData>/images, the pre-workspace folder that no longer exists: ENOENT, conversation skipped, success dialog shown
      const history = await runImport([textConversation('c1', 'question', 'answer'), build()])
      expect(dialogMessages()).toEqual(['import.openai.success.title'])
      expect(history.chats.map(chat => chat.uuid)).toEqual(['openai-c1', uuid])
    })

    bug('importOpenAI on a current install keeps the attachments of a message', async () => {
      // same ENOENT on <userData>/images, swallowed per attachment: the conversation is imported without its image
      const history = await runImport([attachmentConversation()])
      expect(history.chats).toHaveLength(1)
      expect(history.chats[0].messages[1].attachments).toHaveLength(1)
    })

    bug('importOpenAI stores images in the images folder of the workspace', async () => {
      // even when the legacy <userData>/images folder is still there, it is not the folder of the workspace (not listed with its attachments, not removed with it)
      fs.mkdirSync(legacyImages(), { recursive: true })
      fs.mkdirSync(workspaceImages(), { recursive: true })
      const history = await runImport([attachmentConversation(), pointerConversation(), dalleConversation()])
      expect(history.chats).toHaveLength(3)
      expect({ legacy: filesUnder(legacyImages()).length, workspace: filesUnder(workspaceImages()).length }).toEqual({ legacy: 0, workspace: 3 })
    })

  })

})
