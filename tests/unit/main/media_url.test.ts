
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { resolveMediaUrl } from '@main/media_url'

const isWindows = process.platform === 'win32'

// the rules of one platform, whatever the host: no filesystem behind them
const same = (target: string) => target
const posix = { pathImpl: path.posix, realPath: same }
const win32 = { pathImpl: path.win32, realPath: same }

const posixData = '/Users/me/Library/Application Support/Witsy'
const posixImage = 'file:///Users/me/Library/Application%20Support/Witsy/images/a.png'

const winData = 'C:\\Users\\me\\AppData\\Roaming\\Witsy'
const winImage = 'file:///C:/Users/me/AppData/Roaming/Witsy/images/a.png'

describe('urls that are not files', () => {

  test.each([
    'https://example.com/a.png',
    'http://example.com/a.png?x=1&y=2#z',
    'HTTPS://EXAMPLE.com/a.png',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:https://example.com/2d0d2b5e-7a0c-4f0e-9d3a-0e6c8a1b2c3d',
  ])('returns %s as it is', (url) => {
    expect(resolveMediaUrl(url, [posixData], posix)).toBe(url)
    expect(resolveMediaUrl(url, [winData], win32)).toBe(url)
    expect(resolveMediaUrl(url, [])).toBe(url)
  })

  test.each([
    'smb://evil.example/share/a.png',
    'ftp://evil.example/a.png',
    'javascript:alert(1)',
    'chrome://settings/',
    'search-ms:query=x',
    'sandbox:/mnt/data/a.png',
  ])('refuses the scheme of %s', (url) => {
    expect(resolveMediaUrl(url, [posixData], posix)).toBeNull()
    expect(resolveMediaUrl(url, [winData], win32)).toBeNull()
  })

  test('refuses what is not a url', () => {
    for (const url of ['', null, undefined, 42, {}, ['file:///a.png']]) {
      expect(resolveMediaUrl(url, [posixData], posix)).toBeNull()
    }
    expect(resolveMediaUrl(posixImage, null as unknown as string[], posix)).toBeNull()
  })

})

describe('posix files', () => {

  test.each([
    ['file:///Users/me/Library/Application Support/Witsy/images/a.png', posixImage],
    ['file:///Users/me/Library/Application%20Support/Witsy/images/a.png', posixImage],
    ['file://localhost/Users/me/Library/Application%20Support/Witsy/images/a.png', posixImage],
    ['/Users/me/Library/Application Support/Witsy/images/a.png', posixImage],
    ['file:///Users/me/Library/Application%20Support/Witsy/images/%61.png', posixImage],
    ['file:///Users/me/Library/Application%20Support/Witsy/workspaces/w1/../../images/a.png', posixImage],
    ['file:///Users/me/Library/Application%20Support/Witsy/images/./a.png', posixImage],
    [
      'file:///Users/me/Library/Application Support/Witsy/workspaces/0b5c/images/my video.mp4',
      'file:///Users/me/Library/Application%20Support/Witsy/workspaces/0b5c/images/my%20video.mp4',
    ],
  ])('accepts %s', (url, expected) => {
    expect(resolveMediaUrl(url, [posixData], posix)).toBe(expected)
  })

  test.each([
    // elsewhere
    'file:///Users/me/secret.png',
    'file:///etc/passwd',
    '/Users/me/secret.png',
    // the folder itself, and a folder that only starts with the same name
    'file:///Users/me/Library/Application%20Support/Witsy',
    'file:///Users/me/Library/Application%20Support/Witsy/',
    'file:///Users/me/Library/Application%20Support/Witsy-other/images/a.png',
    // traversal, in every spelling
    'file:///Users/me/Library/Application%20Support/Witsy/../secret.png',
    'file:///Users/me/Library/Application%20Support/Witsy/images/../../../secret.png',
    'file:///Users/me/Library/Application%20Support/Witsy/images/%2e%2e/%2E%2E/%2e%2e/secret.png',
    'file:///Users/me/Library/Application%20Support/Witsy/images/..%2F..%2F..%2Fsecret.png',
    'file:///Users/me/Library/Application%20Support/Witsy/images/..\\..\\..\\secret.png',
    '/Users/me/Library/Application Support/Witsy/images/../../../secret.png',
    // another host
    'file://evil.example/Users/me/Library/Application%20Support/Witsy/images/a.png',
    '//evil.example/share/a.png',
    'file:////evil.example/share/a.png',
    // relative: would be resolved against the page of the app
    'images/a.png',
    './images/a.png',
    '../../secret.png',
    'a.png',
    'http/../../../secret.png',
    'file:images/a.png',
    // what follows is not part of the path for a url parser only
    'file:///Users/me/Library/Application%20Support/Witsy/images/a.png#/../../../secret.png',
    'file:///Users/me/Library/Application%20Support/Witsy/images/a.png?/../../../secret.png',
    // not a path
    'file:///Users/me/Library/Application%20Support/Witsy/images/a%00.png',
    'file:///Users/me/Library/Application%20Support/Witsy/images/a%.png',
    // a Windows path
    'C:\\Users\\me\\Library\\a.png',
    'file://C:\\Users\\me\\Library\\a.png',
  ])('refuses %s', (url) => {
    expect(resolveMediaUrl(url, [posixData], posix)).toBeNull()
  })

  test('accepts the files of any of the folders, and none without folder', () => {
    const roots = ['/data/one', '/data/two']
    expect(resolveMediaUrl('file:///data/one/a.png', roots, posix)).toBe('file:///data/one/a.png')
    expect(resolveMediaUrl('file:///data/two/a.png', roots, posix)).toBe('file:///data/two/a.png')
    expect(resolveMediaUrl('file:///data/three/a.png', roots, posix)).toBeNull()
    expect(resolveMediaUrl('file:///data/one/a.png', [], posix)).toBeNull()
    expect(resolveMediaUrl('file:///data/one/a.png', ['', null as unknown as string], posix)).toBeNull()
  })

})

