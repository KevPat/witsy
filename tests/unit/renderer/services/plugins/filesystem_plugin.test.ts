import { vi, afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isReactive, reactive } from 'vue'
import { useWindowMock } from '@tests/mocks/window'
import { store } from '@services/store'
import FilesystemPlugin from '@services/plugins/filesystem'
import { resolveAllowedPath } from '@main/path_containment'
import { PluginExecutionContext } from 'multi-llm-ts'
import Dialog from '@renderer/utils/dialog'
import { ListDirectoryResponse } from 'types/filesystem'

global.atob = (str: string) => str

const context: PluginExecutionContext = {
  model: 'mock',
}

const workspaceId = 'workspace1'

// files next to the allowed folders, none inside: like fs.existsSync, `..` segments are resolved
const kOutsideFiles = ['/tmp-evil/file.txt', '/tmpfile', '/home/user/Documents-private/tax.txt', '/home/user/.ssh/id_rsa', '/home/user/.bashrc', '/etc/passwd']
const existsOutside = (filePath: string) => kOutsideFiles.includes(path.posix.resolve(filePath))

// like the main process: entries are reported with the path they have in the folder that is listed
const listingOf = (dirPath: string, names: string[]): ListDirectoryResponse => ({
  success: true,
  items: names.map((name) => ({ name, fullPath: `${dirPath}/${name}`, isDirectory: !name.includes('.'), size: 100 }))
})

beforeEach(() => {

  vi.clearAllMocks()
  useWindowMock()

  // the paths of these tests are POSIX paths, on every host: the real mapping with the POSIX rules,
  // where home is /home/user, `exists` decides what exists and nothing is a link
  // (with the rules of a Windows host, /tmp is C:\tmp)
  window.api.file.resolveAllowedPath = vi.fn((targetPath: string, allowedPaths: string[]) => resolveAllowedPath(targetPath, allowedPaths, {
    pathImpl: path.posix,
    home: '/home/user',
    exists: (filePath: string) => window.api.file.exists(filePath),
    realPath: (filePath: string) => path.posix.resolve(filePath),
  }))

  window.api.file.exists = vi.fn((path: string) => {
    return path.startsWith('/home/user/Documents/test')
  })

  window.api.file.listDirectory = vi.fn((dirPath: string, includeHidden?: boolean) => {
    return listingOf(dirPath, ['file1.txt', 'subdir', ...(includeHidden ? ['.hidden'] : [])])
  })

  window.api.file.findFiles = vi.fn(async (basePath: string, pattern: string, maxResults?: number) => {
    return [`${basePath}/file1.txt`, `${basePath}/subdir/file2.txt`].slice(0, maxResults || 10)
  })

  store.config = {
    plugins: {
      filesystem: {
        enabled: true,
        allowedPaths: ['/tmp', '~/Documents'],
        allowWrite: false,
        skipConfirmation: false,
      }
    }
  } as any
})

test('Filesystem plugin initialization', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.getName()).toBe('filesystem')
  expect(plugin.isEnabled()).toBe(true)
})

test('Filesystem plugin parameters', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const params = plugin.getParameters()
  expect(params).toHaveLength(6)
  expect(params[0].name).toBe('action')
  expect(params[0].enum).toEqual(['list', 'read', 'write', 'find'])
  expect(params[1].name).toBe('path')
  expect(params[2].name).toBe('content')
  expect(params[3].name).toBe('pattern')
  expect(params[4].name).toBe('maxResults')
  expect(params[5].name).toBe('includeHidden')
})

test('Filesystem plugin parameters with write rights', () => {
  store.config.plugins.filesystem.allowWrite = true
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const params = plugin.getParameters()
  expect(params).toHaveLength(6)
  expect(params[0].name).toBe('action')
  expect(params[0].enum).toEqual(['list', 'read', 'write', 'find', 'delete'])
  expect(params[1].name).toBe('path')
  expect(params[2].name).toBe('content')
  expect(params[3].name).toBe('pattern')
  expect(params[4].name).toBe('maxResults')
  expect(params[5].name).toBe('includeHidden')
})

