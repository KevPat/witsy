
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'events'
import { net } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { emitIpcEvent } from '@main/windows'
import { cancelDownload, getDownloadStatus, openInFileExplorer, startDownload } from '@main/ollama'
import { bug } from './bug'

vi.mock('electron', () => ({
  net: { request: vi.fn() }
}))

vi.mock('child_process', () => {
  const spawn = vi.fn()
  return { spawn, default: { spawn } }
})

// ollama.ts imports the fs namespace: replace createWriteStream on both the namespace and the default export
vi.mock('fs', async (importOriginal) => {
  const mod: any = await importOriginal()
  const createWriteStream = vi.fn()
  return { ...mod, createWriteStream, default: { ...mod.default, createWriteStream } }
})

vi.mock('@main/windows/main', () => ({
  mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } }
}))

vi.mock('@main/windows', () => ({
  emitIpcEvent: vi.fn()
}))

class FakeRequest extends EventEmitter {
  end = vi.fn()
  abort = vi.fn()
}

class FakeResponse extends EventEmitter {
  statusCode: number
  headers: Record<string, string>
  constructor(statusCode: number, headers: Record<string, string> = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }
}

// in-memory stand-in for the file being written
class FakeWriteStream extends EventEmitter {
  chunks: Buffer[] = []
  closed = false
  write = vi.fn((chunk: Buffer) => { this.chunks.push(chunk); return true })
  close = vi.fn(() => { this.closed = true })
  end = vi.fn(() => { this.closed = true })
  destroy = vi.fn(() => { this.closed = true; this.emit('close') })
  text = () => Buffer.concat(this.chunks).toString()
}

let dir: string
let requests: FakeRequest[]
let files: FakeWriteStream[]

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
const setPlatform = (value: string, cpu: string = 'x64') => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
  Object.defineProperty(process, 'arch', { value: cpu, configurable: true })
}

const events = (name: string) => vi.mocked(emitIpcEvent).mock.calls.filter(call => call[1] === name).map(call => call[2])

