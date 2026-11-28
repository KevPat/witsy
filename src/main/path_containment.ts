
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