test('Filesystem plugin map path to allowed paths', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.mapToAllowedPaths('/tmp/test')).toBe('/tmp/test')
  expect(plugin.mapToAllowedPaths('Documents')).toBe('/home/user/Documents')
  expect(plugin.mapToAllowedPaths('~/Documents/test')).toBe('/home/user/Documents/test')
  expect(plugin.mapToAllowedPaths('./Documents/test')).toBe('/home/user/Documents/test')
  expect(plugin.mapToAllowedPaths('Documents/test/subdir')).toBe('/home/user/Documents/test/subdir')
})

test('Filesystem plugin map path - subdirectory resolution', () => {
  // Test the subdirectory resolution path where allowed path + ./ + target exists
  // Note: path.normalize removes ./ so the path becomes /home/user/Documents/subdir/file.txt
  window.api.file.exists = vi.fn((p: string) => {
    return p === '/home/user/Documents/subdir/file.txt'
  })
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = plugin.mapToAllowedPaths('subdir/file.txt')
  expect(result).toBe('/home/user/Documents/subdir/file.txt')
})

test('Filesystem plugin map path - result is normalized', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.mapToAllowedPaths('/tmp/./nested/../notes.txt')).toBe('/tmp/notes.txt')
  expect(plugin.mapToAllowedPaths('/tmp/test/')).toBe('/tmp/test')
  expect(plugin.mapToAllowedPaths('~/Documents/a/../b.txt')).toBe('/home/user/Documents/b.txt')
  expect(plugin.mapToAllowedPaths('Documents/test/../test/subdir')).toBe('/home/user/Documents/test/subdir')
})

test('Filesystem plugin map path - sibling folders that share a prefix are refused', () => {
  window.api.file.exists = vi.fn(existsOutside)
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.mapToAllowedPaths('/tmp-evil/file.txt')).toBeNull()
  expect(plugin.mapToAllowedPaths('/tmpfile')).toBeNull()
  expect(plugin.mapToAllowedPaths('/home/user/Documents-private/tax.txt')).toBeNull()
  expect(plugin.mapToAllowedPaths('~/Documents-private/tax.txt')).toBeNull()
  expect(plugin.mapToAllowedPaths('Documents-private/tax.txt')).toBeNull()
  expect(plugin.mapToAllowedPaths('../Documents-private/tax.txt')).toBeNull()
})

test('Filesystem plugin map path - the name of an allowed folder followed by dot-dot is refused', () => {
  window.api.file.exists = vi.fn(existsOutside)
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.mapToAllowedPaths('Documents/../.ssh/id_rsa')).toBeNull()
  expect(plugin.mapToAllowedPaths('./Documents/../.ssh/id_rsa')).toBeNull()
  expect(plugin.mapToAllowedPaths('Documents/test/../../.bashrc')).toBeNull()
  expect(plugin.mapToAllowedPaths('tmp/../etc/passwd')).toBeNull()
  expect(plugin.mapToAllowedPaths('/tmp/../etc/passwd')).toBeNull()
  expect(plugin.mapToAllowedPaths('/tmp/../../etc/passwd')).toBeNull()
  expect(plugin.mapToAllowedPaths('~/Documents/../.ssh/id_rsa')).toBeNull()
})

test('Filesystem plugin map path - either separator after the name of an allowed folder', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  store.config.plugins.filesystem.allowedPaths = ['/data/Documents']
  window.api.file.exists = vi.fn((p: string) => p === '/data/Documents/folder/test.txt')
  expect(plugin.mapToAllowedPaths('./Documents/folder/test.txt')).toBe('/data/Documents/folder/test.txt')
  expect(plugin.mapToAllowedPaths('Documents\\folder\\test.txt')).toBe('/data/Documents/folder/test.txt')
  expect(plugin.mapToAllowedPaths('.\\Documents\\folder/test.txt')).toBe('/data/Documents/folder/test.txt')
  expect(plugin.mapToAllowedPaths('Documents\\..\\secret.txt')).toBeNull()
})