beforeEach(() => {
  vi.clearAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-stress-'))
  requests = []
  files = []
  vi.mocked(fs.createWriteStream).mockImplementation(() => {
    const stream = new FakeWriteStream()
    files.push(stream)
    return stream as any
  })
  vi.mocked(net.request).mockImplementation(() => {
    const request = new FakeRequest()
    requests.push(request)
    return request as any
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cancelDownload()
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ollama download', () => {

  test('a complete download is written to disk and reported once', () => {
    startDownload(dir)
    const response = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('01234'))
    response.emit('data', Buffer.from('56789'))
    response.emit('end')
    expect(getDownloadStatus()).toBeNull()
    expect(events('ollama-download-complete')).toHaveLength(1)
    expect(files).toHaveLength(1)
    expect(files[0].text()).toBe('0123456789')
    expect(files[0].closed).toBe(true)
    expect(events('ollama-download-progress').map(e => e.progress)).toEqual([50, 100])
  })

  test('a second download cannot start while one is running', () => {
    startDownload(dir)
    expect(() => startDownload(dir)).toThrow('Download already in progress')
  })

  test('stress: 50 start and fail cycles leave no state behind', () => {
    for (let i = 0; i < 50; i++) {
      startDownload(dir)
      requests[i].emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
      expect(getDownloadStatus()).toBeNull()
    }
    expect(events('ollama-download-error')).toHaveLength(50)
  })

  test.each([301, 403, 404, 500])('an HTTP %i response is reported as an error, not as a finished download', (status) => {
    const downloadId = startDownload(dir)
    const response = new FakeResponse(status, { 'content-length': '9' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('Not Found'))
    response.emit('end')
    expect(events('ollama-download-complete')).toHaveLength(0)
    expect(events('ollama-download-progress')).toHaveLength(0)
    expect(events('ollama-download-error')).toEqual([{ downloadId, error: `HTTP ${status}` }])
  })

  test('an HTTP error leaves no file behind, stops the transfer and frees the downloader', () => {
    startDownload(dir)
    const response = new FakeResponse(404, { 'content-length': '9' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('Not Found'))
    response.emit('end')
    expect(files).toHaveLength(0)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(requests[0].abort).toHaveBeenCalled()
    expect(getDownloadStatus()).toBeNull()

    // the next attempt is a normal download
    startDownload(dir)
    const retry = new FakeResponse(200, { 'content-length': '2' })
    requests[1].emit('response', retry)
    retry.emit('data', Buffer.from('ok'))
    retry.emit('end')
    expect(files).toHaveLength(1)
    expect(files[0].text()).toBe('ok')
    expect(events('ollama-download-complete')).toHaveLength(1)
    expect(events('ollama-download-error')).toHaveLength(1)
  })

  test.each([200, 206, 299])('an HTTP %i response is downloaded', (status) => {
    startDownload(dir)
    const response = new FakeResponse(status, { 'content-length': '2' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('ok'))
    response.emit('end')
    expect(events('ollama-download-complete')).toHaveLength(1)
    expect(events('ollama-download-error')).toHaveLength(0)
  })

  test('cancelling aborts the network request', () => {
    startDownload(dir)
    requests[0].emit('response', new FakeResponse(200, { 'content-length': '1000' }))
    expect(cancelDownload()).toBe(true)
    expect(requests[0].abort).toHaveBeenCalledTimes(1)
    expect(getDownloadStatus()).toBeNull()
    expect(cancelDownload()).toBe(false)
  })

  test('a cancelled download does not report completion', () => {
    startDownload(dir)
    const response = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('01234'))
    cancelDownload()
    response.emit('data', Buffer.from('56789'))
    response.emit('end')
    expect(events('ollama-download-complete')).toHaveLength(0)
    expect(events('ollama-download-error')).toHaveLength(0)
    expect(events('ollama-download-progress').map(e => e.progress)).toEqual([50])
    expect(files[0].text()).toBe('01234')
  })

  test('a cancel that comes before the response aborts the request and never creates a file', () => {
    startDownload(dir)
    cancelDownload()
    expect(requests[0].abort).toHaveBeenCalledTimes(1)

    // a response that was already on its way is ignored
    const response = new FakeResponse(200, { 'content-length': '5' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('01234'))
    response.emit('end')
    expect(files).toHaveLength(0)
    expect(emitIpcEvent).not.toHaveBeenCalled()
  })

  test('errors raised by the aborted transfer are not reported after a cancel', () => {
    startDownload(dir)
    const response = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', response)
    cancelDownload()
    response.emit('error', new Error('net::ERR_ABORTED'))
    requests[0].emit('error', new Error('net::ERR_ABORTED'))
    expect(events('ollama-download-error')).toHaveLength(0)
  })

  test('the partial file of a cancelled download is removed only once its stream is closed', () => {
    // an open file cannot be deleted on Windows: the stream has to release it first
    startDownload(dir)
    const response = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('01234'))
    const partial = getDownloadStatus()!.filePath
    fs.writeFileSync(partial, '01234')
    files[0].destroy.mockImplementation(() => { files[0].closed = true })

    cancelDownload()
    expect(files[0].destroy).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(partial)).toBe(true)

    files[0].emit('close')
    expect(fs.existsSync(partial)).toBe(false)
    expect(console.error).not.toHaveBeenCalled()
  })

  test('cancelling a download whose file is really on disk closes it and removes it', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    vi.mocked(fs.createWriteStream).mockImplementation(actual.createWriteStream as any)
    startDownload(dir)
    const response = new FakeResponse(200, { 'content-length': '1000' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('partial'))
    const partial = getDownloadStatus()!.filePath
    await vi.waitFor(() => expect(fs.existsSync(partial)).toBe(true))

    cancelDownload()
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual([]))
    expect(events('ollama-download-complete')).toHaveLength(0)
    expect(console.error).not.toHaveBeenCalled()
  })

  test('a download started after a cancel completes normally', () => {
    startDownload(dir)
    const first = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', first)
    first.emit('data', Buffer.from('AAAAA'))
    cancelDownload()

    startDownload(dir)
    const second = new FakeResponse(200, { 'content-length': '10' })
    requests[1].emit('response', second)
    second.emit('data', Buffer.from('01234'))
    first.emit('end')
    second.emit('data', Buffer.from('56789'))
    second.emit('end')
    expect(requests[1].abort).not.toHaveBeenCalled()
    expect(files[1].text()).toBe('0123456789')
    expect(files[1].destroy).not.toHaveBeenCalled()
    expect(events('ollama-download-complete')).toHaveLength(1)
    expect(events('ollama-download-error')).toHaveLength(0)
    expect(getDownloadStatus()).toBeNull()
  })

  test('data arriving for a cancelled download is not written into the next download', () => {
    startDownload(dir)
    const first = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', first)
    first.emit('data', Buffer.from('AAAAA'))
    cancelDownload()

    startDownload(dir)
    const second = new FakeResponse(200, { 'content-length': '10' })
    requests[1].emit('response', second)
    second.emit('data', Buffer.from('01234'))
    first.emit('data', Buffer.from('AAAAA'))
    first.emit('end')
    expect(getDownloadStatus()).not.toBeNull()
    expect(getDownloadStatus()!.downloadedBytes).toBe(5)
    expect(files[1].text()).toBe('01234')
  })

  test('the late cleanup of a cancelled download does not delete the file of the next download', () => {
    startDownload(dir)
    requests[0].emit('response', new FakeResponse(200, { 'content-length': '10' }))
    files[0].destroy.mockImplementation(() => { files[0].closed = true })
    cancelDownload()

    // same folder, same file name
    startDownload(dir)
    requests[1].emit('response', new FakeResponse(200, { 'content-length': '10' }))
    const file = getDownloadStatus()!.filePath
    fs.writeFileSync(file, '01234')

    files[0].emit('close')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('a transfer error closes the stream, removes the partial file and is reported once', () => {
    const downloadId = startDownload(dir)
    const response = new FakeResponse(200, { 'content-length': '10' })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from('01234'))
    const partial = getDownloadStatus()!.filePath
    fs.writeFileSync(partial, '01234')

    // Electron reports a broken connection on the response and on the request
    response.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    requests[0].emit('error', new Error('net::ERR_CONNECTION_RESET'))
    response.emit('end')
    expect(files[0].destroy).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(partial)).toBe(false)
    expect(events('ollama-download-error')).toEqual([{ downloadId, error: 'net::ERR_CONNECTION_RESET' }])
    expect(events('ollama-download-complete')).toHaveLength(0)
    expect(getDownloadStatus()).toBeNull()
  })

  bug('a disk error while writing is reported instead of crashing the process', () => {
    // the write stream has no error listener; an unhandled stream error is an uncaught exception
    startDownload(dir)
    requests[0].emit('response', new FakeResponse(200, { 'content-length': '10' }))
    expect(() => files[0].emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))).not.toThrow()
    expect(events('ollama-download-error')).toHaveLength(1)
  })

})