describe('Windows files', () => {

  test.each([
    // what the app writes: file:// and the path
    ['file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\a.png', winImage],
    ['file:///C:/Users/me/AppData/Roaming/Witsy/images/a.png', winImage],
    ['file://C:/Users/me/AppData/Roaming/Witsy/images/a.png', winImage],
    ['file://localhost/C:/Users/me/AppData/Roaming/Witsy/images/a.png', winImage],
    ['file:///C|/Users/me/AppData/Roaming/Witsy/images/a.png', winImage],
    ['C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\a.png', winImage],
    ['C:/Users/me/AppData/Roaming/Witsy/images/a.png', winImage],
    ['file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\workspaces\\w1\\..\\..\\images\\a.png', winImage],
    ['file:///C:/Users/me/AppData/Roaming/Witsy/images/%61.png', winImage],
    // the volume is not case sensitive: the spelling is kept
    ['file:///c:/users/ME/appdata/roaming/WITSY/images/a.png', 'file:///c:/users/ME/appdata/roaming/WITSY/images/a.png'],
    [
      'file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\workspaces\\0b5c\\images\\my video.mp4',
      'file:///C:/Users/me/AppData/Roaming/Witsy/workspaces/0b5c/images/my%20video.mp4',
    ],
  ])('accepts %s', (url, expected) => {
    expect(resolveMediaUrl(url, [winData], win32)).toBe(expected)
  })

  test.each([
    // elsewhere
    'file:///C:/Users/me/secret.png',
    'file://C:\\Users\\me\\secret.png',
    'C:\\Users\\me\\secret.png',
    'file:///D:/Users/me/AppData/Roaming/Witsy/images/a.png',
    // the folder itself, and a folder that only starts with the same name
    'file://C:\\Users\\me\\AppData\\Roaming\\Witsy',
    'file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\',
    'file://C:\\Users\\me\\AppData\\Roaming\\Witsy-other\\images\\a.png',
    // traversal, in every spelling
    'file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\..\\secret.png',
    'file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\..\\..\\..\\secret.png',
    'file:///C:/Users/me/AppData/Roaming/Witsy/images/../../../secret.png',
    'file:///C:/Users/me/AppData/Roaming/Witsy/images/%2e%2e/%2E%2E/%2e%2e/secret.png',
    'file:///C:/Users/me/AppData/Roaming/Witsy/images/..%5C..%5C..%5Csecret.png',
    'file:///C:/Users/me/AppData/Roaming/Witsy/images/..%2F..%2F..%2Fsecret.png',
    'C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\..\\..\\..\\secret.png',
    // network shares and devices
    'file://evil.example/share/a.png',
    'file://\\\\evil.example\\share\\a.png',
    'file:////evil.example/share/a.png',
    '\\\\evil.example\\share\\a.png',
    '//evil.example/share/a.png',
    'file://evil.example/C$/Users/me/AppData/Roaming/Witsy/images/a.png',
    'file://./C:/Users/me/AppData/Roaming/Witsy/images/a.png',
    'file://?/C:/Users/me/AppData/Roaming/Witsy/images/a.png',
    '\\\\?\\C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\a.png',
    // no drive, or relative to the current folder of the drive
    'file:///Users/me/AppData/Roaming/Witsy/images/a.png',
    '\\Users\\me\\AppData\\Roaming\\Witsy\\images\\a.png',
    'C:images\\a.png',
    'images\\a.png',
    '..\\..\\secret.png',
    'http/../../../secret.png',
    // what follows is not part of the path for a url parser only
    'file:///C:/Users/me/AppData/Roaming/Witsy/images/a.png#/../../../secret.png',
    'file://C:\\Users\\me\\AppData\\Roaming\\Witsy\\images\\a.png?\\..\\..\\..\\secret.png',
    // not a path
    'file:///C:/Users/me/AppData/Roaming/Witsy/images/a%00.png',
  ])('refuses %s', (url) => {
    expect(resolveMediaUrl(url, [winData], win32)).toBeNull()
  })

  test('accepts the files of a data folder that is on a network share', () => {
    const shared = '\\\\server\\profiles\\me\\AppData\\Roaming\\Witsy'
    const expected = 'file://server/profiles/me/AppData/Roaming/Witsy/images/a.png'
    expect(resolveMediaUrl('file://\\\\server\\profiles\\me\\AppData\\Roaming\\Witsy\\images\\a.png', [shared], win32)).toBe(expected)
    expect(resolveMediaUrl('file://server/profiles/me/AppData/Roaming/Witsy/images/a.png', [shared], win32)).toBe(expected)
    expect(resolveMediaUrl('file://\\\\server\\profiles\\me\\secret.png', [shared], win32)).toBeNull()
    expect(resolveMediaUrl('file://\\\\other\\profiles\\me\\AppData\\Roaming\\Witsy\\images\\a.png', [shared], win32)).toBeNull()
    expect(resolveMediaUrl('file://\\\\server\\profiles\\me\\AppData\\Roaming\\Witsy\\images\\..\\..\\..\\secret.png', [shared], win32)).toBeNull()
  })

})

