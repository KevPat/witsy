import archiver from 'archiver'
import { App, dialog } from 'electron'
import extractZip from 'extract-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import defaultSettings from '@root/defaults/settings.json'
import { writeFileAtomicSync } from './atomic'
import { keepLocalSecrets, keepLocalSettingsSecrets, stripSecrets } from './backup_secrets'
import { commandsFilePath } from './commands'
import { extractApiKeys, loadApiKeys, settingsFilePath } from './config'
import * as file from './file'
import { useI18n } from './i18n'
import { workspacesFolder } from './workspace'

// A backup never carries key material: the key store (apiKeys.json) is not part of it, and the
// files that can hold a key, a token or a password go in, and come back, without them
// (see backup_secrets.ts). Restoring never imports a key: the ones of this computer are kept.

const kSettingsFile = 'settings.json'

// files to backup with their respective paths
const filesToBackup = (app: App) => ([
  { name: kSettingsFile, path: settingsFilePath(app) },
  { name: 'commands.json', path: commandsFilePath(app) }
])

// Folders to backup with their respective paths
const foldersToBackup = (app: App) => ([
  { name: 'engines', path: path.join(app.getPath('userData'), 'engines') },
  { name: 'workspaces', path: workspacesFolder(app) },
])

// the files of a folder that can hold a secret: the definition of a workspace (web app urls)
// and its agents (webhook token). relative is the path inside the folder, with forward slashes.
// agent runs, one level below, are conversations: they are not looked at
const holdsSecrets = (folder: string, relative: string): boolean => {
  return folder === 'workspaces' && /^[^/]+\/(workspace\.json|agents\/[^/]+\.json)$/i.test(relative)
}

const isPlainObject = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// (a byte order mark is accepted)
const readJson = (source: string): unknown => {
  return JSON.parse(fs.readFileSync(source, 'utf-8').replace(/^\uFEFF/, ''))
}

// the content of a JSON file without its secrets. null when it cannot be parsed:
// what cannot be checked never goes in a backup, or out of one, as it is
const readWithoutSecrets = (source: string): string | null => {
  try {
    return JSON.stringify(stripSecrets(readJson(source)), null, 2)
  } catch (error) {
    console.warn(`Backup: ${source} is not valid JSON and is left out:`, error instanceof Error ? error.message : error)
    return null
  }
}

// the files of a folder, down to a given depth, as relative paths with forward slashes
const listFiles = (root: string, depth: number, prefix: string = ''): string[] => {
  const files: string[] = []
  for (const entry of fs.readdirSync(prefix ? path.join(root, prefix) : root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (depth > 1) files.push(...listFiles(root, depth - 1, relative))
    } else {
      files.push(relative)
    }
  }
  return files
}