test('Filesystem plugin map path - odd input is refused without throwing', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.mapToAllowedPaths(undefined as any)).toBeNull()
  expect(plugin.mapToAllowedPaths(null as any)).toBeNull()
  expect(plugin.mapToAllowedPaths({} as any)).toBeNull()
  expect(plugin.mapToAllowedPaths('/tmp/test\0.txt')).toBeNull()
  expect(new FilesystemPlugin({ enabled: true, allowedPaths: '/tmp' as any, allowWrite: false, skipConfirmation: false }, workspaceId).mapToAllowedPaths('/tmp/test')).toBeNull()
  const samples = [
    '.', '..', '/', '\\', 'C:\\Windows\\System32', 'C:/Windows/System32', '/tmp', '/tmp/', 'tmp/../tmp/a',
    '~', '~/Documents/a b/c', './Documents/a', 'Documents\\a', ' ', 'con', 'NUL', 'a'.repeat(4000), '/tmp/./././x', '',
  ]
  for (let i = 0; i < 50; i++) {
    samples.push(`/tmp/file-${i}.txt`)
    samples.push(`../${'../'.repeat(i % 5)}etc/passwd`)
    samples.push(`C:\\Users\\me\\docs-${i}\\file`)
  }
  for (const sample of samples) {
    expect(() => plugin.mapToAllowedPaths(sample), JSON.stringify(sample)).not.toThrow()
    const mapped = plugin.mapToAllowedPaths(sample)
    expect(mapped === null || mapped === '/tmp' || mapped.startsWith('/tmp/') || mapped === '/home/user/Documents' || mapped.startsWith('/home/user/Documents/'), `${sample} => ${mapped}`).toBe(true)
  }
})

test('Filesystem plugin map path - parent traversal and empty allow lists', () => {
  store.config.plugins.filesystem.allowedPaths = ['/tmp/allowed']
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.mapToAllowedPaths('/tmp/allowed/notes.txt')).toBe('/tmp/allowed/notes.txt')
  expect(plugin.mapToAllowedPaths('/tmp/allowed/./nested/../notes.txt')).toBe('/tmp/allowed/notes.txt')
  expect(plugin.mapToAllowedPaths('/tmp/allowed/../etc/passwd')).toBeNull()
  expect(plugin.mapToAllowedPaths('/tmp/allowed/../../etc/passwd')).toBeNull()
  expect(plugin.mapToAllowedPaths('')).toBeNull()
  store.config.plugins.filesystem.allowedPaths = []
  expect(new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId).mapToAllowedPaths('/tmp/allowed/file')).toBeNull()
  expect(window.api.file.resolveAllowedPath).toHaveBeenCalledTimes(5)
})

test('Filesystem plugin map path - allowed paths of a reactive config are sent as a plain array', () => {
  const plugin = new FilesystemPlugin(reactive(store.config.plugins.filesystem) as any, workspaceId)
  expect(plugin.mapToAllowedPaths('/tmp/test')).toBe('/tmp/test')
  const allowedPaths = vi.mocked(window.api.file.resolveAllowedPath).mock.calls[0][1]
  expect(allowedPaths).toEqual(['/tmp', '~/Documents'])
  expect(isReactive(allowedPaths)).toBe(false)
})

test('Filesystem plugin path validation', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const allowedResult = await plugin.execute(context, {
    action: 'list',
    path: '/tmp/test'
  })
  expect(allowedResult.error).toBeUndefined()
  const disallowedResult = await plugin.execute(context, {
    action: 'list',
    path: '/etc/passwd'
  })
  expect(disallowedResult.error).toContain('plugins.filesystem.invalidPath')
})

test('Filesystem plugin list directory', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'list',
    path: '/tmp/test'
  })
  expect(window.api.file.listDirectory).toHaveBeenCalledWith('/tmp/test', false)
  expect(result.items).toEqual([
    { name: 'file1.txt', fullPath: '/tmp/test/file1.txt', isDirectory: false, size: 100 },
    { name: 'subdir', fullPath: '/tmp/test/subdir', isDirectory: true, size: 100 }
  ])
})

