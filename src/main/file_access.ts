
import { App } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as file from './file'
import { isPathInside, resolveAllowedPath, resolveRealPath } from './path_containment'

// Where the renderer may write or delete files through the generic file IPCs
// (`window.api.file.write` and `window.api.file.delete`).
//
// Without this, whatever runs script in a window, or steers a renderer code
// path, can overwrite or delete any file of the user. The two IPCs are limited to:
// 1. the data of the app: its `userData` folder, and the drawings of the design
//    studio in the temp folder (delete only),
// 2. the folders the user chose for file access: the allowed paths of the
//    filesystem plugin in the settings, with the rules of the plugin.
//
// Picking a file or a folder in a dialog grants nothing here: a file picked to be
// read (an attachment, a document folder) must not become writable.
//
// Main process code that calls `file.writeFile` / `file.deleteFile` directly is
// not concerned: only the IPC entry points go through this module.

export type FileOperation = 'write' | 'delete'

// the part of the filesystem plugin settings that grants access
export type FilesystemAccessConfig = {
  enabled?: boolean
  allowedPaths?: string[]
  allowWrite?: boolean
}

// the settings, or how to get them: they are only read when nothing else allows the path
export type FilesystemAccessSource = FilesystemAccessConfig | (() => FilesystemAccessConfig | undefined)

const FILE_URL_PREFIX = 'file://'

// DrawingCanvas.vue saves its drawings as `drawing-<timestamp>.png` in the temp folder
// and the design studio deletes them when the media is replaced or removed
const TEMP_DRAWING_NAME = /^drawing-\d+\.png$/

const isUsablePath = (target: unknown): target is string => {
  return typeof target === 'string' && target.length > 0 && !target.includes('\0')
}

/**
 * Path of a delete target that is either an absolute path or a `file://` url.
 * The app builds its urls as `file://` followed by the native path; a standard
 * url (`file:///C:/folder/a%20b.png`) is understood too. Returns null for
 * anything that is not an absolute path once decoded.
 */
export const fileTargetToPath = (target: unknown): string | null => {

  if (!isUsablePath(target)) return null

  if (!target.startsWith(FILE_URL_PREFIX)) {
    return path.isAbsolute(target) ? path.resolve(target) : null
  }

  // file:///C:/folder/file.png gives /C:/folder/file.png
  let literal = target.slice(FILE_URL_PREFIX.length)
  if (path.sep === '\\' && /^\/[A-Za-z]:([\\/]|$)/.test(literal)) {
    literal = literal.slice(1)
  }

  // the literal path wins when it exists: a file name can hold a percent sign
  const candidates = [literal]
  if (literal.includes('%')) {
    try {
      const decoded = decodeURIComponent(literal)
      if (decoded !== literal && !decoded.includes('\0')) candidates.push(decoded)
    } catch {
      // not an encoded url
    }
  }

  const absolute = candidates.filter((candidate) => candidate.length > 0 && path.isAbsolute(candidate))
  if (!absolute.length) return null
  return path.resolve(absolute.find((candidate) => fs.existsSync(candidate)) ?? absolute[0])

}

// path of `target` below `base` once links are resolved on both sides, null when it is not strictly below
const realPathBelow = (target: string, base: string): string | null => {
  if (!isUsablePath(base)) return null
  try {
    const realBase = resolveRealPath(base)
    const realTarget = resolveRealPath(target)
    if (!isPathInside(realTarget, realBase)) return null
    return path.relative(realBase, realTarget) || null
  } catch {
    return null
  }
}

const isSameRealPath = (a: string, b: string): boolean => {
  try {
    return path.relative(resolveRealPath(a), resolveRealPath(b)) === ''
  } catch {
    return false
  }
}

const appFolder = (app: App, name: 'userData' | 'temp'): string | null => {
  try {
    return app.getPath(name) || null
  } catch {
    return null
  }
}

// same rules as the plugin: new files need the plugin, existing files need write access too
const isAllowedByFilesystemPlugin = (operation: FileOperation, target: string, source?: FilesystemAccessSource): boolean => {
  const config = typeof source === 'function' ? source() : source
  if (!config?.enabled || !Array.isArray(config.allowedPaths) || !config.allowedPaths.length) return false
  if (!config.allowWrite && (operation === 'delete' || fs.existsSync(target))) return false
  // the mapping also understands paths relative to an allowed folder: here the path itself must be inside
  const isInside = (candidate: string): boolean => {
    const mapped = resolveAllowedPath(candidate, config.allowedPaths)
    return mapped !== null && isSameRealPath(mapped, candidate)
  }
  // the folder that holds the target is inside too: an allowed folder is not one of its own files
  return isInside(target) && isInside(path.dirname(target))
}

/**
 * Decides whether the renderer may write or delete `target`.
 * Returns the absolute path to act on, with no `.` or `..` segment, or null
 * when the target is outside of the allowed locations. Callers must use the
 * returned path, not the one they were given.
 */
export const authorizeFileAccess = (app: App, operation: FileOperation, target: unknown, filesystemConfig?: FilesystemAccessSource): string | null => {

  // only delete takes urls: this is how the app refers to its attachments
  const resolved = operation === 'delete'
    ? fileTargetToPath(target)
    : (isUsablePath(target) && path.isAbsolute(target) ? path.resolve(target) : null)
  if (!resolved) return null

  // the data of the app
  const userData = appFolder(app, 'userData')
  if (userData && realPathBelow(resolved, userData)) return resolved

  // drawings of the design studio
  if (operation === 'delete') {
    const temp = appFolder(app, 'temp')
    const drawing = temp ? realPathBelow(resolved, temp) : null
    if (drawing && TEMP_DRAWING_NAME.test(drawing)) return resolved
  }

  // configured for the filesystem plugin
  if (isAllowedByFilesystemPlugin(operation, resolved, filesystemConfig)) return resolved

  return null

}

const describeTarget = (target: unknown): string => {
  return typeof target === 'string' ? target.slice(0, 1024) : `<${typeof target}>`
}

// a check that fails is a refusal: the ipc caller gets the usual failure value, never an exception
const authorizeOrRefuse = (app: App, operation: FileOperation, target: unknown, filesystemConfig?: FilesystemAccessSource): string | null => {
  let allowed: string | null = null
  try {
    allowed = authorizeFileAccess(app, operation, target, filesystemConfig)
  } catch (error) {
    console.error(`Error while checking if a file can be ${operation === 'write' ? 'written' : 'deleted'}`, error)
  }
  if (!allowed) {
    console.warn(`Refusing to ${operation} a file outside of the allowed locations`, describeTarget(target))
  }
  return allowed
}

/** `IPC.FILE.WRITE_FILE`: same result as `file.writeFile`, false when the path is not allowed. */
export const writeFileFromRenderer = (app: App, filePath: unknown, content: string, filesystemConfig?: FilesystemAccessSource): boolean => {
  const allowed = authorizeOrRefuse(app, 'write', filePath, filesystemConfig)
  return allowed ? file.writeFile(app, allowed, content) : false
}

/** `IPC.FILE.DELETE_FILE`: same result as `file.deleteFile`, false when the path is not allowed. */
export const deleteFileFromRenderer = (app: App, target: unknown, filesystemConfig?: FilesystemAccessSource): boolean => {
  const allowed = authorizeOrRefuse(app, 'delete', target, filesystemConfig)
  return allowed ? file.deleteFile(allowed) : false
}