export const exportBackup = async (app: App): Promise<boolean> => {
  try {
    // Pick a directory to save the backup
    const targetDir = file.pickDirectory(app)
    if (!targetDir) {
      return false
    }

    // Create backup filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0]
    const backupFilename = `witsy-backup-${timestamp}.zip`
    const backupPath = path.join(targetDir, backupFilename)

    // Create a file to stream archive data to
    const output = fs.createWriteStream(backupPath)
    const archive = archiver('zip', {
      zlib: { level: 9 } // Compression level
    })

    // an error of the archiver or of the file makes the export fail: throwing from these event
    // handlers would be an uncaught exception, out of reach of the try/catch below
    let failed = false
    let reportFailure: () => void = () => {}
    const fail = (err: Error) => {
      if (failed) return
      failed = true
      console.error('Error creating backup:', err)
      try { output.destroy() } catch { /* empty */ }
      reportFailure()
    }

    // Good practice to catch warnings (ie stat failures and other non-blocking errors)
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('Backup warning:', err)
      } else {
        fail(err)
      }
    })

    // Good practice to catch this error explicitly
    archive.on('error', fail)
    output.on('error', fail)

    // Pipe archive data to the file
    archive.pipe(output)

    // Add individual files: the settings as a copy without secrets, never as the file itself
    for (const fileInfo of filesToBackup(app)) {
      if (!fs.existsSync(fileInfo.path)) continue
      if (fileInfo.name === kSettingsFile) {
        const content = readWithoutSecrets(fileInfo.path)
        if (content !== null) {
          archive.append(content, { name: fileInfo.name })
        }
      } else {
        archive.file(fileInfo.path, { name: fileInfo.name })
      }
    }

    // Add folders if they exist: same for the files that can hold a secret
    for (const folder of foldersToBackup(app)) {
      if (!fs.existsSync(folder.path)) continue
      archive.directory(folder.path, folder.name, (entry) => {
        return holdsSecrets(folder.name, String(entry.name).replace(/\\/g, '/')) ? false : entry
      })
      let checked: string[] = []
      try {
        checked = listFiles(folder.path, 3).filter((name) => holdsSecrets(folder.name, name))
      } catch (error) {
        // without the list these files would be missing from the backup: better no backup than half of one
        fail(error as Error)
        break
      }
      for (const relative of checked) {
        const content = readWithoutSecrets(path.join(folder.path, relative))
        if (content !== null) {
          archive.append(content, { name: `${folder.name}/${relative}` })
        }
      }
    }

    // Wait for stream to close
    const created = await new Promise<boolean>((resolve) => {

      reportFailure = () => resolve(false)

      output.on('close', () => {
        if (failed) {
          // do not leave half a backup behind
          try { fs.rmSync(backupPath, { force: true }) } catch { /* empty */ }
          return
        }
        console.log(`Backup created: ${backupPath} (${archive.pointer()} bytes)`)
        resolve(true)
      })

      // (a failure while the files were added: the file is removed when it closes)
      if (failed) {
        return resolve(false)
      }

      // Finalize the archive
      try {
        const finalizing: any = archive.finalize()
        finalizing?.catch?.(fail)
      } catch (err) {
        fail(err as Error)
      }
    })

    // the user must know now, while the keys are at hand, that the backup does not hold them
    if (created) {
      try {
        const t = useI18n(app)
        await dialog.showMessageBox({
          type: 'info',
          title: t('backup.export.done.title'),
          message: t('backup.export.done.message', { file: backupFilename }),
          detail: t('backup.export.done.detail'),
          buttons: [t('common.ok')]
        })
      } catch (dialogError) {
        console.warn('Error reporting the backup:', dialogError)
      }
    }

    return created

  } catch (error) {
    console.error('Error during backup export:', error)
    return false
  }
}

export const importBackup = async (app: App, quitApp: () => void): Promise<boolean> => {

  const t = useI18n(app)

  try {

    // Show confirmation dialog
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: t('backup.restore.confirm.title'),
      message: t('backup.restore.confirm.message'),
      detail: `${t('backup.restore.confirm.detail')}\n\n${t('backup.restore.confirm.keys')}`,
      buttons: [t('common.cancel'), t('backup.restore.confirm.restore')],
      defaultId: 0,
      cancelId: 0
    })

    // If user cancelled
    if (response.response === 0) {
      return false
    }

    // Pick the backup file
    const backupFile = file.pickFile(app, { 
      location: true, 
      filters: [{ name: t('backup.restore.files'), extensions: ['zip'] }] 
    })
    
    if (!backupFile) {
      return false
    }

    // Create temporary directory for extraction
    const tempDir = path.join(os.tmpdir(), `witsy-restore-${Date.now()}`)
    fs.mkdirSync(tempDir, { recursive: true })

    try {
      // Extract the ZIP file
      await extractZip(backupFile as string, { dir: tempDir })

      // any zip can be picked: check that this one is a backup, and a readable one,
      // before a single file of the user is replaced
      validateBackup(app, tempDir, t)

      // Restore individual files. an apiKeys.json found in an older backup is not one of them:
      // it is the key store of another install and is never copied
      for (const fileInfo of filesToBackup(app)) {
        const source = path.join(tempDir, fileInfo.name)
        if (!fs.existsSync(source)) continue
        if (fileInfo.name === kSettingsFile) {
          restoreSettings(source, fileInfo.path)
        } else {
          fs.copyFileSync(source, fileInfo.path)
        }
        console.log(`Restored: ${fileInfo.path}`)
      }

      // Restore folders if they exist
      for (const folder of foldersToBackup(app)) {
        const source = path.join(tempDir, folder.name)
        if (fs.existsSync(source)) {
          fs.mkdirSync(folder.path, { recursive: true })
          restoreDirectory(source, folder.path, folder.name)
          console.log(`Restored folder: ${folder.path}`)
        }
      }

      // Show success message
      await dialog.showMessageBox({
        type: 'info',
        title: t('backup.restore.restart.title'),
        message: t('backup.restore.restart.message'),
        detail: `${t('backup.restore.restart.keys')}\n\n${t('backup.restore.restart.detail')}`,
        buttons: [t('common.ok')]
      })

      console.log('Backup restoration completed successfully')
      
      // Restart the application if quitApp function is provided
      try {
        app.relaunch()
        quitApp()
      } catch (restartError) {
        console.error('Error restarting app:', restartError)
      }
      
      return true

    } finally {
      // Clean up temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.warn('Error cleaning up temp directory:', cleanupError)
      }
    }

  } catch (error) {
    console.error('Error during backup import:', error)
    
    // Show error message
    await dialog.showMessageBox({
      type: 'error',
      title: t('backup.restore.error.title'),
      message: t('backup.restore.error.message'),
      detail: t('backup.restore.error.detail', { error: error instanceof Error ? error.message : String(error) }),
      buttons: ['OK']
    })
    
    return false
  }
}

