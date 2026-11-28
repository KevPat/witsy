// Witsy API Client

import { loadApiToken } from './config'
import { state } from './state'
import { ChatCli } from './models'

export class WitsyAPI {
  private apiToken: string | null = null

  private baseUrl(): string {
    return `http://localhost:${state.port}`
  }

  // Sends a request with the API token of the app. The token changes each time the app
  // starts: when the request is refused, the token file is read again and the request retried once.
  private async request(path: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}): Promise<Response> {
    const send = (token: string | null) => fetch(`${this.baseUrl()}${path}`, token
      ? { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }
      : init)

    const token = this.apiToken ?? loadApiToken(state.userDataPath)
    this.apiToken = token
    const response = await send(token)
    if (response.status !== 401 && response.status !== 403) return response

    const latest = loadApiToken(state.userDataPath)
    if (!latest || latest === token) return response
    this.apiToken = latest
    return await send(latest)
  }

  async connectWithTimeout(port: number, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`http://localhost:${port}/api/cli/config`, {
        signal: controller.signal
      })
      clearTimeout(timeout)
      return response.ok
    } catch {
      clearTimeout(timeout)
      return false
    }
  }

  async getConfig(): Promise<{ engine: { id: string; name: string }; model: { id: string; name: string }; userDataPath: string; enableHttpEndpoints: boolean }> {
    const response = await fetch(`${this.baseUrl()}/api/cli/config`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return {
      engine: data.engine,
      model: data.model,
      userDataPath: data.userDataPath,
      enableHttpEndpoints: data.enableHttpEndpoints
    }
  }

  async getEngines(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request('/api/engines')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return data.engines
  }

  async getModels(engine: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request(`/api/models/${engine}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return data.models
  }

  async complete(thread: Array<{ role: string; content: string }>, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void> {
    const response = await this.request('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: 'true',
        engine: state.engine?.id,
        model: state.model?.id,
        noMarkdown: true,
        thread,
        workDir: state.workDir
      }),
      signal
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('No response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    // a read can end anywhere, also in the middle of a line or of a multi-byte character:
    // only complete lines are processed, the rest waits here for the next read
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()

      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = done ? '' : lines.pop()

      for (let line of lines) {
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') return

          try {
            onChunk(data)
          } catch {
            // Ignore parse errors
          }
        }
      }

      if (done) break
    }
  }

  async saveConversation(chat: ChatCli): Promise<string> {
    const response = await this.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat })
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = await response.json()
    return data.chatId
  }
}