test('Filesystem plugin list directory with hidden files', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'list',
    path: '/tmp/test',
    includeHidden: true
  })
  expect(window.api.file.listDirectory).toHaveBeenCalledWith('/tmp/test', true)
  expect(result.items.map((item: any) => item.name)).toEqual(['file1.txt', 'subdir', '.hidden'])
})

test('Filesystem plugin list directory - entries outside the allowed paths are left out', async () => {
  window.api.file.listDirectory = vi.fn((): ListDirectoryResponse => ({
    success: true,
    items: [
      { name: 'file1.txt', fullPath: '/tmp/test/file1.txt', isDirectory: false, size: 100 },
      { name: 'passwd', fullPath: '/etc/passwd', isDirectory: false, size: 100 },
      { name: 'secret.txt', fullPath: '/tmp-secret/secret.txt', isDirectory: false, size: 100 },
      { name: 'id_rsa', fullPath: '/tmp/test/../../home/user/.ssh/id_rsa', isDirectory: false, size: 100 },
    ]
  }))
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, { action: 'list', path: '/tmp/test' })
  expect(result.success).toBe(true)
  expect(result.items).toEqual([
    { name: 'file1.txt', fullPath: '/tmp/test/file1.txt', isDirectory: false, size: 100 },
  ])
})

test('Filesystem plugin read file', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'read',
    path: '/tmp/test.txt'
  })
  expect(window.api.file.read).toHaveBeenCalledWith('/tmp/test.txt')
  expect(window.api.file.extractText).toHaveBeenCalledWith('/tmp/test.txt_encoded', 'txt')
  expect(result.contents).toBe('/tmp/test.txt_encoded_extracted')
})

test('Filesystem plugin read file decodes UTF-8 for non-document files', async () => {
  const text = 'café 😀'
  const base64 = Buffer.from(text, 'utf-8').toString('base64')
  const identityAtob = global.atob
  global.atob = (value: string) => Buffer.from(value, 'base64').toString('latin1')
  window.api.file.read = vi.fn(() => ({
    url: '/tmp/note.md',
    contents: base64,
    mimeType: 'text/markdown',
  }))
  try {
    const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
    const result = await plugin.execute(context, {
      action: 'read',
      path: '/tmp/note.md'
    })
    expect(window.api.file.read).toHaveBeenCalledWith('/tmp/note.md')
    expect(window.api.file.extractText).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.contents).toBe(text)
  } finally {
    global.atob = identityAtob
  }
})

test('Filesystem plugin write file - new file', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/tmp/newfile.txt',
    content: 'test content'
  })
  expect(window.api.file.exists).toHaveBeenCalledWith('/tmp/newfile.txt')
  expect(window.api.file.write).toHaveBeenCalledWith('/tmp/newfile.txt', 'test content')
  expect(result.success).toBe(true)
})

test('Filesystem plugin write file - overwrite disallowed', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/home/user/Documents/test',
    content: 'test content'
  })
  expect(result.error).toContain('File already exists')
  expect(window.api.file.write).not.toHaveBeenCalled()
})

test('Filesystem plugin write file - overwrite allowed', async () => {
  store.config.plugins.filesystem.allowWrite = true
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/home/user/Documents/test',
    content: 'test content'
  })
  expect(result.success).toBe(true)
  expect(Dialog.show).toHaveBeenCalled()
  expect(window.api.file.write).toHaveBeenCalled()
})

test('Filesystem plugin write file - overwrite allowed and skipped', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/home/user/Documents/test',
    content: 'test content'
  })
  expect(result.success).toBe(true)
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(window.api.file.write).toHaveBeenCalled()
})

test('Filesystem plugin delete file - disallowed', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'delete',
    path: '/home/user/Documents/test'
  })
  expect(result.error).toContain('Deletion is not allowed')
  expect(window.api.file.delete).not.toHaveBeenCalled()
})

test('Filesystem plugin delete file - allowed', async () => {
  store.config.plugins.filesystem.allowWrite = true
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'delete',
    path: '/home/user/Documents/test'
  })
  expect(result.success).toBe(true)
  expect(Dialog.show).toHaveBeenCalled()
  expect(window.api.file.delete).toHaveBeenCalled()
})

