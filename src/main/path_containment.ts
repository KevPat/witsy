
import fs from 'fs'
import path from 'path'

// Shared path containment helpers.
//
// A string prefix check (`child.startsWith(base)`) is not a containment check:
// `/work-secret` starts with `/work`, `..` segments survive, a `path.relative`
// result across Windows drives is absolute, and a symlink inside the base can
// point anywhere. Everything that confines a path to a folder should go through
// this module instead.

type PathModule = Pick<typeof path, 'relative' | 'resolve' | 'isAbsolute' | 'sep'>

const MAX_SYMLINK_DEPTH = 40

/**
 * Lexical containment: true when `target` is `base` or below it.
 * No filesystem access, so symlinks are not resolved (see `isRealPathInside`).
 * `pathImpl` lets callers and tests force `path.win32` or `path.posix`.
 */
export const isPathInside = (target: string, base: string, pathImpl: PathModule = path): boolean => {
  if (typeof target !== 'string' || typeof base !== 'string') return false
  if (!target.length || !base.length) return false
  if (target.includes('\0') || base.includes('\0')) return false
  const relative = pathImpl.relative(pathImpl.resolve(base), pathImpl.resolve(target))
  if (relative === '') return true
  if (relative === '..' || relative.startsWith(`..${pathImpl.sep}`)) return false
  // a different drive or UNC share on Windows gives an absolute result
  if (pathImpl.isAbsolute(relative)) return false
  return true
}

const realpath = (target: string): string => {
  // the native version returns the on-disk case on case-insensitive volumes
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(target)
    : fs.realpathSync(target)
}

/**
 * `realpath` that also works for a path that does not exist yet (a file about
 * to be created): the deepest existing ancestor is resolved and the missing
 * segments are appended. A dangling symlink is followed to where it points,
 * so a write through it cannot land outside unnoticed.
 */
export const resolveRealPath = (target: string, depth = 0): string => {

  if (depth > MAX_SYMLINK_DEPTH) {
    throw new Error(`Too many levels of symbolic links: ${target}`)
  }

  const resolved = path.resolve(target)
  const missing: string[] = []
  let current = resolved

  while (true) {

    let stats: fs.Stats | null = null
    try {
      stats = fs.lstatSync(current)
    } catch {
      stats = null
    }

    if (stats) {
      let real: string
      try {
        real = realpath(current)
      } catch (error) {
        if (!stats.isSymbolicLink()) throw error
        const link = fs.readlinkSync(current)
        real = resolveRealPath(path.resolve(path.dirname(current), link), depth + 1)
      }
      return missing.length ? path.join(real, ...missing) : real
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return resolved
    }
    missing.unshift(path.basename(current))
    current = parent

  }

}

/**
 * Containment after symlink resolution on both sides.
 * Returns false when either path cannot be resolved.
 */
export const isRealPathInside = (target: string, base: string): boolean => {
  if (typeof target !== 'string' || typeof base !== 'string') return false
  if (!target.length || !base.length) return false
  if (target.includes('\0') || base.includes('\0')) return false
  try {
    return isPathInside(resolveRealPath(target), resolveRealPath(base))
  } catch {
    return false
  }
}

export type ResolveInsideOptions = {
  // refuse `base` itself, only accept paths strictly below it
  excludeBase?: boolean
  // skip the realpath check (lexical containment only)
  lexicalOnly?: boolean
}

/**
 * Resolves `target` (absolute, or relative to `base`) and returns the absolute
 * path when it stays inside `base`, lexically and after symlink resolution.
 * Returns null otherwise. The returned path is the lexical one, not the
 * realpath, so callers keep showing the path the user knows.
 */
export const resolveInside = (base: string, target: string, opts: ResolveInsideOptions = {}): string | null => {

  if (typeof base !== 'string' || typeof target !== 'string') return null
  if (!base.length || base.includes('\0') || target.includes('\0')) return null

  const resolvedBase = path.resolve(base)
  const resolved = path.resolve(resolvedBase, target)

  if (!isPathInside(resolved, resolvedBase)) return null
  if (opts.excludeBase && path.relative(resolvedBase, resolved) === '') return null

  if (!opts.lexicalOnly) {
    let realBase: string
    let realTarget: string
    try {
      realBase = resolveRealPath(resolvedBase)
      realTarget = resolveRealPath(resolved)
    } catch {
      return null
    }
    if (!isPathInside(realTarget, realBase)) return null
    if (opts.excludeBase && path.relative(realBase, realTarget) === '') return null
  }

  return resolved

}

