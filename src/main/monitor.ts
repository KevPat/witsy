import fs, { FSWatcher } from 'fs'
import crypto from 'crypto'

const REARM_RETRIES = 20
const REARM_DELAY = 100

export default class {

  filepath: string
  fileDigest: string
  callback: CallableFunction
  timeout: NodeJS.Timeout
  watcher: FSWatcher
  private watchedInode: number|null = null
  private rearmTimeout: NodeJS.Timeout|null = null

  constructor(callback: CallableFunction) {
    this.callback = callback
  }

  start(filepath: string): void {

    // same?
    if (this.filepath === filepath) {
      return
    }

    // does it exist
    if (!fs.existsSync(filepath)) {
      console.warn('Asked to monitor non-existing file', filepath)
      return
    }

    // clear
    this.stop()

    // init
    this.timeout = null
    this.filepath = filepath
    this.fileDigest = this.calculateDigest()

    // start
    this.watch(filepath)
  }

  stop(): void {
    clearTimeout(this.rearmTimeout)
    this.rearmTimeout = null
    this.closeWatcher()
    this.filepath = null
  }

  calculateDigest(): string {
    try {
      const fileContent = fs.readFileSync(this.filepath, 'utf8')
      return crypto.createHash('md5').update(fileContent).digest('hex')
    } catch {
      return ''
    }
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close()
    } catch { /* empty */ }
    this.watcher = null
    this.watchedInode = null
  }

  private inode(filepath: string): number|null {
    try {
      return fs.statSync(filepath).ino
    } catch {
      return null
    }
  }

  private watch(filepath: string): void {

    this.watchedInode = this.inode(filepath)

    this.watcher = fs.watch(filepath, (eventType) => {

      // not ours anymore
      if (this.filepath !== filepath) {
        return
      }

      // a file saved through a temporary file and a rename (editors, sync tools, our own
      // atomic writes) is a new file: on Linux and macOS the watcher stays attached to the
      // old one and never fires again, so watch the path again
      if (eventType === 'rename' || this.inode(filepath) !== this.watchedInode) {
        this.rearm(filepath)
      }

      this.check(filepath)

    })

    // a watcher that fails must not take the process down
    this.watcher.on?.('error', () => {
      if (this.filepath === filepath) {
        this.rearm(filepath)
      }
    })

  }

  private rearm(filepath: string, attempt: number = 0): void {

    clearTimeout(this.rearmTimeout)
    this.rearmTimeout = null
    this.closeWatcher()

    // the file can be missing for a moment between the removal and the rename
    if (fs.existsSync(filepath)) {
      try {
        this.watch(filepath)
        if (attempt > 0) {
          // what happened while nobody was watching
          this.check(filepath)
        }
        return
      } catch { /* try again */ }
    }

    if (attempt < REARM_RETRIES) {
      this.rearmTimeout = setTimeout(() => {
        if (this.filepath === filepath) {
          this.rearm(filepath, attempt + 1)
        }
      }, REARM_DELAY)
    } else {
      console.warn('File to monitor is gone', filepath)
    }

  }

  private check(filepath: string): void {
    const digest = this.calculateDigest()
    if (digest !== this.fileDigest) {
      this.fileDigest = digest
      clearTimeout(this.timeout)
      this.timeout = setTimeout(() => {
        this.notify(filepath)
      }, 200)
    }
  }


  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  notify(filepath: string): void {

    // log
    // console.log(`File ${filepath} modified. Notifying`)

    // callback
    this.callback()

  }

}