test('Filesystem plugin delete file - allowed and skipped', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'delete',
    path: '/home/user/Documents/test'
  })
  expect(result.success).toBe(true)
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(window.api.file.delete).toHaveBeenCalled()
})

test('Filesystem plugin disabled', () => {
  const disabledConfig = { enabled: false, allowedPaths: [] as any, allowWrite: false, skipConfirmation: false }
  const plugin = new FilesystemPlugin(disabledConfig, workspaceId)
  expect(plugin.isEnabled()).toBe(false)
})

test('Filesystem plugin no allowed paths', () => {
  const noPathsConfig = { enabled: true, allowedPaths: [] as any, allowWrite: false, skipConfirmation: false }
  const plugin = new FilesystemPlugin(noPathsConfig, workspaceId)
  expect(plugin.isEnabled()).toBe(false)
})

test('Filesystem plugin status descriptions', () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  expect(plugin.getPreparationDescription()).toBe('plugins.filesystem.starting')
  expect(plugin.getRunningDescription('filesystem', { action: 'list', path: '/tmp' })).toBe('plugins.filesystem.list.running')
  expect(plugin.getRunningDescription('filesystem', { action: 'read', path: '/tmp/file.txt' })).toBe('plugins.filesystem.read.running')
  expect(plugin.getRunningDescription('filesystem', { action: 'write', path: '/tmp/file.txt' })).toBe('plugins.filesystem.write.running')
  expect(plugin.getRunningDescription('filesystem', { action: 'delete', path: '/tmp/file.txt' })).toBe('plugins.filesystem.delete.running')
  expect(plugin.getRunningDescription('filesystem', { action: 'find', path: '/tmp', pattern: '*.txt' })).toBe('plugins.filesystem.find.running')
  expect(plugin.getCompletedDescription('filesystem', { action: 'list', path: '/tmp' }, { success: true, items: [1, 2] })).toBe('plugins.filesystem.list.completed')
  expect(plugin.getCompletedDescription('filesystem', { action: 'read', path: '/tmp/file.txt' }, { success: true, contents: 'test' })).toBe('plugins.filesystem.read.completed')
  expect(plugin.getCompletedDescription('filesystem', { action: 'write', path: '/tmp/file.txt' }, { success: true })).toBe('plugins.filesystem.write.completed')
  expect(plugin.getCompletedDescription('filesystem', { action: 'delete', path: '/tmp/file.txt' }, { success: true })).toBe('plugins.filesystem.delete.completed')
  expect(plugin.getCompletedDescription('filesystem', { action: 'find', path: '/tmp', pattern: '*.txt' }, { success: true, count: 3 })).toBe('plugins.filesystem.find.completed')
  expect(plugin.getCompletedDescription('filesystem', { action: 'list', path: '/tmp' }, { success: false, error: 'test error' })).toBe('plugins.filesystem.list.error')
  expect(plugin.getCompletedDescription('filesystem', { action: 'read', path: '/tmp/file.txt' }, { success: false, error: 'test error' })).toBe('plugins.filesystem.read.error')
  expect(plugin.getCompletedDescription('filesystem', { action: 'write', path: '/tmp/file.txt' }, { success: false, error: 'test error' })).toBe('plugins.filesystem.write.error')
  expect(plugin.getCompletedDescription('filesystem', { action: 'delete', path: '/tmp/file.txt' }, { success: false, error: 'test error' })).toBe('plugins.filesystem.delete.error')
  expect(plugin.getCompletedDescription('filesystem', { action: 'find', path: '/tmp', pattern: '*.txt' }, { success: false, error: 'test error' })).toBe('plugins.filesystem.find.error')
})

test('Filesystem plugin unknown action', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'unknown_action' as any,
    path: '/tmp/test'
  })
  expect(result.error).toContain('Unknown action')
})

test('Filesystem plugin list directory - error handling', async () => {
  window.api.file.listDirectory = vi.fn(() => {
    throw new Error('Directory not found')
  })
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'list',
    path: '/tmp/test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.list.error')
})