/**
 * Turns an untrusted name into a single path segment: directory parts are
 * dropped (both separators, whatever the platform) and `.` / `..` / empty
 * names are refused.
 */
export const safeBasename = (name: string): string | null => {
  if (typeof name !== 'string' || name.includes('\0')) return null
  const base = name.split(/[\\/]/).pop() ?? ''
  if (base === '' || base === '.' || base === '..') return null
  return base
}

export type AllowedPathEnv = {
  // path flavour, so that Windows rules can be exercised on any host
  pathImpl?: path.PlatformPath
  // folder that `~` and relative paths start from
  home?: string
  exists?: (target: string) => boolean
  // symlink (and on-disk case) resolution, must accept paths that do not exist
  realPath?: (target: string) => string
}

/**
 * Maps a path chosen by a model to a path inside one of the folders the user
 * allowed, or returns null. Three spellings are understood, in this order:
 * 1. an absolute, `~` or home-relative path inside an allowed folder
 * 2. a path relative to an allowed folder, when it exists
 * 3. a path that starts with the name of an allowed folder, when it exists
 *    (allowed `/x/Documents`, target `./Documents/folder/test.txt`)
 * Whatever the spelling, the candidate is only returned when its real path
 * (symlinks resolved) is inside the real path of the allowed folder. The
 * result is absolute and has no `.` or `..` segment.
 */
export const resolveAllowedPath = (targetPath: string, allowedPaths: string[], env: AllowedPathEnv = {}): string | null => {

  if (typeof targetPath !== 'string' || targetPath.includes('\0')) return null
  if (!Array.isArray(allowedPaths)) return null

  const p = env.pathImpl ?? path
  const home = env.home ?? (process.env.HOME || process.env.USERPROFILE || '')
  const exists = env.exists ?? fs.existsSync
  const realPath = env.realPath ?? resolveRealPath

  // same rules as normalizePath in file.ts
  const absolute = (value: string): string => {
    if (home) {
      if (value === '~') value = home
      else if (value.startsWith('~/') || value.startsWith(`~${p.sep}`)) value = p.join(home, value.slice(2))
      else if (!p.isAbsolute(value)) value = p.join(home, value)
    }
    return p.resolve(value)
  }

  const inside = (base: string, candidate: string): string | null => {
    const resolved = p.resolve(candidate)
    let realBase: string
    let realCandidate: string
    try {
      realBase = realPath(base)
      realCandidate = realPath(resolved)
    } catch {
      return null
    }
    if (!isPathInside(realCandidate, realBase, p)) return null
    // a spelling that only matches once resolved (another case on a case-insensitive
    // volume, a link that leads into the folder) is returned as the real path
    return isPathInside(resolved, base, p) ? resolved : realCandidate
  }

  const bases = allowedPaths
    .filter((allowed) => typeof allowed === 'string' && allowed.length > 0 && !allowed.includes('\0'))
    .map(absolute)

  const target = absolute(targetPath)
  for (const base of bases) {
    const found = inside(base, target)
    if (found) return found
  }

  for (const base of bases) {
    const found = inside(base, p.join(base, targetPath))
    if (found && exists(found)) return found
  }

  // the model may use either separator, whatever the platform
  const relative = targetPath.replace(/^\.[\\/]/, '')
  const parts = relative.split(/[\\/]/)
  for (const base of bases) {
    if (!parts[0] || parts[0].toLowerCase() !== p.basename(base).toLowerCase()) continue
    const parent = p.dirname(base)
    for (const candidate of new Set([p.join(parent, relative), p.join(parent, ...parts)])) {
      const found = inside(base, candidate)
      if (found && exists(found)) return found
    }
  }

  return null

}
