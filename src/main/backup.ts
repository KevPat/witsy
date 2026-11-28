import archiver from 'archiver'
import { App, dialog } from 'electron'
import extractZip from 'extract-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandsFilePath } from './commands'
import { apiKeysFilePath, settingsFilePath } from './config'
import * as file from './file'
import { useI18n } from './i18n'
import { workspacesFolder } from './workspace'

// files to backup with their respective paths
const filesToBackup = (app: App) => ([
  { name: 'settings.json', path: settingsFilePath(app) },
  { name: 'apiKeys.json', path: apiKeysFilePath(app) },
  { name: 'commands.json', path: commandsFilePath(app) }
])

// Folders to backup with their respective paths
const foldersToBackup = (app: App) => ([
  { name: 'engines', path: path.join(app.getPath('userData'), 'engines') },
  { name: 'workspaces', path: workspacesFolder(app) },
])

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

    // Add individual files
    for (const fileInfo of filesToBackup(app)) {
      if (fs.existsSync(fileInfo.path)) {
        archive.file(fileInfo.path, { name: fileInfo.name })
      }
    }

    // Add folders if they exist
    for (const folder of foldersToBackup(app)) {
      if (fs.existsSync(folder.path)) {
        archive.directory(folder.path, folder.name)
      }
    }

    // Wait for stream to close
    return await new Promise<boolean>((resolve) => {

      reportFailure = () => resolve(false)
      if (failed) {
        return resolve(false)
      }

      output.on('close', () => {
        if (failed) {
          // do not leave half a backup behind
          try { fs.rmSync(backupPath, { force: true }) } catch { /* empty */ }
          return
        }
        console.log(`Backup created: ${backupPath} (${archive.pointer()} bytes)`)
        resolve(true)
      })

      // Finalize the archive
      try {
        const finalizing: any = archive.finalize()
        finalizing?.catch?.(fail)
      } catch (err) {
        fail(err as Error)
      }
    })

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
      detail: t('backup.restore.confirm.detail'),
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

      // Get target file paths
      const targetFiles = filesToBackup(app).map(fileInfo => ({
        source: path.join(tempDir, fileInfo.name),
        target: fileInfo.path,
      }))

      // Restore individual files
      for (const fileInfo of targetFiles) {
        if (fs.existsSync(fileInfo.source)) {
          fs.copyFileSync(fileInfo.source, fileInfo.target)
          console.log(`Restored: ${fileInfo.target}`)
        }
      }

      const targetFolders = foldersToBackup(app).map(folderInfo => ({
        source: path.join(tempDir, folderInfo.name),
        target: folderInfo.path,
      }))

      // Restore folders if they exist
      for (const folderInfo of targetFolders) {
        const { source, target } = folderInfo
        if (fs.existsSync(source)) {
          fs.mkdirSync(target, { recursive: true })
          copyDirectoryRecursive(source, target)
          console.log(`Restored folder: ${target}`)
        }
      }

      // Show success message
      await dialog.showMessageBox({
        type: 'info',
        title: t('backup.restore.restart.title'),
        message: t('backup.restore.restart.message'),
        detail: t('backup.restore.restart.detail'),
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
  'apiKeys.json': (json) => typeof json === 'object' && json !== null && !Array.isArray(json),
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
      // (a byte order mark is accepted)
      valid = isValid(JSON.parse(fs.readFileSync(source, 'utf-8').replace(/^\uFEFF/, '')))
    } catch { /* not JSON */ }
    if (!valid) {
      throw new Error(t('backup.restore.error.damaged', { file: name }))
    }
  }

}

// Helper function to copy directory recursively
const copyDirectoryRecursive = (src: string, dest: string) => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}