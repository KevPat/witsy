import { App } from 'electron'
import { DocRepoListener } from 'types/rag'
import DocumentRepository from './docrepo'
import DocumentSourceImpl from './docsource'
import { loadSettings } from '../config'
import defaultSettings from '@root/defaults/settings.json'
import { watch, FSWatcher } from 'chokidar'
import { Minimatch } from 'minimatch'
import path from 'path'
import fs from 'fs'

interface PendingOperation {
  path: string
  operation: 'add' | 'change' | 'unlink'
  timer: NodeJS.Timeout
}

export default class DocumentMonitor implements DocRepoListener {

  app: App
  docRepo: DocumentRepository
  watchers: Map<string, FSWatcher> = new Map()
  pendingOperations: Map<string, PendingOperation> = new Map()
  debounceDelay: number = 1000 // 1 second debounce
  staleWatcherCandidates: Set<string> = new Set()
  staleWatcherTimer: NodeJS.Timeout | null = null

  constructor(app: App, docRepo: DocumentRepository) {
    this.app = app
    this.docRepo = docRepo
  }

  start(): void {
    console.log('[docmonitor] Starting document monitor')
    this.setupWatchers()
    
    // Register as listener with docRepo
    this.docRepo.addListener(this)
  }

  stop(): void {
    console.log('[docmonitor] Stopping document monitor')
    
    // Unregister from docRepo
    this.docRepo.removeListener(this)
    
    // Clear all pending operations
    for (const pending of this.pendingOperations.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingOperations.clear()
    if (this.staleWatcherTimer) {
      clearTimeout(this.staleWatcherTimer)
      this.staleWatcherTimer = null
    }
    this.staleWatcherCandidates.clear()

    // Close all watchers
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }

  private setupWatchers(): void {
    // Monitor all existing DocSources across all docbases
    for (const docBase of this.docRepo.contents) {
      for (const docSource of docBase.documents) {
        this.addDocSourceWatcher(docSource)
      }
    }
  }

  // DocRepoListener interface implementation
  onDocumentSourceAdded(docSource: DocumentSourceImpl): void {
    console.log(`[docmonitor] Document added notification: ${docSource.origin.substring(0, 50)}...`)

    // The files of a folder are covered by the watcher of that folder
    if (this.isFolderItem(docSource)) {
      return
    }

    this.addDocSourceWatcher(docSource)
  }

  onDocumentSourceRemoved(origin: string): void {
    console.log(`[docmonitor] Document removed notification: ${origin}`)

    // Another base may still rely on this watcher, and a base that is being deleted still lists
    // its sources when it notifies: keep the watcher for now and check again once that is settled
    if (this.watchers.has(origin) && this.isSourceOrigin(origin)) {
      this.staleWatcherCandidates.add(origin)
      if (!this.staleWatcherTimer) {
        this.staleWatcherTimer = setTimeout(() => this.closeStaleWatchers(), this.debounceDelay)
      }
      return
    }

    const watcher = this.watchers.get(origin)
    if (watcher) {
      console.log(`[docmonitor] Removing watcher for: ${origin}`)
      watcher.close()
      this.watchers.delete(origin)
    }
    
    // Clear any pending operations for this path
    this.clearPendingOperation(origin)
  }

  private closeStaleWatchers(): void {
    const origins = [...this.staleWatcherCandidates]
    this.staleWatcherTimer = null
    this.staleWatcherCandidates.clear()
    for (const origin of origins) {
      if (!this.isSourceOrigin(origin)) {
        this.onDocumentSourceRemoved(origin)
      }
    }
  }

  private isSourceOrigin(origin: string): boolean {
    return this.docRepo.contents.some(docBase => docBase.documents.some(docSource =>
      (docSource.type === 'file' || docSource.type === 'folder') && docSource.origin === origin
    ))
  }

  private isFolderItem(docSource: DocumentSourceImpl): boolean {
    return this.docRepo.contents.some(docBase => docBase.documents.some(folder =>
      folder.type === 'folder' && folder.items?.some(item => item.uuid === docSource.uuid)
    ))
  }

  private addDocSourceWatcher(docSource: DocumentSourceImpl): void {
    const watchPath = docSource.origin
    
    // Skip if already watching this path
    if (this.watchers.has(watchPath)) {
      return
    }

    // Only watch 'file' and 'folder' types
    if (docSource.type !== 'file' && docSource.type !== 'folder') {
      return
    }

    // Check if path exists
    if (!fs.existsSync(watchPath)) {
      console.warn(`[docmonitor] Path does not exist: ${watchPath}`)
      return
    }

    console.log(`[docmonitor] Adding watcher for ${docSource.type}: ${watchPath}`)

    try {
      const excludeMatchers = this.getExcludeMatchers()
      const watchOptions = {
        // ignore dotfiles and excluded names below the watched path, wherever that path is located
        ignored: (candidate: string) => this.isExcluded(watchPath, candidate, excludeMatchers),
        persistent: true,
        ignoreInitial: true, // don't trigger on initial scan
        followSymlinks: false,
        depth: docSource.type === 'folder' ? undefined : 0, // recursive for folders, just the file for files
      }

      const watcher = watch(watchPath, watchOptions)

      watcher
        .on('add', (filePath: string) => {
          console.log(`[docmonitor] File added: ${filePath}`)
          this.handleFileEvent(filePath, 'add')
        })
        .on('change', (filePath: string) => {
          console.log(`[docmonitor] File changed: ${filePath}`)
          this.handleFileEvent(filePath, 'change')
        })
        .on('unlink', (filePath: string) => {
          console.log(`[docmonitor] File removed: ${filePath}`)
          this.handleFileEvent(filePath, 'unlink')
        })
        .on('unlinkDir', (dirPath: string) => {
          console.log(`[docmonitor] Directory removed: ${dirPath}`)
          this.handleDirectoryEvent(dirPath, 'unlinkDir')
        })
        .on('error', (error: Error) => {
          console.error(`[docmonitor] Watcher error for ${watchPath}:`, error)
        })

      this.watchers.set(watchPath, watcher)

    } catch (error) {
      console.error(`[docmonitor] Failed to create watcher for ${watchPath}:`, error)
    }
  }

  private removeDocSourceWatcher(docSource: DocumentSourceImpl): void {
    const watchPath = docSource.origin
    const watcher = this.watchers.get(watchPath)
    
    if (watcher) {
      console.log(`[docmonitor] Removing watcher for: ${watchPath}`)
      watcher.close()
      this.watchers.delete(watchPath)
    }

    // Clear any pending operations for this path
    this.clearPendingOperation(watchPath)
  }

  private handleFileEvent(filePath: string, operation: 'add' | 'change' | 'unlink'): void {
    // Cancel any existing pending operation for this file
    this.clearPendingOperation(filePath)

    // Use longer delay for add operations to allow filesystem to settle after moves
    const delay = operation === 'add' ? this.debounceDelay * 1.5 : this.debounceDelay

    // Create new debounced operation
    const timer = setTimeout(() => {
      this.processFileEvent(filePath, operation)
      this.pendingOperations.delete(filePath)
    }, delay)

    this.pendingOperations.set(filePath, {
      path: filePath,
      operation,
      timer
    })
  }

  private handleDirectoryEvent(dirPath: string, operation: 'unlinkDir'): void {
    // Cancel any existing pending operation for this directory
    this.clearPendingOperation(dirPath)

    // Create debounced operation for directory events
    const timer = setTimeout(() => {
      this.processDirectoryEvent(dirPath, operation)
      this.pendingOperations.delete(dirPath)
    }, this.debounceDelay)

    this.pendingOperations.set(dirPath, {
      path: dirPath,
      operation: 'unlink', // Reuse 'unlink' operation type for consistency
      timer
    })
  }

  private clearPendingOperation(filePath: string): void {
    const pending = this.pendingOperations.get(filePath)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingOperations.delete(filePath)
    }
  }