describe('ollama platform selection', () => {

  test.each([
    ['darwin', 'arm64', 'Ollama.dmg'],
    ['darwin', 'x64', 'Ollama.dmg'],
    ['win32', 'x64', 'OllamaSetup.exe'],
    ['win32', 'arm64', 'OllamaSetup.exe'],
  ])('%s %s downloads %s', (os, cpu, filename) => {
    setPlatform(os, cpu)
    startDownload(dir)
    expect(vi.mocked(net.request).mock.calls[0][0]).toBe(`https://ollama.com/download/${filename}`)
    expect(getDownloadStatus()!.filePath).toBe(path.join(dir, filename))
  })

  test('linux arm64 does not download the x64 binary', () => {
    setPlatform('linux', 'arm64')
    startDownload(dir)
    expect(vi.mocked(net.request).mock.calls[0][0]).not.toContain('amd64')
  })

  test.each(['x64', 'arm64'])('linux %s downloads the install script, which is not tied to an architecture', (cpu) => {
    // the only other files Ollama publishes for Linux are .tar.zst archives: nothing a user can run
    setPlatform('linux', cpu)
    startDownload(dir)
    expect(vi.mocked(net.request).mock.calls[0][0]).toBe('https://ollama.com/install.sh')
    expect(getDownloadStatus()!.filePath).toBe(path.join(dir, 'ollama-install.sh'))
  })

  test.each([
    ['linux', 'arm'],
    ['linux', 'ia32'],
    ['freebsd', 'x64'],
  ])('%s %s has no installer: the download is refused instead of fetching something unusable', (os, cpu) => {
    setPlatform(os, cpu)
    expect(() => startDownload(dir)).toThrow(`Ollama does not provide an installer for ${os} ${cpu}`)
    expect(net.request).not.toHaveBeenCalled()
    expect(getDownloadStatus()).toBeNull()
  })

  test.each([
    ['darwin', 'open'],
    ['win32', 'explorer'],
    ['linux', 'xdg-open'],
  ])('%s reveals the file with %s', (os, program) => {
    setPlatform(os)
    vi.mocked(spawn).mockReturnValue(new EventEmitter() as any)
    openInFileExplorer(path.join(dir, 'Ollama.dmg'))
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe(program)
  })

  bug('a missing file manager command does not raise an unhandled error', () => {
    // spawn reports ENOENT through an error event; nobody listens (xdg-open is absent on minimal Linux installs)
    const child = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(child as any)
    openInFileExplorer(path.join(dir, 'ollama-linux-amd64'))
    expect(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))).not.toThrow()
  })

})
