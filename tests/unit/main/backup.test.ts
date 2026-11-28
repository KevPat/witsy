import { vi, beforeEach, expect, test, describe } from 'vitest'
import { app, dialog } from 'electron'
import * as backup from '@main/backup'
import * as file from '@main/file'
import * as config from '@main/config'
import * as commands from '@main/commands'
import { writeFileAtomicSync } from '@main/atomic'
import defaultSettings from '@root/defaults/settings.json'
import fs from 'fs'
import { ZipArchive } from 'archiver'
import extractZip from 'extract-zip'

// Mock all dependencies
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/userdata'),
    getLocale: vi.fn(() => 'en-US'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((data) => `encrypted-${data}`),
    decryptString: vi.fn((data) => data.toString('latin1'))
  },
  dialog: {
    showMessageBox: vi.fn()
  }
}))

vi.mock('@main/file', () => ({
  pickDirectory: vi.fn(),
  pickFile: vi.fn()
}))

vi.mock('@main/config', () => ({
  settingsFilePath: vi.fn(() => '/mock/userdata/settings.json'),
  apiKeysFilePath: vi.fn(() => '/mock/userdata/apiKeys.json'),
  loadSettings: vi.fn(() => defaultSettings),
  loadApiKeys: vi.fn(() => []),
  extractApiKeys: vi.fn(() => []),
}))

// the restored settings are written through the atomic writer, which would not go through the mocked fs
vi.mock('@main/atomic', () => ({
  writeFileAtomicSync: vi.fn(),
}))

vi.mock('@main/history', () => ({
  historyFilePath: vi.fn(() => '/mock/userdata/history.json')
}))

vi.mock('@main/experts', () => ({
  expertsFilePath: vi.fn(() => '/mock/userdata/experts.json')
}))

vi.mock('@main/commands', () => ({
  commandsFilePath: vi.fn(() => '/mock/userdata/commands.json')
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    createWriteStream: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    // the files of a backup are parsed before anything is restored
    readFileSync: vi.fn((path: string) => String(path).endsWith('commands.json') ? '[]' : '{}'),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn((path, opts) => 
      opts?.withFileTypes ? [ { name: 'file1.jpg', isDirectory: () => false }, { name: 'file2.png', isDirectory: () => false } ] : [ 'file1.jpg', 'file2.png' ]),
    rmSync: vi.fn()
  }
}))

vi.mock('archiver', () => ({
  ZipArchive: vi.fn()
}))

vi.mock('extract-zip', () => ({
  default: vi.fn()
}))

