
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { isPathInside, resolveRealPath } from './path_containment'

// Media (images, videos) named by message content.
//
// The windows of the app are file:// pages without web security: an <img> or a
// <video> loads whatever local or network path its url names. That is a file of
// the user, or a share of somebody else (which is also sent the Windows
// credentials of the user). The only files the app itself references are the
// ones it stored in its data folder (generated images and videos, attachments,
// imported chats), so those are the only local files that are shown.

// not files: their handling is not changed here
const kRemoteProtocols = ['http:', 'https:', 'data:', 'blob:']

export type MediaUrlEnv = {
  // path flavour, so that Windows rules can be exercised on any host
  pathImpl?: path.PlatformPath
  // symlink (and on-disk case) resolution, must accept paths that do not exist
  realPath?: (target: string) => string
}

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// The file url of a reference to a local file, null when it is not one.
// Besides file: urls, an absolute path is understood: /folder/file.png has no scheme
// and C:\folder\file.png parses as a url of scheme "c:". A relative reference is not:
// it would be resolved against the page of the app.
const toFileUrl = (url: string, parsed: URL | null, p: path.PlatformPath): URL | null => {
  if (parsed?.protocol === 'file:') return parsed
  const windows = p.sep === '\\'
  const isPath = parsed === null || (windows && /^[a-z]:$/i.test(parsed.protocol))
  if (!isPath || !p.isAbsolute(url)) return null
  return parseUrl(`file://${url}`)
}

const toLocalPath = (file: URL, p: path.PlatformPath): string | null => {

  const windows = p.sep === '\\'

  // no file of the app needs them, and code that takes the path as "what follows file://"
  // would read past them: "x.png#/../../other" is x.png for a url parser only
  if (file.search || file.hash) return null

  // file://\\server\share\file.png is what the app writes when its data folder is on a
  // network share: the url parser reads it as an empty host and the path //server/share/file.png
  if (windows && file.hostname === '' && /^\/\/[^/]/.test(file.pathname)) {
    file = parseUrl(`file:${file.pathname}`)
    if (!file) return null
  }

  // refuses encoded separators (%2F, and %5C on Windows), which some readers of the url
  // decode into separators, a host on posix and a path without drive letter on Windows
  try {
    return fileURLToPath(file, { windows })
  } catch {
    return null
  }

}

/**
 * The url to load for a media reference found in message content, or null when it
 * must not be loaded.
 * - http:, https:, data: and blob: urls are returned as they are
 * - a file: url or an absolute path is accepted when the file is strictly inside one of
 *   `roots`, lexically and after symlink resolution. The canonical file: url of that
 *   path is returned, so that what is loaded is what was checked whatever the spelling
 *   (backslashes, encoding, `..` segments, `file://C:\...`).
 * - anything else (relative references, other schemes) is refused
 */
export const resolveMediaUrl = (url: unknown, roots: string[], env: MediaUrlEnv = {}): string | null => {

  if (typeof url !== 'string' || url.length === 0 || url.includes('\0')) return null
  if (!Array.isArray(roots)) return null

  const p = env.pathImpl ?? path
  const realPath = env.realPath ?? resolveRealPath

  const parsed = parseUrl(url)
  if (parsed && kRemoteProtocols.includes(parsed.protocol)) return url

  const file = toFileUrl(url, parsed, p)
  const target = file ? toLocalPath(file, p) : null
  if (!target || target.includes('\0') || !p.isAbsolute(target)) return null
  const resolved = p.resolve(target)

  const inside = (root: string): boolean => {
    if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) return false
    const base = p.resolve(root)
    // lexical check first: a path that is outside anyway, a network share for
    // instance, must not be touched at all
    if (!isPathInside(resolved, base, p) || p.relative(base, resolved) === '') return false
    try {
      const realBase = realPath(base)
      const realTarget = realPath(resolved)
      return isPathInside(realTarget, realBase, p) && p.relative(realBase, realTarget) !== ''
    } catch {
      return false
    }
  }

  return roots.some(inside) ? pathToFileURL(resolved, { windows: p.sep === '\\' }).href : null

}
