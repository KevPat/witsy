import { MediaSink } from './venice_video'

// Chunks are written in the main process. The renderer never chooses the path.
export function createIpcMediaSink(workspaceId: string): MediaSink {
  let id: string | null = null

  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (!id) {
        const opened = await window.api.file.mediaOpen(workspaceId)
        if (!opened) throw new Error('Could not open a video file')
        id = opened
      }
      await window.api.file.mediaAppend(id, chunk)
    },
    async finish(): Promise<string> {
      if (!id) throw new Error('No video data was written')
      const current = id
      const url = await window.api.file.mediaFinish(current)
      id = null
      if (!url?.startsWith('file://')) throw new Error('Could not save the video')
      return url
    },
    async abort(): Promise<void> {
      if (!id) return
      const current = id
      id = null
      try {
        await window.api.file.mediaAbort(current)
      } catch {
        // The session may already have been closed.
      }
    },
  }
}