describe('links', () => {

  test('refuses a file that is a link to the outside', () => {
    const realPath = (target: string) => target.replace('/data/witsy/images/link', '/home/me/secret')
    expect(resolveMediaUrl('file:///data/witsy/images/a.png', ['/data/witsy'], { pathImpl: path.posix, realPath })).toBe('file:///data/witsy/images/a.png')
    expect(resolveMediaUrl('file:///data/witsy/images/link/a.png', ['/data/witsy'], { pathImpl: path.posix, realPath })).toBeNull()
    expect(resolveMediaUrl('file:///data/witsy/images/link', ['/data/witsy'], { pathImpl: path.posix, realPath })).toBeNull()
  })

  test('accepts a data folder that is itself reached through a link', () => {
    const realPath = (target: string) => target.replace('/data/witsy', '/volumes/disk/witsy')
    expect(resolveMediaUrl('file:///data/witsy/images/a.png', ['/data/witsy'], { pathImpl: path.posix, realPath })).toBe('file:///data/witsy/images/a.png')
  })

  test('refuses when the real path cannot be read', () => {
    const realPath = () => { throw new Error('EACCES') }
    expect(resolveMediaUrl('file:///data/witsy/images/a.png', ['/data/witsy'], { pathImpl: path.posix, realPath })).toBeNull()
  })

  test('does not touch a path that is outside anyway', () => {
    const realPath = vi.fn(same)
    expect(resolveMediaUrl('file://evil.example/share/a.png', [winData], { pathImpl: path.win32, realPath })).toBeNull()
    expect(resolveMediaUrl('\\\\evil.example\\share\\a.png', [winData], { pathImpl: path.win32, realPath })).toBeNull()
    expect(resolveMediaUrl('file:///C:/Users/me/secret.png', [winData], { pathImpl: path.win32, realPath })).toBeNull()
    expect(resolveMediaUrl('file:///etc/passwd', [posixData], { pathImpl: path.posix, realPath })).toBeNull()
    expect(realPath).not.toHaveBeenCalled()
    expect(resolveMediaUrl(winImage, [winData], { pathImpl: path.win32, realPath })).toBe(winImage)
    expect(realPath).toHaveBeenCalled()
  })

})

