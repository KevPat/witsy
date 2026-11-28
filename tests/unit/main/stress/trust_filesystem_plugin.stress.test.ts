
import { beforeEach, describe, expect, test, vi } from 'vitest'
import path from 'node:path'
import { PluginExecutionContext } from 'multi-llm-ts'
import Dialog from '@renderer/utils/dialog'
import FilesystemPlugin from '@services/plugins/filesystem'
import { resolveAllowedPath } from '@main/path_containment'
import { useWindowMock } from '@tests/mocks/window'

// The filesystem plugin runs with arguments chosen by the model, so by whoever wrote the web page,
// the document or the tool result the model has just read. `allowedPaths` is the only thing that
// keeps it inside the folders the user picked. Nothing here touches the real file system: the
// preload api is replaced by an in-memory one, once with POSIX paths and once with Windows paths,
// so the result is the same on every host.

const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

type Flavour = {
  name: string
  platform: string
  lib: path.PlatformPath
  home: string
  allowed: string
  files: string[]
  inside: string[]
  outside: string[]
  sibling: string
  siblingRelative: string
  escapes: string[]
  roots: string[]
}

const kPosix: Flavour = {
  name: 'posix',
  platform: 'linux',
  lib: path.posix,
  home: '/home/user',
  allowed: '/home/user/Documents',
  files: [
    '/home/user/Documents/notes.txt',
    '/home/user/Documents/sub/deep.txt',
    '/home/user/Documents-private/tax.txt',
    '/home/user/.ssh/id_rsa',
    '/home/user/.bashrc',
    '/etc/passwd',
  ],
  inside: ['/home/user/Documents/notes.txt', '~/Documents/notes.txt', 'Documents/notes.txt', 'notes.txt', 'sub/deep.txt', './sub/../notes.txt', '/home/user/Documents/new/file.txt', '/home/user/Documents'],
  outside: ['/etc/passwd', '/home/user/.ssh/id_rsa', '~/.ssh/id_rsa', '.ssh/id_rsa', '../.ssh/id_rsa', '../../../etc/passwd', '/home/user', '~', '/home/user/Documents/../.bashrc'],
  sibling: '/home/user/Documents-private/tax.txt',
  siblingRelative: '../Documents-private/tax.txt',
  escapes: ['Documents/../.ssh/id_rsa', 'Documents/../.bashrc', 'Documents/../../../etc/passwd', './Documents/../.ssh/id_rsa', 'Documents/sub/../../.ssh/id_rsa'],
  roots: ['', '/', '/home/user/', '/home/user/Documents/', '~/', './', '/etc/'],
}

