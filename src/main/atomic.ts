
import fs from 'fs'
import path from 'path'

const RENAME_RETRIES = 5
const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES']

let counter = 0

const renameWithRetry = (source: string, target: string): void => {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, target)
      return
    } catch (error) {
      // on Windows the target can be held for a moment by an antivirus or an indexer
      const retryable = process.platform === 'win32' && RENAME_RETRY_CODES.includes((error as NodeJS.ErrnoException)?.code)
      if (!retryable || attempt >= RENAME_RETRIES) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
    }
  }
}

/**
 * Writes a file so that a crash, a full disk or a power loss mid-write never leaves a truncated file:
 * the data goes to a temporary file in the same folder which then replaces the target in one rename.
 * On failure the previous content of the target is untouched and the error is thrown.
 */
export const writeFileAtomicSync = (file: string, data: string | NodeJS.ArrayBufferView, encoding: BufferEncoding = 'utf-8'): void => {

  // a symlinked file (dotfiles) must stay a symlink: replace what it points to
  let target = file
  let mode: number | undefined
  try {
    target = fs.realpathSync(file)
    mode = fs.statSync(target).mode & 0o777
  } catch { /* the file does not exist yet */ }

  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${counter++}.tmp`)

  try {
    const fd = fs.openSync(temp, 'w', mode)
    try {
      fs.writeFileSync(fd, data, typeof data === 'string' ? encoding : undefined)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetry(temp, target)
  } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
    throw error
  }

}

/**
 * Copies a file next to itself before it is replaced or discarded (unreadable JSON, failed migration...).
 * Returns the path of the copy, or null when there was nothing to copy or the copy failed.
 */
export const backupFile = (file: string, tag: string = 'bak'): string | null => {
  try {
    if (!fs.existsSync(file)) return null
    const parsed = path.parse(file)
    const backup = path.join(parsed.dir, `${parsed.name}.${tag}${parsed.ext}`)
    fs.copyFileSync(file, backup)
    return backup
  } catch (error) {
    console.error(`Could not back up ${file}`, error)
    return null
  }
}

/**
 * Same as backupFile with a timestamp in the name, so that successive corrupt files do not overwrite each other.
 */
export const backupCorruptFile = (file: string): string | null => {
  return backupFile(file, `corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
}
