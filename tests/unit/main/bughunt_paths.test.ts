import { afterEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import CliPlugin from '@main/cli_plugin'
import { extractAttachmentsFromHistory } from '@main/history'
import { analyzeCommand, validateWorkingDirectory } from '@main/shell'
import Chat from '@models/chat'
import Message from '@models/message'

const temps: string[] = []

const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-bughunt-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('cli working directory boundary', () => {

  test('allows children and rejects paths that normalize outside', () => {
    const root = makeDir()
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello')
    const plugin = new CliPlugin({ workDirPath: root, workDirAccess: 'rw' })
    expect(plugin.validatePath(path.join(root, 'note.txt'))).toBe(path.join(root, 'note.txt'))
    expect(plugin.validatePath('note.txt')).toBe(path.normalize(path.join(root, 'note.txt')))
    expect(plugin.validatePath(path.join(root, '..', path.basename(root), '..'))).toBeNull()
    expect(plugin.validatePath(path.resolve(root, '..', 'definitely-outside'))).toBeNull()
  })

  test('does not throw for odd relative inputs', () => {
    const root = makeDir()
    const plugin = new CliPlugin({ workDirPath: root, workDirAccess: 'ro' })
    const samples = ['', '.', '..', '../..', '/', 'foo/../../bar', 'a'.repeat(2000), 'nul', 'CON', 'foo bar/baz']
    for (const sample of samples) {
      expect(() => plugin.validatePath(sample)).not.toThrow()
    }
  })

})

describe('shell working directory and command analysis', () => {

  test('realpath keeps a symlink to an outside directory out of the project', () => {
    const root = makeDir()
    const outside = makeDir()
    const link = path.join(root, 'escape')
    fs.symlinkSync(outside, link)
    const result = validateWorkingDirectory(link, root)
    expect(result.valid).toBe(false)
    expect(validateWorkingDirectory(root, root).valid).toBe(true)
  })

  test('analyzeCommand stays total on random and known inputs', () => {
    const samples = [
      'echo hello',
      'ls -la',
      'cat format.txt',
      'rm -rf /tmp/nope',
      'dd if=/dev/zero of=/dev/null',
      '',
      'a'.repeat(5000),
      'echo $HOME && true',
      'python -c "print(1)"',
      'Get-ChildItem',
      'format C:',
    ]
    for (let i = 0; i < 40; i++) {
      samples.push(`echo token-${i}`)
    }
    for (const command of samples) {
      const analysis = analyzeCommand(command, '/tmp/project')
      expect(analysis).toMatchObject({
        isDangerous: expect.any(Boolean),
        dangersDetected: expect.any(Array),
        hasForbiddenOperators: false,
      })
    }
    expect(analyzeCommand('echo hello', '/tmp/project').isDangerous).toBe(false)
    expect(analyzeCommand('rm -rf /', '/tmp/project').isDangerous).toBe(true)
    expect(analyzeCommand('rm -rf /', '/tmp/project').blockedCommand).toBe('rm')
  })

})

describe('history attachment extraction edges', () => {

  const chatWith = (content: string) => {
    const chat = new Chat()
    chat.addMessage(new Message('user', content))
    return chat
  }

  test('returns filenames for posix file urls and does not throw on windows-shaped roots', () => {
    const imagesPath = '/home/user/images'
    const chat = new Chat()
    chat.addMessage(new Message('user', `see (file://${imagesPath}/shot.png)`))
    chat.addMessage(new Message('user', `file://${imagesPath}/plain.txt`))
    const chats = [chat]
    const found = extractAttachmentsFromHistory(chats, imagesPath)
    expect(found).toContain('shot.png')
    expect(found).toContain('plain.txt')

    const windowsRoots = [
      'C:\\Users\\me\\images',
      'C:\\Users\\me\\My Images',
      'D:\\data\\images',
      '\\\\server\\share\\images',
    ]
    for (const root of windowsRoots) {
      expect(() => extractAttachmentsFromHistory([chatWith('no files here')], root)).not.toThrow()
    }
  })

  test('ignores chats with empty content and missing attachment lists', () => {
    const chat = new Chat()
    const message = new Message('assistant', '')
    message.attachments = undefined as any
    chat.addMessage(message)
    expect(extractAttachmentsFromHistory([chat], '/tmp/images')).toEqual([])
  })

})