  private async processFileEvent(filePath: string, operation: 'add' | 'change' | 'unlink'): Promise<void> {
    try {
      console.log(`[docmonitor] Processing ${operation} for: ${filePath}`)

      // Find all docbases that contain this file or its parent folder
      const affectedDocBases = this.findAffectedDocBases(filePath)

      if (affectedDocBases.length === 0) {
        console.log(`[docmonitor] No affected docbases found for: ${filePath}`)
        return
      }

      for (const { docBase, docSource } of affectedDocBases) {
        switch (operation) {
          case 'add':
            // For new files, add them to the docbase
            if (docSource.type === 'folder' && fs.existsSync(filePath) && !this.isExcluded(docSource.origin, filePath)) {
              console.log(`[docmonitor] Adding new file to docbase ${docBase.name}: ${filePath}`)
              await this.docRepo.addChildDocumentSource(docBase.uuid, docSource.uuid, 'file', filePath, false)
              await this.cleanupDuplicateDocuments(docBase, filePath)
            }
            break

          case 'change':
            // For changed files, update them in the docbase
            if (fs.existsSync(filePath)) {
              console.log(`[docmonitor] Updating file in docbase ${docBase.name}: ${filePath}`)
              
              // Find the specific document source for this file
              let targetDocSource = docSource
              if (docSource.type === 'folder') {
                targetDocSource = docSource.items.find(item => item.origin === filePath)
              }

              if (targetDocSource) {
                // Re-add the document (this will update it)
                if (docSource.type === 'folder') {
                  // If the parent is a folder, add as child document
                  await this.docRepo.addChildDocumentSource(docBase.uuid, docSource.uuid, targetDocSource.type, targetDocSource.origin, false)
                } else {
                  // If it's a root-level document, use addDocumentSource
                  await this.docRepo.addDocumentSource(docBase.uuid, targetDocSource.type, targetDocSource.origin, false)
                }
              } else if (this.canIndexUntrackedFile(docBase, docSource, filePath)) {
                // The folder does not have this file yet: the write replaced its pending creation,
                // or the creation could not be indexed (a file is empty when it has just been created)
                console.log(`[docmonitor] Adding written file to docbase ${docBase.name}: ${filePath}`)
                await this.docRepo.addChildDocumentSource(docBase.uuid, docSource.uuid, 'file', filePath, false)
                await this.cleanupDuplicateDocuments(docBase, filePath)
              }
            }
            break

          case 'unlink': {
            // For deleted files, remove them from the docbase
            console.log(`[docmonitor] Removing file from docbase ${docBase.name}: ${filePath}`)
            
            // Check if this is a root-level document that matches the file path
            if (docSource.type !== 'folder' && docSource.origin === filePath) {
              // The main document was deleted (root-level document)
              console.log(`[docmonitor] Removing root document: ${filePath}`)
              await this.docRepo.removeDocumentSource(docBase.uuid, docSource.uuid)
            }
            
            // Check if this is a child document in a folder
            if (docSource.type === 'folder') {
              // Look for the file in the folder's items
              const docToRemove = docSource.items.find(item => item.origin === filePath)
              if (docToRemove) {
                // Remove as child document from folder
                console.log(`[docmonitor] Removing child document from folder: ${filePath}`)
                await this.docRepo.removeChildDocumentSource(docBase.uuid, docToRemove.uuid)
              }
            }
            break
          }
        }
      }

    } catch (error) {
      console.error(`[docmonitor] Error processing ${operation} for ${filePath}:`, error)
    }
  }