const kWin32: Flavour = {
  name: 'windows',
  platform: 'win32',
  lib: path.win32,
  home: 'C:\\Users\\user',
  allowed: 'C:\\Users\\user\\Documents',
  files: [
    'C:\\Users\\user\\Documents\\notes.txt',
    'C:\\Users\\user\\Documents\\sub\\deep.txt',
    'C:\\Users\\user\\Documents-private\\tax.txt',
    'C:\\Users\\user\\.ssh\\id_rsa',
    'C:\\Users\\user\\.bashrc',
    'C:\\Windows\\win.ini',
  ],
  inside: ['C:\\Users\\user\\Documents\\notes.txt', 'C:/Users/user/Documents/notes.txt', '~/Documents/notes.txt', 'Documents\\notes.txt', 'notes.txt', 'sub\\deep.txt', 'sub/../notes.txt', 'C:\\Users\\user\\Documents\\new\\file.txt', 'C:\\Users\\user\\Documents'],
  outside: ['C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'C:\\Users\\user\\.ssh\\id_rsa', '~/.ssh/id_rsa', '.ssh\\id_rsa', '..\\.ssh\\id_rsa', '..\\..\\..\\Windows\\win.ini', 'C:\\Users\\user', 'C:\\', '~', 'D:\\Users\\user\\Documents\\notes.txt', 'C:\\Users\\user\\Documents\\..\\.bashrc'],
  sibling: 'C:\\Users\\user\\Documents-private\\tax.txt',
  siblingRelative: '..\\Documents-private\\tax.txt',
  escapes: ['Documents\\..\\.ssh\\id_rsa', 'Documents\\..\\.bashrc', 'Documents\\..\\..\\..\\Windows\\win.ini', 'Documents\\sub\\..\\..\\.ssh\\id_rsa'],
  roots: ['', 'C:\\', 'C:\\Users\\user\\', 'C:\\Users\\user\\Documents\\', '~/', 'C:/Users/user/Documents/', 'C:\\Windows\\'],
}

// same steps as normalizePath in src/main/file.ts, with an explicit path flavour and home directory
const normalizeFor = (flavour: Flavour) => (filePath: string): string => {
  const { lib, home } = flavour
  if (filePath.startsWith('~/')) filePath = lib.join(home, filePath.slice(2))
  else if (filePath === '~') filePath = home
  else if (!lib.isAbsolute(filePath)) filePath = lib.join(home, filePath)
  return lib.resolve(filePath)
}

// like fs.existsSync: `..` segments are resolved, files and the folders above them exist
const existsFor = (flavour: Flavour) => (filePath: string): boolean => {
  const { lib } = flavour
  const resolved = lib.resolve(filePath)
  return flavour.files.some((file) => file === resolved || file.startsWith(resolved.endsWith(lib.sep) ? resolved : resolved + lib.sep))
}

const isInside = (flavour: Flavour, target: string): boolean => {
  const { lib } = flavour
  const relative = lib.relative(lib.resolve(flavour.allowed), lib.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${lib.sep}`) && !lib.isAbsolute(relative))
}

const context: PluginExecutionContext = { model: 'mock' }

const install = (flavour: Flavour) => {
  useWindowMock()
  window.api.platform = flavour.platform
  window.api.file.normalize = vi.fn(normalizeFor(flavour))
  window.api.file.exists = vi.fn(existsFor(flavour))
  // the plugin now asks the main process: the real mapping runs here, on the same in-memory file system
  window.api.file.resolveAllowedPath = vi.fn((targetPath: string, allowedPaths: string[]) => resolveAllowedPath(targetPath, allowedPaths, {
    pathImpl: flavour.lib,
    home: flavour.home,
    exists: (filePath: string) => window.api.file.exists(filePath),
    realPath: (filePath: string) => filePath,
  }))
  window.api.file.read = vi.fn((filepath: string) => ({ url: filepath, contents: btoa('contents'), mimeType: 'text/plain' }))
  window.api.file.extractText = vi.fn(async () => 'contents')
}

const newPlugin = (flavour: Flavour, config: { allowWrite?: boolean, skipConfirmation?: boolean } = {}) => {
  return new FilesystemPlugin({ enabled: true, allowedPaths: [flavour.allowed], allowWrite: false, skipConfirmation: false, ...config }, 'workspace')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Dialog.show).mockResolvedValue({ isConfirmed: true, isDenied: false, isDismissed: false })
})

describe.each([kPosix, kWin32])('mapToAllowedPaths with $name paths', (flavour) => {

  beforeEach(() => {
    install(flavour)
  })

  test('the fixture behaves like the real file system', () => {
    for (const file of flavour.files) expect(window.api.file.exists(file), file).toBe(true)
    expect(window.api.file.exists(flavour.allowed)).toBe(true)
    expect(window.api.file.exists(flavour.lib.join(flavour.allowed, 'missing.txt'))).toBe(false)
    expect(window.api.file.normalize('~')).toBe(flavour.home)
    expect(window.api.file.normalize('Documents')).toBe(flavour.allowed)
    expect(isInside(flavour, flavour.allowed)).toBe(true)
    expect(isInside(flavour, flavour.sibling)).toBe(false)
    expect(isInside(flavour, flavour.home)).toBe(false)
  })

  test('paths inside the allowed folder are accepted and normalized', () => {
    const plugin = newPlugin(flavour)
    for (const target of flavour.inside) {
      const mapped = plugin.mapToAllowedPaths(target)
      expect(mapped, target).not.toBeNull()
      expect(isInside(flavour, mapped), target).toBe(true)
      expect(mapped, target).toBe(flavour.lib.resolve(mapped))
    }
  })

  test('paths that are plainly outside the allowed folder are rejected', () => {
    const plugin = newPlugin(flavour)
    for (const target of flavour.outside) {
      expect(plugin.mapToAllowedPaths(target), target).toBeNull()
    }
  })

  test('nothing is accepted when no folder is allowed', () => {
    const plugin = new FilesystemPlugin({ enabled: true, allowedPaths: [], allowWrite: false, skipConfirmation: false }, 'workspace')
    expect(plugin.isEnabled()).toBe(false)
    for (const target of [...flavour.inside, ...flavour.outside]) {
      expect(plugin.mapToAllowedPaths(target), target).toBeNull()
    }
  })

  test('a sibling folder that shares the prefix of the allowed folder is rejected', () => {
    // a prefix check accepted it: Documents-private starts with Documents
    expect(newPlugin(flavour).mapToAllowedPaths(flavour.sibling)).toBeNull()
  })

  test('a relative path cannot reach a sibling folder that shares the prefix', () => {
    // the path relative to the allowed folder resolves to the sibling, which the prefix check accepted
    expect(newPlugin(flavour).mapToAllowedPaths(flavour.siblingRelative)).toBeNull()
  })

  test.each(flavour.escapes)('%s does not leave the allowed folder', (target) => {
    // the path was glued behind the parent of the allowed folder and never normalized,
    // so the prefix check held while `..` walked out of it
    const mapped = newPlugin(flavour).mapToAllowedPaths(target)
    expect(mapped === null || isInside(flavour, mapped), `${target} => ${mapped}`).toBe(true)
  })

  test('a trailing separator on the allowed folder does not change the outcome', () => {
    // the allowed path is normalized, which drops the separator: the sibling must not match then either
    const plugin = new FilesystemPlugin({ enabled: true, allowedPaths: [flavour.allowed + flavour.lib.sep], allowWrite: false, skipConfirmation: false }, 'workspace')
    expect(plugin.mapToAllowedPaths(flavour.inside[0])).not.toBeNull()
    expect(plugin.mapToAllowedPaths(flavour.sibling)).toBeNull()
  })

  const kSegments = ['..', '..', '.', 'Documents', 'Documents', 'Documents-private', 'DocumentsX', 'sub', '.ssh', 'notes.txt', 'deep.txt', 'tax.txt', 'id_rsa', '.bashrc', 'new.txt']

  const randomTarget = (rand: () => number, segments: string[]): string => {
    const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]
    const parts = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pick(segments))
    return pick(flavour.roots) + parts.join(flavour.lib.sep)
  }

  test('2000 random paths without parent segments or look-alike folders stay inside when accepted', () => {
    const rand = mulberry32(20261127)
    const plugin = newPlugin(flavour)
    const segments = kSegments.filter((segment) => !['..', 'Documents-private', 'DocumentsX'].includes(segment))
    let accepted = 0
    for (let i = 0; i < 2000; i++) {
      const target = randomTarget(rand, segments)
      const mapped = plugin.mapToAllowedPaths(target)
      if (mapped === null) continue
      accepted++
      expect(isInside(flavour, mapped), `${target} => ${mapped}`).toBe(true)
    }
    expect(accepted).toBeGreaterThan(200)
  })

  test('2000 random paths stay inside the allowed folder when accepted', () => {
    // sibling folders and `Documents/..` paths are part of the mix (see above)
    const rand = mulberry32(42)
    const plugin = newPlugin(flavour)
    for (let i = 0; i < 2000; i++) {
      const target = randomTarget(rand, kSegments)
      const mapped = plugin.mapToAllowedPaths(target)
      expect(mapped === null || isInside(flavour, mapped), `${target} => ${mapped}`).toBe(true)
    }
  })

  test('random strings never throw', () => {
    const rand = mulberry32(7)
    const plugin = newPlugin(flavour)
    const alphabet = ['/', '\\', '.', '..', '~', ':', 'C:', ' ', '\n', '\0', '%2e%2e', '*', '?', '"', 'Documents', 'é', '😀', '']
    for (let i = 0; i < 1000; i++) {
      const target = Array.from({ length: Math.floor(rand() * 8) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('')
      expect(() => plugin.mapToAllowedPaths(target), JSON.stringify(target)).not.toThrow()
    }
  })

})

describe.each([kPosix, kWin32])('execute with $name paths', (flavour) => {

  const escape = flavour.escapes[0]

  beforeEach(() => {
    install(flavour)
  })

  test('reading, listing and searching inside the allowed folder never asks the user', async () => {
    const plugin = newPlugin(flavour)
    const read = await plugin.execute(context, { action: 'read', path: flavour.inside[0] })
    expect(read).toMatchObject({ success: true, contents: 'contents' })
    const list = await plugin.execute(context, { action: 'list', path: flavour.allowed })
    expect(list.success).toBe(true)
    const find = await plugin.execute(context, { action: 'find', path: flavour.allowed, pattern: '*.txt' })
    expect(find.success).toBe(true)
    expect(window.api.file.read).toHaveBeenCalledTimes(1)
    expect(window.api.file.listDirectory).toHaveBeenCalledTimes(1)
    expect(window.api.file.findFiles).toHaveBeenCalledTimes(1)
    expect(Dialog.show).not.toHaveBeenCalled()
  })

  test('nothing is read, listed, searched, written or deleted for a path that is rejected', async () => {
    const plugin = newPlugin(flavour, { allowWrite: true, skipConfirmation: true })
    for (const action of ['read', 'list', 'find', 'write', 'delete'] as const) {
      const result = await plugin.execute(context, { action, path: flavour.outside[0], pattern: '*', content: 'x' })
      expect(result.error, action).toBeDefined()
    }
    expect(window.api.file.read).not.toHaveBeenCalled()
    expect(window.api.file.listDirectory).not.toHaveBeenCalled()
    expect(window.api.file.findFiles).not.toHaveBeenCalled()
    expect(window.api.file.write).not.toHaveBeenCalled()
    expect(window.api.file.delete).not.toHaveBeenCalled()
  })

  test('a file outside the allowed folder is not read', async () => {
    // reads are never confirmed: the mapping is the only guard
    const result = await newPlugin(flavour).execute(context, { action: 'read', path: escape })
    expect(window.api.file.read).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('a file in a sibling folder is not read', async () => {
    // reads are never confirmed: the mapping is the only guard
    const result = await newPlugin(flavour).execute(context, { action: 'read', path: flavour.sibling })
    expect(window.api.file.read).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('a folder outside the allowed folder is not listed', async () => {
    // listing is never confirmed: the mapping is the only guard
    const result = await newPlugin(flavour).execute(context, { action: 'list', path: flavour.lib.dirname(escape), includeHidden: true })
    expect(window.api.file.listDirectory).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('a folder outside the allowed folder is not searched', async () => {
    // searching is never confirmed: the mapping is the only guard
    const result = await newPlugin(flavour).execute(context, { action: 'find', path: flavour.lib.dirname(escape), pattern: '**/*' })
    expect(window.api.file.findFiles).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('a new file is not created in a sibling folder', async () => {
    // the user must not even be asked about a path they did not allow
    const target = flavour.lib.join(flavour.lib.dirname(flavour.sibling), 'new.txt')
    const result = await newPlugin(flavour).execute(context, { action: 'write', path: target, content: 'x' })
    expect(window.api.file.write).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('an existing file outside the allowed folder is not overwritten when confirmations are skipped', async () => {
    // with allowWrite and skipConfirmation only the mapping stands between the model and ~/.bashrc
    const plugin = newPlugin(flavour, { allowWrite: true, skipConfirmation: true })
    const result = await plugin.execute(context, { action: 'write', path: flavour.escapes[1], content: 'x' })
    expect(window.api.file.write).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('a file outside the allowed folder is not deleted when confirmations are skipped', async () => {
    // same for a deletion
    const plugin = newPlugin(flavour, { allowWrite: true, skipConfirmation: true })
    const result = await plugin.execute(context, { action: 'delete', path: escape })
    expect(window.api.file.delete).not.toHaveBeenCalled()
    expect(result.error).toBeDefined()
  })

  test('writing asks the user and does nothing when they decline', async () => {
    vi.mocked(Dialog.show).mockResolvedValue({ isConfirmed: false, isDenied: false, isDismissed: true })
    const target = flavour.lib.join(flavour.allowed, 'new.txt')
    const result = await newPlugin(flavour).execute(context, { action: 'write', path: target, content: 'x' })
    expect(Dialog.show).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect(window.api.file.write).not.toHaveBeenCalled()
  })

  test('existing files are not overwritten or deleted unless writing is allowed', async () => {
    const plugin = newPlugin(flavour)
    const write = await plugin.execute(context, { action: 'write', path: flavour.inside[0], content: 'x' })
    expect(write.success).toBe(false)
    const remove = await plugin.execute(context, { action: 'delete', path: flavour.inside[0] })
    expect(remove.success).toBe(false)
    expect(window.api.file.write).not.toHaveBeenCalled()
    expect(window.api.file.delete).not.toHaveBeenCalled()
    expect(Dialog.show).not.toHaveBeenCalled()
  })

})
