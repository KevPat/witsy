import { App } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, expect, test, vi } from 'vitest'
import { abortMediaFile, abortMediaForSender, appendMediaChunk, finishMediaFile, MAX_CHUNK_BYTES, openMediaFile } from '@main/media_file'

vi.mock('electron', () => {
  return {
    app: {
      getPath: () => '/tmp',
    },
  }
})

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const directories: string[] = []

function testApp(): App {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-media-'))
  directories.push(dir)
  return { getPath: () => dir } as App
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writes an mp4 inside the workspace images directory', async () => {
  const app = testApp()
  const id = await openMediaFile(app, WORKSPACE, 7)
  const payload = Buffer.from('0123456789abcdef')
  await appendMediaChunk(id, 7, payload)
  const url = await finishMediaFile(id, 7)

  expect(url.startsWith('file://')).toBe(true)
  const filePath = url.slice('file://'.length)
  expect(filePath.includes(`${path.sep}workspaces${path.sep}${WORKSPACE}${path.sep}images${path.sep}`)).toBe(true)
  expect(path.basename(filePath)).toMatch(/^[0-9a-f-]{36}\.mp4$/i)
  expect(fs.readFileSync(filePath)).toEqual(payload)
  expect(fs.existsSync(`${filePath}.partial`)).toBe(false)
})

test('rejects a workspace id that could escape the media directory', async () => {
  const app = testApp()
  const root = app.getPath('userData')
  await expect(openMediaFile(app, '../outside', 1)).rejects.toThrow('Invalid workspace')
  await expect(openMediaFile(app, `${WORKSPACE}/../../tmp`, 1)).rejects.toThrow('Invalid workspace')
  expect(fs.existsSync(path.resolve(root, '..', 'outside'))).toBe(false)
})

test('a different sender cannot append to or finish a session', async () => {
  const app = testApp()
  const id = await openMediaFile(app, WORKSPACE, 1)
  await expect(appendMediaChunk(id, 2, Buffer.from('0123456789abcdef'))).rejects.toThrow('Media session not found')
  await expect(finishMediaFile(id, 2)).rejects.toThrow('Media session not found')
  await abortMediaFile(id, 1)
  await expect(finishMediaFile(id, 1)).rejects.toThrow('Media session not found')
})

test('an oversized chunk aborts the partial file', async () => {
  const app = testApp()
  const id = await openMediaFile(app, WORKSPACE, 1)
  const images = path.join(app.getPath('userData'), 'workspaces', WORKSPACE, 'images')
  await expect(appendMediaChunk(id, 1, Buffer.alloc(MAX_CHUNK_BYTES + 1))).rejects.toThrow('Video exceeds size limit')
  expect(fs.readdirSync(images).filter((name) => name.endsWith('.partial'))).toEqual([])
})

test('abort removes the partial and a non-buffer chunk is refused', async () => {
  const app = testApp()
  const id = await openMediaFile(app, WORKSPACE, 3)
  await expect(appendMediaChunk(id, 3, 'not-bytes')).rejects.toThrow('Invalid media chunk')
  await abortMediaFile(id, 3)
  const images = path.join(app.getPath('userData'), 'workspaces', WORKSPACE, 'images')
  expect(fs.readdirSync(images)).toEqual([])
})

test('a short file is deleted instead of being published', async () => {
  const app = testApp()
  const id = await openMediaFile(app, WORKSPACE, 4)
  await appendMediaChunk(id, 4, Buffer.from('short'))
  await expect(finishMediaFile(id, 4)).rejects.toThrow('Video file was empty')
  const images = path.join(app.getPath('userData'), 'workspaces', WORKSPACE, 'images')
  expect(fs.readdirSync(images)).toEqual([])
  await expect(finishMediaFile(id, 4)).rejects.toThrow('Media session not found')
})

test('closing one renderer keeps another renderer session', async () => {
  const app = testApp()
  const kept = await openMediaFile(app, WORKSPACE, 1)
  const dropped = await openMediaFile(app, WORKSPACE, 2)
  await appendMediaChunk(kept, 1, Buffer.from('0123456789abcdef'))
  await appendMediaChunk(dropped, 2, Buffer.from('0123456789abcdef'))
  await abortMediaForSender(2)
  const url = await finishMediaFile(kept, 1)
  expect(url.startsWith('file://')).toBe(true)
  await expect(finishMediaFile(dropped, 2)).rejects.toThrow('Media session not found')
  const images = path.join(app.getPath('userData'), 'workspaces', WORKSPACE, 'images')
  expect(fs.readdirSync(images)).toHaveLength(1)
})

test('an uppercase workspace id stays inside that workspace', async () => {
  const app = testApp()
  const id = await openMediaFile(app, WORKSPACE.toUpperCase(), 8)
  await appendMediaChunk(id, 8, Buffer.from('0123456789abcdef'))
  const url = await finishMediaFile(id, 8)
  expect(url).toContain(WORKSPACE.toUpperCase())
  expect(fs.existsSync(url.slice('file://'.length))).toBe(true)
})
