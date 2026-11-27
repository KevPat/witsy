import { App } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceFolderPath } from './workspace';

export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTIAL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4\.partial$/i;
const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;

type Session = {
  id: string
  senderId: number
  partialPath: string
  finalPath: string
  handle: fs.FileHandle
  bytes: number
}

const sessions = new Map<string, Session>();

export async function openMediaFile(app: App, workspaceId: string, senderId: number): Promise<string> {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error('Invalid workspace');
  if (!Number.isInteger(senderId) || senderId < 0) throw new Error('Invalid media session');

  const imagesDir = imagesDirectory(app, workspaceId);
  await fs.mkdir(imagesDir, { recursive: true });
  await sweepPartials(imagesDir);

  const id = crypto.randomUUID();
  const finalPath = contained(imagesDir, `${id}.mp4`);
  const partialPath = contained(imagesDir, `${id}.mp4.partial`);
  const handle = await fs.open(partialPath, 'w', 0o600);
  sessions.set(id, { id, senderId, partialPath, finalPath, handle, bytes: 0 });
  return id;
}

export async function appendMediaChunk(id: string, senderId: number, chunk: unknown): Promise<void> {
  const session = requireSession(id, senderId);
  const bytes = asBuffer(chunk);
  if (bytes.length > MAX_CHUNK_BYTES || session.bytes + bytes.length > MAX_MEDIA_BYTES) {
    await abortSession(session);
    throw new Error('Video exceeds size limit');
  }
  await session.handle.write(bytes);
  session.bytes += bytes.length;
}

export async function finishMediaFile(id: string, senderId: number): Promise<string> {
  const session = requireSession(id, senderId);
  sessions.delete(session.id);
  await session.handle.close();
  if (session.bytes < 12) {
    await removePartial(session.partialPath);
    throw new Error('Video file was empty');
  }
  await fs.rename(session.partialPath, session.finalPath);
  return `file://${session.finalPath}`;
}

export async function abortMediaFile(id: string, senderId: number): Promise<void> {
  const session = sessions.get(id);
  if (!session || session.senderId !== senderId) return;
  await abortSession(session);
}

export async function abortMediaForSender(senderId: number): Promise<void> {
  const owned = [...sessions.values()].filter((session) => session.senderId === senderId);
  await Promise.all(owned.map((session) => abortSession(session)));
}

function requireSession(id: string, senderId: number): Session {
  const session = sessions.get(id);
  if (!session || session.senderId !== senderId) {
    throw new Error('Media session not found');
  }
  return session;
}

async function abortSession(session: Session): Promise<void> {
  sessions.delete(session.id);
  try {
    await session.handle.close();
  } catch {
    // The handle may already be closed.
  }
  await removePartial(session.partialPath);
}

async function removePartial(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // The partial may already be gone.
  }
}

function imagesDirectory(app: App, workspaceId: string): string {
  const root = path.resolve(workspaceFolderPath(app, workspaceId));
  const images = path.resolve(root, 'images');
  const relative = path.relative(root, images);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid media path');
  }
  return images;
}

function contained(directory: string, name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Invalid media path');
  }
  const full = path.resolve(directory, name);
  const relative = path.relative(directory, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid media path');
  }
  return full;
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('Invalid media chunk');
}

async function sweepPartials(directory: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - PARTIAL_MAX_AGE_MS;
  for (const name of names) {
    if (!PARTIAL_NAME.test(name)) continue;
    const full = contained(directory, name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) await fs.unlink(full);
    } catch {
      // Another session may have removed it.
    }
  }
}