// what each JSON file of a backup must hold
const jsonShapes: Record<string, (json: unknown) => boolean> = {
  'settings.json': (json) => typeof json === 'object' && json !== null && !Array.isArray(json),
  'commands.json': (json) => Array.isArray(json),
}

const validateBackup = (app: App, dir: string, t: CallableFunction): void => {

  // at least one of the things we restore
  const names = [...filesToBackup(app), ...foldersToBackup(app)].map(entry => entry.name)
  if (!names.some(name => fs.existsSync(path.join(dir, name)))) {
    throw new Error(t('backup.restore.error.notBackup'))
  }

  // files that are parsed at startup must be parseable
  for (const [name, isValid] of Object.entries(jsonShapes)) {
    const source = path.join(dir, name)
    if (!fs.existsSync(source)) continue
    let valid = false
    try {
      valid = isValid(readJson(source))
    } catch { /* not JSON */ }
    if (!valid) {
      throw new Error(t('backup.restore.error.damaged', { file: name }))
    }
  }

}

// the settings of the backup, without any key it may hold (older backups, backups edited by hand),
// with the secrets this computer already has for the same things. the key store is not touched:
// its keys find their place again when the settings are loaded
const restoreSettings = (source: string, target: string): void => {

  const restored = readJson(source) as Record<string, any>

  // settings that cannot be read have nothing to keep
  let local: unknown = null
  try {
    if (fs.existsSync(target)) local = readJson(target)
  } catch { /* empty */ }
  if (!isPlainObject(local)) local = {}

  let storedKeyNames: string[] = []
  try {
    storedKeyNames = loadApiKeys().map((entry) => entry.name)
  } catch { /* empty */ }

  const settings = keepLocalSettingsSecrets(restored, local as Record<string, any>, extractApiKeys(local as Record<string, any>), storedKeyNames, defaultSettings)
  writeFileAtomicSync(target, JSON.stringify(settings, null, 2))

}

// same for a file of a folder that can hold a secret
const restoreWithoutSecrets = (source: string, target: string): void => {

  let restored: unknown
  try {
    restored = readJson(source)
  } catch (error) {
    console.warn(`Restore: ${path.basename(source)} is not valid JSON and is not restored:`, error instanceof Error ? error.message : error)
    return
  }

  let local: unknown = null
  try {
    if (fs.existsSync(target)) local = readJson(target)
  } catch { /* empty */ }

  fs.writeFileSync(target, JSON.stringify(keepLocalSecrets(restored, local), null, 2))

}

// Helper function to copy a directory of the backup recursively
const restoreDirectory = (src: string, dest: string, folder: string, prefix: string = '') => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      restoreDirectory(srcPath, destPath, folder, relative)
    } else if (holdsSecrets(folder, relative)) {
      restoreWithoutSecrets(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}