test('Filesystem plugin read file - error handling', async () => {
  window.api.file.read = vi.fn(() => {
    throw new Error('File not found')
  })
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'read',
    path: '/tmp/test.txt'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.read.error')
})

test('Filesystem plugin write file - error handling', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  window.api.file.write = vi.fn(() => {
    throw new Error('Write failed')
  })
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/tmp/test.txt',
    content: 'test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.write.error')
})

test('Filesystem plugin write file - user declines confirmation', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = false
  vi.mocked(Dialog.show).mockResolvedValue({ isConfirmed: false } as any)
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/home/user/Documents/test',
    content: 'test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.write.declined')
  expect(window.api.file.write).not.toHaveBeenCalled()
})

test('Filesystem plugin delete file - user declines confirmation', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = false
  vi.mocked(Dialog.show).mockResolvedValue({ isConfirmed: false } as any)
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'delete',
    path: '/home/user/Documents/test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.delete.declined')
  expect(window.api.file.delete).not.toHaveBeenCalled()
})

test('Filesystem plugin delete file - error handling', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  window.api.file.delete = vi.fn(() => {
    throw new Error('Delete failed')
  })
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'delete',
    path: '/home/user/Documents/test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.delete.error')
})

test('Filesystem plugin delete file - delete returns false', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  window.api.file.delete = vi.fn(() => false)
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'delete',
    path: '/home/user/Documents/test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.delete.error')
})

test('Filesystem plugin write file - write returns false', async () => {
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  window.api.file.write = vi.fn(() => false)
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'write',
    path: '/tmp/test.txt',
    content: 'test'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.write.error')
})

test('Filesystem plugin find files', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'find',
    path: '/tmp',
    pattern: '*.txt'
  })
  expect(window.api.file.findFiles).toHaveBeenCalledWith('/tmp', '*.txt', 10)
  expect(result.success).toBe(true)
  expect(result.files).toEqual(['/tmp/file1.txt', '/tmp/subdir/file2.txt'])
  expect(result.count).toBe(2)
  expect(result.truncated).toBe(false)
})

test('Filesystem plugin find files - results outside the allowed paths are left out', async () => {
  window.api.file.findFiles = vi.fn(async () => ['/tmp/file1.txt', '/etc/hosts.txt', '/tmp-secret/secret.txt', '/tmp/sub/../../etc/passwd.txt'])
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'find',
    path: '/tmp',
    pattern: '*.txt',
    maxResults: 4
  })
  expect(result.success).toBe(true)
  expect(result.files).toEqual(['/tmp/file1.txt'])
  expect(result.count).toBe(1)
  expect(result.truncated).toBe(true)
})

test('Filesystem plugin find files with maxResults', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'find',
    path: '/tmp',
    pattern: '*.txt',
    maxResults: 1
  })
  expect(window.api.file.findFiles).toHaveBeenCalledWith('/tmp', '*.txt', 1)
  expect(result.success).toBe(true)
  expect(result.files).toEqual(['/tmp/file1.txt'])
  expect(result.count).toBe(1)
  expect(result.truncated).toBe(true)
})

test('Filesystem plugin find files - no pattern', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'find',
    path: '/tmp'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.find.noPattern')
})

test('Filesystem plugin find files - error handling', async () => {
  window.api.file.findFiles = vi.fn(() => {
    throw new Error('Search failed')
  })
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'find',
    path: '/tmp',
    pattern: '*.txt'
  })
  expect(result.success).toBe(false)
  expect(result.error).toContain('plugins.filesystem.find.error')
})

test('Filesystem plugin find files - invalid path', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, {
    action: 'find',
    path: '/etc',
    pattern: '*.conf'
  })
  expect(result.error).toContain('plugins.filesystem.invalidPath')
})

test('Filesystem plugin path traversal prevention - relative path escape', () => {
  // The global mock now uses real path.normalize which resolves .. sequences
  // Mock file.exists to return true for any path (simulating the file exists)
  window.api.file.exists = vi.fn(() => true)

  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)

  // Attempt to traverse outside allowed path using ../
  // path.normalize resolves /tmp/../../../etc/passwd to /etc/passwd
  // Even if file.exists returns true, mapToAllowedPaths should return null
  // because the resolved path doesn't start with the allowed path
  const result = plugin.mapToAllowedPaths('../../../etc/passwd')
  expect(result).toBeNull()
})