  private async processDirectoryEvent(dirPath: string, operation: 'unlinkDir'): Promise<void> {
    try {
      console.log(`[docmonitor] Processing ${operation} for directory: ${dirPath}`)

      // Find all docbases that have this directory as a document source
      const affectedDocBases = this.findAffectedDocBasesForDirectory(dirPath)

      if (affectedDocBases.length === 0) {
        console.log(`[docmonitor] No affected docbases found for directory: ${dirPath}`)
        return
      }

      for (const { docBase, docSource } of affectedDocBases) {
        if (operation === 'unlinkDir') {
          // Check if this is a root-level folder document that matches or is within the directory path
          if (docSource.type === 'folder') {
            if (docSource.origin === dirPath) {
              // The main folder document was deleted
              console.log(`[docmonitor] Removing folder document source: ${dirPath}`)
              await this.docRepo.removeDocumentSource(docBase.uuid, docSource.uuid)
            } else {
              // This is a subdirectory that was affected by the parent directory deletion
              if (this.isInside(dirPath, docSource.origin)) {
                console.log(`[docmonitor] Removing subdirectory document source: ${docSource.origin}`)
                await this.docRepo.removeDocumentSource(docBase.uuid, docSource.uuid)
              }
            }
          }
        }
      }

    } catch (error) {
      console.error(`[docmonitor] Error processing ${operation} for directory ${dirPath}:`, error)
    }
  }

  private findAffectedDocBases(filePath: string): Array<{ docBase: any, docSource: DocumentSourceImpl }> {
    const affected: Array<{ docBase: any, docSource: DocumentSourceImpl }> = []

    for (const docBase of this.docRepo.contents) {
      for (const docSource of docBase.documents) {
        if (this.isFileAffectedByDocSource(filePath, docSource)) {
          affected.push({ docBase, docSource })
        }
      }
    }

    return affected
  }