describe('Backup functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // (clearAllMocks keeps the implementations a test installed)
    vi.mocked(fs.readFileSync).mockImplementation(((path: string) => String(path).endsWith('commands.json') ? '[]' : '{}') as any)
    vi.mocked(config.extractApiKeys).mockReturnValue([])
    vi.mocked(config.loadApiKeys).mockReturnValue([])
  })

  describe('exportBackup', () => {
    test('should return false when no directory selected', async () => {
      vi.mocked(file.pickDirectory).mockReturnValue(null)

      const result = await backup.exportBackup(app)

      expect(result).toBe(false)
      expect(file.pickDirectory).toHaveBeenCalledWith(app)
    })

    const mockExport = () => {
      vi.mocked(file.pickDirectory).mockReturnValue('/mock/export/dir')

      const mockArchive = {
        on: vi.fn(),
        pipe: vi.fn(),
        file: vi.fn(),
        append: vi.fn(),
        directory: vi.fn(),
        finalize: vi.fn(),
        pointer: vi.fn(() => 1024)
      }

      vi.mocked(ZipArchive).mockImplementation(function () { return mockArchive } as any)

      const mockOutput = {
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(callback, 10)
          }
        })
      }

      vi.mocked(fs.createWriteStream).mockReturnValue(mockOutput as any)
      return mockArchive
    }

    test('should call all filepath functions', async () => {
      const mockArchive = mockExport()

      const result = await backup.exportBackup(app)

      expect(result).toBe(true)
      expect(config.settingsFilePath).toHaveBeenCalledWith(app)
      // expect(history.historyFilePath).toHaveBeenCalledWith(app)
      // expect(experts.expertsFilePath).toHaveBeenCalledWith(app)
      expect(commands.commandsFilePath).toHaveBeenCalledWith(app)
      expect(mockArchive.file).toHaveBeenCalledTimes(1)
      expect(mockArchive.file).toHaveBeenCalledWith('/mock/userdata/commands.json', { name: 'commands.json' })
      expect(mockArchive.directory).toHaveBeenCalledTimes(2)
      expect(mockArchive.finalize).toHaveBeenCalled()
    })

    test('should never add the key store, and add the settings as a copy without keys', async () => {
      const mockArchive = mockExport()
      vi.mocked(fs.readFileSync).mockImplementation(((path: string) => {
        if (String(path).endsWith('settings.json')) return JSON.stringify({ general: { locale: 'fr' }, engines: { openai: { apiKey: 'FAKE-KEY-not-a-real-secret', model: { chat: 'gpt-x' } } } })
        return String(path).endsWith('commands.json') ? '[]' : '{}'
      }) as any)

      expect(await backup.exportBackup(app)).toBe(true)

      // no entry is the key store, whatever the way it would be added
      const names = [
        ...mockArchive.file.mock.calls.map((call) => call[1].name),
        ...mockArchive.append.mock.calls.map((call) => call[1].name),
      ]
      expect(names.sort()).toEqual(['commands.json', 'settings.json'])
      expect(mockArchive.file.mock.calls.map((call) => call[0])).not.toContain('/mock/userdata/apiKeys.json')
      expect(config.apiKeysFilePath).not.toHaveBeenCalled()

      // the settings are not added as a file
      expect(mockArchive.file.mock.calls.map((call) => call[0])).not.toContain('/mock/userdata/settings.json')
      const [content] = mockArchive.append.mock.calls.find((call) => call[1].name === 'settings.json')
      expect(content).not.toContain('FAKE-KEY')
      expect(JSON.parse(content)).toEqual({ general: { locale: 'fr' }, engines: { openai: { apiKey: '', model: { chat: 'gpt-x' } } } })
    })

    test('should leave out settings that cannot be parsed instead of adding them as they are', async () => {
      const mockArchive = mockExport()
      vi.mocked(fs.readFileSync).mockImplementation(((path: string) => {
        return String(path).endsWith('settings.json') ? '{"engines":{"openai":{"apiKey":"FAKE-KEY-not-a-real-secret"' : '[]'
      }) as any)

      expect(await backup.exportBackup(app)).toBe(true)
      expect(mockArchive.append).not.toHaveBeenCalled()
      expect(mockArchive.file.mock.calls.map((call) => call[1].name)).toEqual(['commands.json'])
    })

    test('should skip the files of the workspaces that can hold a token when folders are added', async () => {
      const mockArchive = mockExport()
      expect(await backup.exportBackup(app)).toBe(true)
      const [, name, filter] = mockArchive.directory.mock.calls.find((call) => call[1] === 'workspaces')
      expect(name).toBe('workspaces')
      expect(filter({ name: 'w1/workspace.json' })).toBe(false)
      expect(filter({ name: 'w1/agents/agent-1.json' })).toBe(false)
      expect(filter({ name: 'w1\\agents\\agent-1.json' })).toBe(false)
      expect(filter({ name: 'w1/agents/agent-1/run-1.json' })).toEqual({ name: 'w1/agents/agent-1/run-1.json' })
      expect(filter({ name: 'w1/history.json' })).toEqual({ name: 'w1/history.json' })
      expect(filter({ name: 'w1/images/picture.png' })).toEqual({ name: 'w1/images/picture.png' })
      const [, , enginesFilter] = mockArchive.directory.mock.calls.find((call) => call[1] === 'engines')
      expect(enginesFilter({ name: 'w1/workspace.json' })).toEqual({ name: 'w1/workspace.json' })
    })

    test('should tell that the backup holds no API key once it is created', async () => {
      mockExport()
      expect(await backup.exportBackup(app)).toBe(true)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
      expect(dialog.showMessageBox).toHaveBeenCalledWith({
        type: 'info',
        title: 'Backup Created',
        message: expect.stringMatching(/^Your data and settings have been saved to witsy-backup-\d{4}-\d{2}-\d{2}\.zip\.$/),
        detail: expect.stringContaining('API keys, tokens and passwords are never written to a backup'),
        buttons: ['OK']
      })
    })

    test('should still report the backup when the message cannot be shown', async () => {
      mockExport()
      vi.mocked(dialog.showMessageBox).mockRejectedValueOnce(new Error('no window'))
      expect(await backup.exportBackup(app)).toBe(true)
    })

    test('should handle general errors gracefully', async () => {
      vi.mocked(file.pickDirectory).mockReturnValue('/mock/export/dir')
      
      // Mock archiver to throw an error
      vi.mocked(ZipArchive).mockImplementation(function () {
        throw new Error('Archiver creation failed')
      })

      const result = await backup.exportBackup(app)

      expect(result).toBe(false)
    })
  })

  describe('importBackup', () => {

    test('should return false when user cancels confirmation', async () => {
      vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0 } as any)
      const result = await backup.importBackup(app, vi.fn())
      expect(result).toBe(false)
      expect(dialog.showMessageBox).toHaveBeenCalled()
      expect(file.pickFile).not.toHaveBeenCalled()
    })

    test('should return false when no backup file selected', async () => {
      vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1 } as any)
      vi.mocked(file.pickFile).mockReturnValue(null)
      const result = await backup.importBackup(app, vi.fn())
      expect(result).toBe(false)
      expect(file.pickFile).toHaveBeenCalledWith(app, {
        location: true,
        filters: [{ name: 'Backup files', extensions: ['zip'] }]
      })
    })

    test('should call extractZip with correct parameters', async () => {
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1 } as any)
        .mockResolvedValueOnce({ response: 0 } as any)
      vi.mocked(file.pickFile).mockReturnValue('/mock/backup.zip')
      vi.mocked(extractZip).mockResolvedValue(undefined)

      const result = await backup.importBackup(app, vi.fn())

      expect(result).toBe(true)
      expect(extractZip).toHaveBeenCalledWith('/mock/backup.zip', {
        dir: expect.stringContaining('witsy-restore-'),
        skipSymlinks: true,
      })
    })

    test('should handle extraction errors', async () => {
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1 } as any)
        .mockResolvedValueOnce({ response: 0 } as any)
      vi.mocked(file.pickFile).mockReturnValue('/mock/backup.zip')
      vi.mocked(extractZip).mockRejectedValue(new Error('Extraction failed'))

      const result = await backup.importBackup(app, vi.fn())

      expect(result).toBe(false)
      expect(dialog.showMessageBox).toHaveBeenNthCalledWith(2, {
        type: 'error',
        title: 'Restore Failed',
        message: 'Failed to restore settings from backup.',
        detail: 'Error: Extraction failed',
        buttons: ['OK']
      })
    })

    test('should use filepath functions for restoration', async () => {
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1 } as any)
        .mockResolvedValueOnce({ response: 0 } as any)
      vi.mocked(file.pickFile).mockReturnValue('/mock/backup.zip')
      vi.mocked(extractZip).mockResolvedValue(undefined)

      const result = await backup.importBackup(app, vi.fn())

      expect(result).toBe(true)
      expect(config.settingsFilePath).toHaveBeenCalledWith(app)
      // expect(history.historyFilePath).toHaveBeenCalledWith(app)
      // expect(experts.expertsFilePath).toHaveBeenCalledWith(app)
      expect(commands.commandsFilePath).toHaveBeenCalledWith(app)
    })

    test('should clean up temporary directory', async () => {
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1 } as any)
        .mockResolvedValueOnce({ response: 0 } as any)
      vi.mocked(file.pickFile).mockReturnValue('/mock/backup.zip')
      vi.mocked(extractZip).mockResolvedValue(undefined)

      const result = await backup.importBackup(app, vi.fn())

      expect(result).toBe(true)
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('witsy-restore-'),
        { recursive: true, force: true }
      )
    })

    test('should restart app', async () => {
      const mockQuitApp = vi.fn()
      const mockRelaunch = vi.fn()
      vi.mocked(app).relaunch = mockRelaunch
      
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1 } as any)
        .mockResolvedValueOnce({ response: 0 } as any)
      vi.mocked(file.pickFile).mockReturnValue('/mock/backup.zip')
      vi.mocked(extractZip).mockResolvedValue(undefined)

      const result = await backup.importBackup(app, mockQuitApp)

      expect(result).toBe(true)
      expect(mockRelaunch).toHaveBeenCalled()
      expect(mockQuitApp).toHaveBeenCalled()
    })

    const mockRestore = () => {
      vi.mocked(dialog.showMessageBox)
        .mockResolvedValueOnce({ response: 1 } as any)
        .mockResolvedValueOnce({ response: 0 } as any)
      vi.mocked(file.pickFile).mockReturnValue('/mock/backup.zip')
      vi.mocked(extractZip).mockResolvedValue(undefined)
    }

    test('should never copy a key store found in the backup', async () => {
      mockRestore()

      // every file "exists" in this test, the apiKeys.json of an older backup included
      expect(await backup.importBackup(app, vi.fn())).toBe(true)

      const copies = vi.mocked(fs.copyFileSync).mock.calls.map((call) => [String(call[0]), String(call[1])])
      expect(copies.some(([source, target]) => source.includes('apiKeys') || target.includes('apiKeys'))).toBe(false)
      expect(copies.some(([, target]) => target === '/mock/userdata/commands.json')).toBe(true)
      expect(config.apiKeysFilePath).not.toHaveBeenCalled()
    })

    test('should restore the settings without the keys of the backup and with the keys of this computer', async () => {
      mockRestore()
      vi.mocked(fs.readFileSync).mockImplementation(((path: string) => {
        const name = String(path).replace(/\\/g, '/')
        if (name === '/mock/userdata/settings.json') {
          return JSON.stringify({ general: { safeKeys: false }, engines: { openai: { apiKey: 'LOCAL-KEY-not-a-real-secret' } } })
        } else if (name.endsWith('settings.json')) {
          return JSON.stringify({ general: { locale: 'fr', safeKeys: true }, engines: { openai: { apiKey: 'BACKUP-KEY-not-a-real-secret', model: { chat: 'gpt-x' } }, groq: { apiKey: 'BACKUP-KEY-2-not-a-real-secret' } } })
        }
        return name.endsWith('commands.json') ? '[]' : '{}'
      }) as any)
      vi.mocked(config.extractApiKeys).mockReturnValue([{ name: 'engines.openai.apiKey', apiKey: 'LOCAL-KEY-not-a-real-secret' }])

      expect(await backup.importBackup(app, vi.fn())).toBe(true)

      // the settings are never copied as they are
      const copies = vi.mocked(fs.copyFileSync).mock.calls.map((call) => String(call[1]))
      expect(copies).not.toContain('/mock/userdata/settings.json')

      expect(writeFileAtomicSync).toHaveBeenCalledTimes(1)
      const [target, content] = vi.mocked(writeFileAtomicSync).mock.calls[0]
      expect(target).toBe('/mock/userdata/settings.json')
      expect(content).not.toContain('BACKUP-KEY')
      expect(JSON.parse(content as string)).toEqual({
        general: { locale: 'fr', safeKeys: false },
        engines: { openai: { apiKey: 'LOCAL-KEY-not-a-real-secret', model: { chat: 'gpt-x' } }, groq: { apiKey: '' } },
      })
    })

    test('should say before and after the restore that API keys are not part of a backup', async () => {
      mockRestore()

      expect(await backup.importBackup(app, vi.fn())).toBe(true)

      const [confirmation, done] = vi.mocked(dialog.showMessageBox).mock.calls.map((call) => call[0] as any)
      expect(confirmation.type).toBe('warning')
      expect(confirmation.detail).toContain('This will overwrite your current settings')
      expect(confirmation.detail).toContain('API keys, tokens and passwords are not part of a backup and are never restored')
      expect(confirmation.detail).toContain('The API keys stored on this computer are kept')
      expect(done.type).toBe('info')
      expect(done.detail).toContain('API keys, tokens and passwords are not part of a backup')
      expect(done.detail).toContain('The API keys that were on this computer have been kept')
      expect(done.detail).toContain('On a new computer, enter your keys again in Settings')
      expect(done.detail).toContain('The application will now restart')
    })

  })
})