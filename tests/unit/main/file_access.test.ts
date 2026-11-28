
import { vi, expect, test, describe, beforeEach, afterEach, TestContext } from 'vitest'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { PluginExecutionContext } from 'multi-llm-ts'
import * as file from '@main/file'
import * as fileAccess from '@main/file_access'
import { resolveAllowedPath } from '@main/path_containment'
import FilesystemPlugin, { FilesystemPluginConfig } from '@services/plugins/filesystem'
import { useWindowMock } from '@tests/mocks/window'

vi.mock('electron', async () => {
  return {
    app: {
      getPath: vi.fn(),
    },
    dialog: {
      showSaveDialogSync: vi.fn(),
      showOpenDialogSync: vi.fn(),
    },
  }
})

// The renderer reaches `window.api.file.write` and `window.api.file.delete` with any string:
// these tests run the functions behind the two ipc channels on a real, temporary, file tree.
//
//   root/userData         the data of the app
//   root/temp             the temp folder of the system
//   root/allowed          a folder of the filesystem plugin
//   root/allowed-evil     its neighbour, same prefix
//   root/outside          everything else

let root: string
let userData: string
let temp: string
let allowed: string
let sibling: string
let outside: string
let victim: string

const kContent = 'SECRET-CONTENT-NOT-TO-BE-LOGGED'

const write = (target: unknown, config?: fileAccess.FilesystemAccessSource) => fileAccess.writeFileFromRenderer(app, target, kContent, config)
const remove = (target: unknown, config?: fileAccess.FilesystemAccessSource) => fileAccess.deleteFileFromRenderer(app, target, config)

// the filesystem plugin as the user set it up: root/allowed, with write access
const settings = (overrides: Partial<fileAccess.FilesystemAccessConfig> = {}): fileAccess.FilesystemAccessConfig => ({
  enabled: true,
  allowedPaths: [allowed],
  allowWrite: true,
  ...overrides,
})

const filesUnder = (dir: string): string[] => {
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...filesUnder(full))
    else result.push(path.relative(root, full))
  }
  return result.sort()
}

// links need a privilege on some Windows setups: the test is skipped when they cannot be created
const linkOrSkip = (ctx: TestContext, target: string, link: string, type: 'junction' | 'file') => {
  try {
    fs.symlinkSync(target, link, type)
  } catch {
    ctx.skip()
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-file-access-')))
  userData = path.join(root, 'userData')
  temp = path.join(root, 'temp')
  allowed = path.join(root, 'allowed')
  sibling = path.join(root, 'allowed-evil')
  outside = path.join(root, 'outside')
  victim = path.join(outside, 'victim.txt')
  for (const dir of [userData, temp, allowed, sibling, outside]) fs.mkdirSync(dir)
  fs.writeFileSync(victim, 'victim')
  fs.writeFileSync(path.join(sibling, 'victim.txt'), 'victim')
  vi.mocked(app.getPath).mockImplementation(((name: string) => path.join(root, name)) as any)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(console.warn).mockRestore()
  vi.mocked(console.error).mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Outside of the allowed locations', () => {

  test('writing is refused and nothing is written', () => {
    const before = filesUnder(root)
    expect(write(victim)).toBe(false)
    expect(write(path.join(outside, 'new.txt'))).toBe(false)
    expect(write(path.join(outside, 'new-folder', 'new.txt'))).toBe(false)
    expect(write(path.join(root, 'new.txt'))).toBe(false)
    expect(write(path.join(temp, 'new.txt'))).toBe(false)
    expect(write(path.join(allowed, 'new.txt'))).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(filesUnder(root)).toEqual(before)
    expect(fs.existsSync(path.join(outside, 'new-folder'))).toBe(false)
  })

  test('deleting is refused and nothing is deleted', () => {
    const before = filesUnder(root)
    expect(remove(victim)).toBe(false)
    expect(remove(`file://${victim}`)).toBe(false)
    expect(remove(pathToFileURL(victim).href)).toBe(false)
    expect(remove(path.join(sibling, 'victim.txt'))).toBe(false)
    expect(filesUnder(root)).toEqual(before)
  })

  test('the caller gets the usual failure value and the refusal is logged without the content', () => {
    expect(() => write(victim)).not.toThrow()
    expect(() => remove(victim)).not.toThrow()
    expect(console.warn).toHaveBeenCalledTimes(2)
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logged).toContain('victim.txt')
    expect(logged).not.toContain(kContent)
  })

  test('targets that are not an absolute path are refused', () => {
    const before = filesUnder(root)
    // a relative path would land in the working directory: the name is unique and removed whatever happens
    const relative = `witsy-file-access-relative-${path.basename(root)}.txt`
    try {
      for (const target of ['', relative, `./${relative}`, `${victim}\0.txt`, null, undefined, 42, {}, [victim]]) {
        expect(write(target)).toBe(false)
        expect(remove(target)).toBe(false)
      }
      expect(fs.existsSync(relative)).toBe(false)
    } finally {
      fs.rmSync(relative, { force: true })
    }
    // only delete understands urls
    expect(fileAccess.authorizeFileAccess(app, 'write', `file://${path.join(userData, 'a.txt')}`)).toBeNull()
    expect(fileAccess.authorizeFileAccess(app, 'delete', `file://${path.join(userData, 'a.txt')}`)).toBe(path.join(userData, 'a.txt'))
    expect(remove('file://')).toBe(false)
    expect(remove('file://victim.txt')).toBe(false)
    expect(filesUnder(root)).toEqual(before)
  })

  test('a check that throws is a refusal', () => {
    vi.mocked(app.getPath).mockImplementation(() => { throw new Error('no such path') })
    expect(write(victim, () => { throw new Error('no settings') })).toBe(false)
    expect(remove(victim, () => { throw new Error('no settings') })).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
  })

  test('the functions of the main process are not restricted', () => {
    const target = path.join(outside, 'main.txt')
    expect(file.writeFile(app, target, 'main')).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('main')
    expect(file.deleteFile(target)).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
  })

})