  private findAffectedDocBasesForDirectory(dirPath: string): Array<{ docBase: any, docSource: DocumentSourceImpl }> {
    const affected: Array<{ docBase: any, docSource: DocumentSourceImpl }> = []

    for (const docBase of this.docRepo.contents) {
      for (const docSource of docBase.documents) {
        if (this.isDirectoryAffectedByDocSource(dirPath, docSource)) {
          affected.push({ docBase, docSource })
        }
      }
    }

    return affected
  }

  private isFileAffectedByDocSource(filePath: string, docSource: DocumentSourceImpl): boolean {
    // Direct file match (only for file type, not folder type)
    if (docSource.type !== 'folder' && docSource.origin === filePath) {
      return true
    }

    // For folders, check if the file is within the folder (but not the folder itself)
    if (docSource.type === 'folder') {
      return this.isInside(docSource.origin, filePath)
    }

    // Check sub-items for folder-type documents
    if (docSource.items && docSource.items.length > 0) {
      return docSource.items.some(item => item.origin === filePath)
    }

    return false
  }

  private isDirectoryAffectedByDocSource(dirPath: string, docSource: DocumentSourceImpl): boolean {
    // Direct folder match - check if this document source is for the deleted directory
    if (docSource.type === 'folder' && docSource.origin === dirPath) {
      return true
    }

    // Check if this document source is a subdirectory of the deleted directory
    if (docSource.type === 'folder') {
      return this.isInside(dirPath, docSource.origin)
    }

    return false
  }

  // true when target is located below dir (dir itself is not inside dir)
  private isInside(dir: string, target: string): boolean {
    const relativePath = path.relative(dir, target)
    // between two Windows drives or shares there is no relative path: path.relative returns the absolute target
    return relativePath !== ''
      && relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
  }

  private getExcludeMatchers(): Minimatch[] {
    let excludePatterns = defaultSettings.rag.excludePatterns
    try {
      excludePatterns = loadSettings(this.app).rag?.excludePatterns ?? excludePatterns
    } catch (error) {
      console.warn('[docmonitor] Could not read the exclude patterns, using the default ones', error)
    }
    return excludePatterns.split(',').map(p => p.trim()).filter(p => p.length > 0).map(p => new Minimatch(p))
  }

  // Same rule as the listing of a folder: the patterns are matched against each name below the root,
  // never against the root itself or its parents. Dotfiles are never monitored.
  private isExcluded(root: string, filePath: string, excludeMatchers = this.getExcludeMatchers()): boolean {
    if (!this.isInside(root, filePath)) {
      return false
    }
    return path.relative(root, filePath).split(path.sep).some(name =>
      name.startsWith('.') || excludeMatchers.some(matcher => matcher.match(name))
    )
  }

  private canIndexUntrackedFile(docBase: any, folder: DocumentSourceImpl, filePath: string): boolean {
    if (this.isExcluded(folder.origin, filePath) || !this.docRepo.isSourceSupported('file', filePath)) {
      return false
    }
    // When the file is already waiting to be indexed, that will read what was just written:
    // queueing it again would add it to the folder twice
    return !this.docRepo.queue.some(item => item.operation === 'add' && item.baseId === docBase.uuid
      && item.parentDocId === folder.uuid && item.origin === filePath)
  }

  private async cleanupDuplicateDocuments(docBase: any, filePath: string): Promise<void> {
    try {
      // Look for root-level documents that have the same file path as a child in a folder
      const rootDuplicates: DocumentSourceImpl[] = []
      
      // Find all root documents that match this file path
      for (const rootDoc of docBase.documents) {
        if (rootDoc.type !== 'folder' && rootDoc.origin === filePath) {
          rootDuplicates.push(rootDoc)
        }
      }

      // Find if this file exists as a child in any folder
      let existsInFolder = false
      for (const folderDoc of docBase.documents) {
        if (folderDoc.type === 'folder' && folderDoc.items) {
          const childExists = folderDoc.items.some((item: DocumentSourceImpl) => item.origin === filePath)
          if (childExists) {
            existsInFolder = true
            break
          }
        }
      }

      // If the file exists in a folder and also as root documents, remove the root duplicates
      if (existsInFolder && rootDuplicates.length > 0) {
        console.log(`[docmonitor] Cleaning up ${rootDuplicates.length} duplicate root documents for: ${filePath}`)
        
        for (const duplicate of rootDuplicates) {
          console.log(`[docmonitor] Removing duplicate root document: ${duplicate.origin}`)
          await this.docRepo.removeDocumentSource(docBase.uuid, duplicate.uuid)
        }
      }
    } catch (error) {
      console.error(`[docmonitor] Error cleaning up duplicates for ${filePath}:`, error)
    }
  }
}