describe('on the filesystem of the host', () => {

  let root: string
  let appData: string
  let outside: string

  // what the app writes in message content: file:// and the path
  const appUrl = (...segments: string[]) => `file://${path.join(...segments)}`

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-media-')))
    appData = path.join(root, 'Witsy Data')
    outside = path.join(root, 'secret')
    fs.mkdirSync(path.join(appData, 'images'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(appData, 'images', 'a.png'), 'image')
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('accepts a file of the folder, however it is written', () => {
    const expected = pathToFileURL(path.join(appData, 'images', 'a.png')).href
    expect(expected).toContain('Witsy%20Data/images/a.png')
    expect(resolveMediaUrl(appUrl(appData, 'images', 'a.png'), [appData])).toBe(expected)
    expect(resolveMediaUrl(expected, [appData])).toBe(expected)
    expect(resolveMediaUrl(path.join(appData, 'images', 'a.png'), [appData])).toBe(expected)
    expect(resolveMediaUrl(`file://${appData}${path.sep}images${path.sep}..${path.sep}images${path.sep}a.png`, [appData])).toBe(expected)
  })

  test('accepts a file of the folder that does not exist', () => {
    expect(resolveMediaUrl(appUrl(appData, 'images', 'missing.png'), [appData])).toBe(pathToFileURL(path.join(appData, 'images', 'missing.png')).href)
  })

  test('refuses a file outside of the folder', () => {
    expect(resolveMediaUrl(appUrl(outside, 'secret.png'), [appData])).toBeNull()
    expect(resolveMediaUrl(pathToFileURL(path.join(outside, 'secret.png')).href, [appData])).toBeNull()
    expect(resolveMediaUrl(path.join(outside, 'secret.png'), [appData])).toBeNull()
    expect(resolveMediaUrl(`file://${appData}${path.sep}images${path.sep}..${path.sep}..${path.sep}secret${path.sep}secret.png`, [appData])).toBeNull()
    expect(resolveMediaUrl(`${pathToFileURL(appData).href}/images/%2e%2e/%2e%2e/secret/secret.png`, [appData])).toBeNull()
    expect(resolveMediaUrl(appUrl(appData), [appData])).toBeNull()
    expect(resolveMediaUrl(appUrl(appData, 'images', 'a.png'), [])).toBeNull()
  })

  // a junction is a directory link that Windows lets any user create
  test('refuses a link that leaves the folder and accepts one that stays inside', () => {
    fs.symlinkSync(outside, path.join(appData, 'images', 'out'), 'junction')
    fs.symlinkSync(path.join(appData, 'images'), path.join(appData, 'pictures'), 'junction')
    expect(resolveMediaUrl(appUrl(appData, 'images', 'out', 'secret.png'), [appData])).toBeNull()
    expect(resolveMediaUrl(appUrl(appData, 'images', 'out', 'missing.png'), [appData])).toBeNull()
    expect(resolveMediaUrl(appUrl(appData, 'pictures', 'a.png'), [appData])).toBe(pathToFileURL(path.join(appData, 'pictures', 'a.png')).href)
  })

  test('accepts a folder that is itself reached through a link', () => {
    const alias = path.join(root, 'alias')
    fs.symlinkSync(appData, alias, 'junction')
    expect(resolveMediaUrl(appUrl(alias, 'images', 'a.png'), [alias])).toBe(pathToFileURL(path.join(alias, 'images', 'a.png')).href)
    expect(resolveMediaUrl(appUrl(outside, 'secret.png'), [alias])).toBeNull()
  })

  test.runIf(isWindows)('accepts another case on Windows', () => {
    const url = appUrl(appData, 'images', 'a.png').toUpperCase().replace('FILE://', 'file://')
    expect(resolveMediaUrl(url, [appData])).not.toBeNull()
    expect(resolveMediaUrl(appUrl(outside, 'secret.png').toUpperCase().replace('FILE://', 'file://'), [appData])).toBeNull()
  })

})