test('Filesystem plugin path traversal prevention - action blocked', async () => {
  // The global mock uses real path.normalize
  window.api.file.exists = vi.fn(() => true)

  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)

  const result = await plugin.execute(context, {
    action: 'read',
    path: '../../../etc/passwd'
  })
  expect(result.error).toContain('plugins.filesystem.invalidPath')
})

test('Filesystem plugin no action reaches a sibling folder or a dot-dot path', async () => {
  window.api.file.exists = vi.fn(existsOutside)
  store.config.plugins.filesystem.allowWrite = true
  store.config.plugins.filesystem.skipConfirmation = true
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  for (const target of ['/tmp-evil/file.txt', '/home/user/Documents-private/tax.txt', 'Documents/../.ssh/id_rsa', '/tmp/../etc/passwd']) {
    for (const action of ['list', 'read', 'write', 'delete', 'find'] as const) {
      const result = await plugin.execute(context, { action, path: target, content: 'x', pattern: '*' })
      expect(result.error, `${action} ${target}`).toContain('plugins.filesystem.invalidPath')
    }
  }
  expect(window.api.file.listDirectory).not.toHaveBeenCalled()
  expect(window.api.file.read).not.toHaveBeenCalled()
  expect(window.api.file.write).not.toHaveBeenCalled()
  expect(window.api.file.delete).not.toHaveBeenCalled()
  expect(window.api.file.findFiles).not.toHaveBeenCalled()
  expect(Dialog.show).not.toHaveBeenCalled()
})

test('Filesystem plugin missing path', async () => {
  const plugin = new FilesystemPlugin(store.config.plugins.filesystem as any, workspaceId)
  const result = await plugin.execute(context, { action: 'read' } as any)
  expect(result.error).toContain('plugins.filesystem.invalidPath')
  expect(window.api.file.read).not.toHaveBeenCalled()
})