describe('The data of the app', () => {

  test('files in userData can be written and deleted', () => {
    const image = path.join(userData, 'workspaces', '123e4567-e89b-12d3-a456-426614174000', 'images', 'a.png')
    expect(write(image)).toBe(true)
    expect(fs.readFileSync(image, 'utf8')).toBe(kContent)
    expect(write(image)).toBe(true)
    expect(remove(image)).toBe(true)
    expect(fs.existsSync(image)).toBe(false)
    expect(remove(image)).toBe(false)
    expect(write(path.join(userData, 'images', '..', 'other.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(userData, 'other.txt'), 'utf8')).toBe(kContent)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('urls of files in userData can be deleted, whatever their form', () => {
    const images = path.join(userData, 'images')
    fs.mkdirSync(images)
    const names = ['native.png', 'standard.png', 'with space.png', 'encoded name.png', '100%.png', 'a%20b.png']
    for (const name of names) fs.writeFileSync(path.join(images, name), 'x')

    // what the app stores: file:// and the native path
    expect(remove(`file://${path.join(images, 'native.png')}`)).toBe(true)
    expect(remove(`file://${path.join(images, 'with space.png')}`)).toBe(true)
    expect(remove(`file://${path.join(images, '100%.png')}`)).toBe(true)
    expect(remove(`file://${path.join(images, 'a%20b.png')}`)).toBe(true)

    // standard urls: file:///C:/... on Windows, percent-encoded
    expect(pathToFileURL(path.join(images, 'encoded name.png')).href).toContain('encoded%20name.png')
    expect(remove(pathToFileURL(path.join(images, 'standard.png')).href)).toBe(true)
    expect(remove(pathToFileURL(path.join(images, 'encoded name.png')).href)).toBe(true)

    expect(fs.readdirSync(images)).toEqual([])
  })

  test('urls are resolved before they are checked', () => {
    const escape = `file://${path.join(userData, 'images', '..', '..', 'outside', 'victim.txt')}`
    const encoded = `file://${userData}/..%2Foutside%2Fvictim.txt`
    expect(remove(escape)).toBe(false)
    expect(remove(encoded)).toBe(false)
    expect(fs.existsSync(victim)).toBe(true)
  })

  test('userData itself and the folders next to it are refused', () => {
    fs.mkdirSync(path.join(root, 'userData-backup'))
    fs.writeFileSync(path.join(root, 'userData-backup', 'a.txt'), 'x')
    expect(write(userData)).toBe(false)
    expect(remove(userData)).toBe(false)
    expect(write(`${userData}.txt`)).toBe(false)
    expect(write(path.join(root, 'userData-backup', 'a.txt'))).toBe(false)
    expect(write(path.join(root, 'userData-backup', 'new.txt'))).toBe(false)
    expect(remove(path.join(root, 'userData-backup', 'a.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'userData-backup', 'a.txt'), 'utf8')).toBe('x')
    expect(fs.readdirSync(path.join(root, 'userData-backup'))).toEqual(['a.txt'])
    expect(fs.existsSync(`${userData}.txt`)).toBe(false)
    expect(fs.statSync(userData).isDirectory()).toBe(true)
  })

  test('.. does not lead out of userData', () => {
    const escapes = [
      path.join(userData, '..', 'outside', 'victim.txt'),
      `${userData}${path.sep}..${path.sep}outside${path.sep}victim.txt`,
      `${userData}/../outside/victim.txt`,
      `${userData}/images/../../outside/victim.txt`,
      `${userData}/../allowed-evil/victim.txt`,
    ]
    for (const escape of escapes) {
      expect(write(escape)).toBe(false)
      expect(remove(escape)).toBe(false)
      expect(remove(`file://${escape}`)).toBe(false)
    }
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.readFileSync(path.join(sibling, 'victim.txt'), 'utf8')).toBe('victim')
  })

  test('a link to a folder outside is not followed', (ctx) => {
    linkOrSkip(ctx, outside, path.join(userData, 'link'), 'junction')
    expect(write(path.join(userData, 'link', 'victim.txt'))).toBe(false)
    expect(write(path.join(userData, 'link', 'new.txt'))).toBe(false)
    expect(write(path.join(userData, 'link', 'new-folder', 'new.txt'))).toBe(false)
    expect(remove(path.join(userData, 'link', 'victim.txt'))).toBe(false)
    expect(remove(`file://${path.join(userData, 'link', 'victim.txt')}`)).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.readdirSync(outside)).toEqual(['victim.txt'])
  })

  test('a link to a file outside is not followed, dangling or not', (ctx) => {
    linkOrSkip(ctx, victim, path.join(userData, 'link.txt'), 'file')
    linkOrSkip(ctx, path.join(outside, 'created.txt'), path.join(userData, 'dangling.txt'), 'file')
    expect(write(path.join(userData, 'link.txt'))).toBe(false)
    expect(write(path.join(userData, 'dangling.txt'))).toBe(false)
    expect(remove(path.join(userData, 'link.txt'))).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.existsSync(path.join(outside, 'created.txt'))).toBe(false)
  })

  test('a link that stays in userData is followed', (ctx) => {
    fs.mkdirSync(path.join(userData, 'media'))
    linkOrSkip(ctx, path.join(userData, 'media'), path.join(userData, 'images'), 'junction')
    expect(write(path.join(userData, 'images', 'a.png'))).toBe(true)
    expect(fs.readFileSync(path.join(userData, 'media', 'a.png'), 'utf8')).toBe(kContent)
    expect(remove(`file://${path.join(userData, 'images', 'a.png')}`)).toBe(true)
    expect(fs.existsSync(path.join(userData, 'media', 'a.png'))).toBe(false)
  })

  test('a userData folder that is itself a link allows what is really inside', (ctx) => {
    const real = path.join(root, 'profile')
    fs.mkdirSync(real)
    fs.rmdirSync(userData)
    linkOrSkip(ctx, real, userData, 'junction')
    expect(write(path.join(userData, 'a.txt'))).toBe(true)
    expect(write(path.join(real, 'b.txt'))).toBe(true)
    expect(write(path.join(outside, 'new.txt'))).toBe(false)
    expect(remove(userData)).toBe(false)
    expect(fs.readdirSync(real).sort()).toEqual(['a.txt', 'b.txt'])
  })

  test('drawings of the design studio can be deleted from the temp folder, nothing else', () => {
    const drawing = path.join(temp, 'drawing-1764201600000.png')
    fs.writeFileSync(drawing, 'x')
    fs.mkdirSync(path.join(temp, 'sub'))
    for (const name of ['other.png', 'drawing-1.png.exe', 'drawing-.png', path.join('sub', 'drawing-1.png')]) {
      fs.writeFileSync(path.join(temp, name), 'x')
      expect(remove(path.join(temp, name))).toBe(false)
      expect(fs.existsSync(path.join(temp, name))).toBe(true)
    }
    expect(write(drawing)).toBe(false)
    expect(fs.readFileSync(drawing, 'utf8')).toBe('x')
    expect(remove(`file://${drawing}`)).toBe(true)
    expect(fs.existsSync(drawing)).toBe(false)
  })

})

describe('Folders of the filesystem plugin', () => {

  beforeEach(() => {
    fs.writeFileSync(path.join(allowed, 'notes.txt'), 'notes')
  })

  test('files in a configured folder can be written and deleted', () => {
    const target = path.join(allowed, 'sub', 'new.txt')
    expect(write(target, settings())).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe(kContent)
    expect(remove(target, settings())).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
    expect(write(path.join(allowed, 'notes.txt'), () => settings())).toBe(true)
    expect(fs.readFileSync(path.join(allowed, 'notes.txt'), 'utf8')).toBe(kContent)
    expect(write(path.join(allowed, 'sub', '..', 'other.txt'), settings())).toBe(true)
    expect(fs.readFileSync(path.join(allowed, 'other.txt'), 'utf8')).toBe(kContent)
    expect(remove(pathToFileURL(path.join(allowed, 'other.txt')).href, settings())).toBe(true)
    expect(fs.readdirSync(allowed).sort()).toEqual(['notes.txt', 'sub'])
  })

  test('the settings are only read when nothing else allows the path', () => {
    const source = vi.fn(() => settings())
    expect(write(path.join(userData, 'a.txt'), source)).toBe(true)
    expect(source).not.toHaveBeenCalled()
    expect(write(path.join(allowed, 'a.txt'), source)).toBe(true)
    expect(source).toHaveBeenCalledTimes(1)
  })

  test('nothing is allowed outside of the configured folders', () => {
    for (const config of [settings(), settings({ allowedPaths: [allowed, path.join(root, 'missing')] })]) {
      expect(write(victim, config)).toBe(false)
      expect(write(path.join(outside, 'new.txt'), config)).toBe(false)
      expect(remove(victim, config)).toBe(false)
    }
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.readdirSync(outside)).toEqual(['victim.txt'])
  })

  test('a folder with the same prefix is not inside', () => {
    expect(write(path.join(sibling, 'victim.txt'), settings())).toBe(false)
    expect(write(path.join(sibling, 'new.txt'), settings())).toBe(false)
    expect(remove(path.join(sibling, 'victim.txt'), settings())).toBe(false)
    expect(write(`${allowed}.txt`, settings())).toBe(false)
    expect(fs.readFileSync(path.join(sibling, 'victim.txt'), 'utf8')).toBe('victim')
    expect(fs.readdirSync(sibling)).toEqual(['victim.txt'])
    expect(fs.existsSync(`${allowed}.txt`)).toBe(false)
  })

  test('the folder itself is not a file inside', () => {
    expect(fileAccess.authorizeFileAccess(app, 'write', allowed, settings())).toBeNull()
    expect(fileAccess.authorizeFileAccess(app, 'delete', allowed, settings())).toBeNull()
    expect(write(allowed, settings())).toBe(false)
    expect(remove(allowed, settings())).toBe(false)
    expect(fs.statSync(allowed).isDirectory()).toBe(true)
    expect(fs.readdirSync(allowed)).toEqual(['notes.txt'])
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  test('.. does not lead out of the folder', () => {
    const escapes = [
      path.join(allowed, '..', 'outside', 'victim.txt'),
      `${allowed}${path.sep}..${path.sep}outside${path.sep}victim.txt`,
      `${allowed}/../outside/victim.txt`,
      `${allowed}/sub/../../outside/victim.txt`,
      `${allowed}/../allowed-evil/victim.txt`,
    ]
    for (const escape of escapes) {
      expect(write(escape, settings())).toBe(false)
      expect(remove(escape, settings())).toBe(false)
      expect(remove(`file://${escape}`, settings())).toBe(false)
    }
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.readFileSync(path.join(sibling, 'victim.txt'), 'utf8')).toBe('victim')
  })

  test('a link to a folder outside is not followed', (ctx) => {
    linkOrSkip(ctx, outside, path.join(allowed, 'link'), 'junction')
    expect(write(path.join(allowed, 'link', 'victim.txt'), settings())).toBe(false)
    expect(write(path.join(allowed, 'link', 'new.txt'), settings())).toBe(false)
    expect(write(path.join(allowed, 'link', 'new-folder', 'new.txt'), settings())).toBe(false)
    expect(remove(path.join(allowed, 'link', 'victim.txt'), settings())).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.readdirSync(outside)).toEqual(['victim.txt'])
  })

  test('a link to a file outside is not followed, dangling or not', (ctx) => {
    linkOrSkip(ctx, victim, path.join(allowed, 'link.txt'), 'file')
    linkOrSkip(ctx, path.join(outside, 'created.txt'), path.join(allowed, 'dangling.txt'), 'file')
    expect(write(path.join(allowed, 'link.txt'), settings())).toBe(false)
    expect(write(path.join(allowed, 'dangling.txt'), settings())).toBe(false)
    expect(remove(path.join(allowed, 'link.txt'), settings())).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.existsSync(path.join(outside, 'created.txt'))).toBe(false)
  })

  test('a link that stays in the folder is followed', (ctx) => {
    fs.mkdirSync(path.join(allowed, 'sub'))
    linkOrSkip(ctx, path.join(allowed, 'sub'), path.join(allowed, 'alias'), 'junction')
    expect(write(path.join(allowed, 'alias', 'new.txt'), settings())).toBe(true)
    expect(fs.readFileSync(path.join(allowed, 'sub', 'new.txt'), 'utf8')).toBe(kContent)
    expect(remove(path.join(allowed, 'alias', 'new.txt'), settings())).toBe(true)
    expect(fs.existsSync(path.join(allowed, 'sub', 'new.txt'))).toBe(false)
  })

  test('a folder configured through a link allows what is really inside', (ctx) => {
    const shortcut = path.join(root, 'shortcut')
    linkOrSkip(ctx, allowed, shortcut, 'junction')
    const config = settings({ allowedPaths: [shortcut] })
    expect(write(path.join(shortcut, 'a.txt'), config)).toBe(true)
    expect(write(path.join(allowed, 'b.txt'), config)).toBe(true)
    expect(write(path.join(sibling, 'new.txt'), config)).toBe(false)
    expect(write(path.join(root, 'new.txt'), config)).toBe(false)
    // the link is the configured folder, not a file in it
    expect(remove(shortcut, config)).toBe(false)
    expect(fs.existsSync(shortcut)).toBe(true)
    expect(fs.readdirSync(allowed).sort()).toEqual(['a.txt', 'b.txt', 'notes.txt'])
    expect(fs.readdirSync(sibling)).toEqual(['victim.txt'])
  })

  test('a path is not mapped to another file inside a configured folder', (ctx) => {
    // the plugin also reads a path as relative to its folder, <allowed>/<path>, when that exists: the ipc takes the path as it is.
    // such a file cannot exist on Windows, where the path starts with a drive
    const shadow = path.join(allowed, victim)
    try {
      fs.mkdirSync(path.dirname(shadow), { recursive: true })
      fs.writeFileSync(shadow, 'inside')
    } catch {
      ctx.skip()
    }
    expect(resolveAllowedPath(victim, [allowed])).toBe(shadow)
    expect(remove(victim, settings())).toBe(false)
    expect(write(victim, settings())).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
    expect(fs.readFileSync(shadow, 'utf8')).toBe('inside')
  })

  test('a disabled or empty plugin allows nothing', () => {
    for (const config of [undefined, {}, settings({ enabled: false }), settings({ allowedPaths: [] }), settings({ allowedPaths: undefined }), settings({ allowedPaths: 'x' as any })]) {
      expect(write(path.join(allowed, 'new.txt'), config)).toBe(false)
      expect(remove(path.join(allowed, 'notes.txt'), config)).toBe(false)
    }
    expect(fs.readdirSync(allowed)).toEqual(['notes.txt'])
  })

  test('without write access, files can be created but not replaced or deleted', () => {
    const config = settings({ allowWrite: false })
    expect(write(path.join(allowed, 'notes.txt'), config)).toBe(false)
    expect(remove(path.join(allowed, 'notes.txt'), config)).toBe(false)
    expect(fs.readFileSync(path.join(allowed, 'notes.txt'), 'utf8')).toBe('notes')
    expect(write(path.join(allowed, 'new.txt'), config)).toBe(true)
    expect(write(path.join(allowed, 'new.txt'), config)).toBe(false)
  })

})

describe('Paths of delete targets', () => {

  test('absolute paths and app urls', () => {
    expect(fileAccess.fileTargetToPath(victim)).toBe(victim)
    expect(fileAccess.fileTargetToPath(`file://${victim}`)).toBe(victim)
    expect(fileAccess.fileTargetToPath(path.join(outside, 'sub', '..', 'victim.txt'))).toBe(victim)
    expect(fileAccess.fileTargetToPath(`file://${path.join(outside, 'missing.txt')}`)).toBe(path.join(outside, 'missing.txt'))
  })

  test('standard urls', () => {
    expect(fileAccess.fileTargetToPath(pathToFileURL(victim).href)).toBe(victim)
    const spaced = path.join(outside, 'my file.txt')
    fs.writeFileSync(spaced, 'x')
    expect(pathToFileURL(spaced).href).toContain('my%20file.txt')
    expect(fileAccess.fileTargetToPath(pathToFileURL(spaced).href)).toBe(spaced)
  })

  test('a name with a percent sign is the literal file when it exists', () => {
    const literal = path.join(outside, 'a%20b.txt')
    const decoded = path.join(outside, 'a b.txt')
    expect(fileAccess.fileTargetToPath(`file://${literal}`)).toBe(literal)
    fs.writeFileSync(decoded, 'x')
    expect(fileAccess.fileTargetToPath(`file://${literal}`)).toBe(decoded)
    fs.writeFileSync(literal, 'x')
    expect(fileAccess.fileTargetToPath(`file://${literal}`)).toBe(literal)
    expect(fileAccess.fileTargetToPath(`file://${path.join(outside, '100%.txt')}`)).toBe(path.join(outside, '100%.txt'))
  })

  test('what is not an absolute path', () => {
    for (const target of ['', 'file://', 'relative.txt', 'file://relative.txt', 'https://example.com/a.png', `${victim}\0`, `file://${victim}\0`, null, undefined, 42, {}]) {
      expect(fileAccess.fileTargetToPath(target)).toBeNull()
    }
    // an encoded NUL is never decoded
    expect(fileAccess.fileTargetToPath(`file://${path.join(outside, 'a%00b')}`)).toBe(path.join(outside, 'a%00b'))
  })

})

describe('The filesystem plugin, end to end', () => {

  const context: PluginExecutionContext = { model: 'mock' }

  let config: FilesystemPluginConfig

  // the preload api, wired to what the main process does on the real file system
  beforeEach(() => {
    useWindowMock()
    config = { enabled: true, allowedPaths: [allowed], allowWrite: true, skipConfirmation: true }
    window.api.file.resolveAllowedPath = vi.fn((targetPath: string, allowedPaths: string[]) => resolveAllowedPath(targetPath, allowedPaths))
    window.api.file.exists = vi.fn((filePath: string) => fs.existsSync(filePath))
    window.api.file.write = vi.fn((filePath: string, content: string) => fileAccess.writeFileFromRenderer(app, filePath, content, () => config))
    window.api.file.delete = vi.fn((filePath: string) => fileAccess.deleteFileFromRenderer(app, filePath, () => config)) as any
    fs.writeFileSync(path.join(allowed, 'notes.txt'), 'notes')
  })

  test('the plugin writes and deletes in its folders', async () => {
    const plugin = new FilesystemPlugin(config, 'workspace1')

    const created = await plugin.execute(context, { action: 'write', path: path.join(allowed, 'sub', 'new.txt'), content: 'hello' })
    expect(created).toStrictEqual({ success: true, path: path.join(allowed, 'sub', 'new.txt') })
    expect(fs.readFileSync(path.join(allowed, 'sub', 'new.txt'), 'utf8')).toBe('hello')

    const replaced = await plugin.execute(context, { action: 'write', path: 'notes.txt', content: 'updated' })
    expect(replaced).toStrictEqual({ success: true, path: path.join(allowed, 'notes.txt') })
    expect(fs.readFileSync(path.join(allowed, 'notes.txt'), 'utf8')).toBe('updated')

    const deleted = await plugin.execute(context, { action: 'delete', path: path.join(allowed, 'sub', 'new.txt') })
    expect(deleted).toStrictEqual({ success: true, path: path.join(allowed, 'sub', 'new.txt') })
    expect(fs.existsSync(path.join(allowed, 'sub', 'new.txt'))).toBe(false)

    expect(console.warn).not.toHaveBeenCalled()
  })

  test('the plugin creates files without write access', async () => {
    config.allowWrite = false
    const plugin = new FilesystemPlugin(config, 'workspace1')
    const created = await plugin.execute(context, { action: 'write', path: path.join(allowed, 'new.txt'), content: 'hello' })
    expect(created.success).toBe(true)
    expect(fs.readFileSync(path.join(allowed, 'new.txt'), 'utf8')).toBe('hello')
  })

  test('the plugin reports a failure when the main process refuses', async () => {
    // a plugin whose own check is gone: the main process still decides
    const plugin = new FilesystemPlugin(config, 'workspace1')
    window.api.file.resolveAllowedPath = vi.fn((targetPath: string) => targetPath)

    const written = await plugin.execute(context, { action: 'write', path: victim, content: 'x' })
    expect(written.success).toBe(false)
    expect(written.error).toBeDefined()
    const deleted = await plugin.execute(context, { action: 'delete', path: victim })
    expect(deleted.success).toBe(false)
    expect(deleted.error).toBeDefined()

    expect(window.api.file.write).toHaveBeenCalledTimes(1)
    expect(window.api.file.delete).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim')
  })

})

describe('The ipc handlers', () => {

  const source = fs.readFileSync(path.join('src', 'main', 'ipc.ts'), 'utf8')

  const handlerOf = (channel: string): string => {
    const match = source.match(new RegExp(`ipcMain\\.on\\(IPC\\.FILE\\.${channel},[\\s\\S]*?\\r?\\n {2}\\}\\);`))
    return match ? match[0] : ''
  }

  test('writing and deleting go through the access check', () => {
    expect(handlerOf('WRITE_FILE')).toContain('fileAccess.writeFileFromRenderer(')
    expect(handlerOf('WRITE_FILE')).not.toMatch(/\bfile\.writeFile\(/)
    expect(handlerOf('DELETE_FILE')).toContain('fileAccess.deleteFileFromRenderer(')
    expect(handlerOf('DELETE_FILE')).not.toMatch(/\bfile\.deleteFile\(/)
  })

  test('picking or saving a file in a dialog grants nothing', () => {
    for (const channel of ['PICK_FILE', 'PICK_DIRECTORY', 'SAVE_FILE', 'DOWNLOAD']) {
      expect(handlerOf(channel)).toContain(`IPC.FILE.${channel}`)
      expect(handlerOf(channel)).not.toContain('fileAccess')
    }
    expect(Object.keys(fileAccess).sort()).toEqual(['authorizeFileAccess', 'deleteFileFromRenderer', 'fileTargetToPath', 'writeFileFromRenderer'])
  })

})