describe.skipIf(process.platform === 'win32')('Filesystem plugin on a real folder with symlinks', () => {

  let root: string
  let allowed: string
  let outside: string

  const newPlugin = () => new FilesystemPlugin({ enabled: true, allowedPaths: [allowed], allowWrite: true, skipConfirmation: true }, workspaceId)

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-fsplugin-')))
    allowed = path.join(root, 'allowed')
    outside = path.join(root, 'allowed-not')
    fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(allowed, 'notes.txt'), 'notes')
    fs.writeFileSync(path.join(allowed, 'sub', 'deep.txt'), 'deep')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    fs.symlinkSync(outside, path.join(allowed, 'linkdir'))
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(allowed, 'link.txt'))
    fs.symlinkSync(path.join(outside, 'created.txt'), path.join(allowed, 'dangling.txt'))
    fs.symlinkSync(path.join(allowed, 'sub'), path.join(allowed, 'alias'))

    // what the main process does, on the real file system
    window.api.file.resolveAllowedPath = vi.fn((targetPath: string, allowedPaths: string[]) => resolveAllowedPath(targetPath, allowedPaths))
    window.api.file.exists = vi.fn((filePath: string) => fs.existsSync(filePath))
    window.api.file.listDirectory = vi.fn((dirPath: string): ListDirectoryResponse => ({
      success: true,
      items: fs.readdirSync(dirPath, { withFileTypes: true }).map((item) => ({
        name: item.name,
        fullPath: path.join(dirPath, item.name),
        isDirectory: item.isDirectory(),
      }))
    }))
    window.api.file.findFiles = vi.fn(async (basePath: string) => {
      return fs.readdirSync(basePath).map((name) => path.join(basePath, name))
    })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('paths inside are mapped, existing or not', () => {
    const plugin = newPlugin()
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'notes.txt'))).toBe(path.join(allowed, 'notes.txt'))
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'new', 'file.txt'))).toBe(path.join(allowed, 'new', 'file.txt'))
    expect(plugin.mapToAllowedPaths('sub/deep.txt')).toBe(path.join(allowed, 'sub', 'deep.txt'))
    expect(plugin.mapToAllowedPaths('allowed/sub/deep.txt')).toBe(path.join(allowed, 'sub', 'deep.txt'))
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'alias', 'deep.txt'))).toBe(path.join(allowed, 'alias', 'deep.txt'))
  })

  test('a symlink that leaves the allowed folder is not followed', () => {
    const plugin = newPlugin()
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'linkdir'))).toBeNull()
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'linkdir', 'secret.txt'))).toBeNull()
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'link.txt'))).toBeNull()
    expect(plugin.mapToAllowedPaths(path.join(allowed, 'dangling.txt'))).toBeNull()
    expect(plugin.mapToAllowedPaths('linkdir/secret.txt')).toBeNull()
    expect(plugin.mapToAllowedPaths('allowed/link.txt')).toBeNull()
    expect(plugin.mapToAllowedPaths(path.join(outside, 'secret.txt'))).toBeNull()
  })

  test('nothing is done through a symlink that leaves the allowed folder', async () => {
    const plugin = newPlugin()
    expect((await plugin.execute(context, { action: 'read', path: path.join(allowed, 'link.txt') })).error).toContain('plugins.filesystem.invalidPath')
    expect((await plugin.execute(context, { action: 'read', path: 'linkdir/secret.txt' })).error).toContain('plugins.filesystem.invalidPath')
    expect((await plugin.execute(context, { action: 'list', path: path.join(allowed, 'linkdir') })).error).toContain('plugins.filesystem.invalidPath')
    expect((await plugin.execute(context, { action: 'find', path: path.join(allowed, 'linkdir'), pattern: '*' })).error).toContain('plugins.filesystem.invalidPath')
    expect((await plugin.execute(context, { action: 'write', path: path.join(allowed, 'dangling.txt'), content: 'x' })).error).toContain('plugins.filesystem.invalidPath')
    expect((await plugin.execute(context, { action: 'write', path: path.join(allowed, 'linkdir', 'new.txt'), content: 'x' })).error).toContain('plugins.filesystem.invalidPath')
    expect((await plugin.execute(context, { action: 'delete', path: path.join(allowed, 'linkdir', 'secret.txt') })).error).toContain('plugins.filesystem.invalidPath')
    expect(window.api.file.read).not.toHaveBeenCalled()
    expect(window.api.file.listDirectory).not.toHaveBeenCalled()
    expect(window.api.file.findFiles).not.toHaveBeenCalled()
    expect(window.api.file.write).not.toHaveBeenCalled()
    expect(window.api.file.delete).not.toHaveBeenCalled()
  })

  test('listing leaves out the symlinks that leave the allowed folder', async () => {
    const result = await newPlugin().execute(context, { action: 'list', path: allowed })
    expect(result.success).toBe(true)
    expect(result.items.map((item: any) => item.name).sort()).toEqual(['alias', 'notes.txt', 'sub'])
  })

  test('searching leaves out the symlinks that leave the allowed folder', async () => {
    const result = await newPlugin().execute(context, { action: 'find', path: allowed, pattern: '*' })
    expect(result.success).toBe(true)
    expect(result.files.sort()).toEqual(['alias', 'notes.txt', 'sub'].map((name) => path.join(allowed, name)))
    expect(result.count).toBe(3)
  })

  test('reading and writing inside still work', async () => {
    const plugin = newPlugin()
    const read = await plugin.execute(context, { action: 'read', path: 'notes.txt' })
    expect(read.success).toBe(true)
    expect(window.api.file.read).toHaveBeenCalledWith(path.join(allowed, 'notes.txt'))
    const write = await plugin.execute(context, { action: 'write', path: path.join(allowed, 'sub', '..', 'new.txt'), content: 'x' })
    expect(write.success).toBe(true)
    expect(window.api.file.write).toHaveBeenCalledWith(path.join(allowed, 'new.txt'), 'x')
  })

})
