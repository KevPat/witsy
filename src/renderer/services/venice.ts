import { Model } from 'multi-llm-ts'
import { Configuration } from 'types/config'
import { ModelLoader } from './model_loader'
import {
  stripControls,
  VENICE_API_BASE,
  VENICE_ASPECT,
  VENICE_DURATION,
  VENICE_MODEL_ID,
  VENICE_RESOLUTION,
} from './venice_video'

export type VeniceVideoModelType = 'text-to-video' | 'image-to-video'

export type VeniceVideoModelMeta = {
  modelType: VeniceVideoModelType
  durations: string[]
  resolutions: string[]
  aspectRatios: string[]
  promptCharacterLimit?: number
}

export type VeniceVideoModel = {
  id: string
  name: string
  meta: VeniceVideoModelMeta
}

const MAX_CATALOG_CHARS = 5000000
const MAX_MODELS = 400

export const FALLBACK_VENICE_VIDEO_MODELS: VeniceVideoModel[] = [
  {
    id: 'wan-2.5-preview-text-to-video',
    name: 'Wan 2.5 Preview (text to video)',
    meta: {
      modelType: 'text-to-video',
      durations: ['5s', '10s'],
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      promptCharacterLimit: 2500,
    },
  },
  {
    id: 'wan-2.5-preview-image-to-video',
    name: 'Wan 2.5 Preview (image to video)',
    meta: {
      modelType: 'image-to-video',
      durations: ['5s', '10s'],
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: [],
      promptCharacterLimit: 2500,
    },
  },
]

export function parseVeniceVideoCatalog(payload: unknown): { video: VeniceVideoModel[], videoEdit: VeniceVideoModel[] } {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error('malformed')
  }
  const video: VeniceVideoModel[] = []
  const videoEdit: VeniceVideoModel[] = []
  for (const entry of (payload as { data: unknown[] }).data) {
    if (video.length + videoEdit.length >= MAX_MODELS) break
    const parsed = parseCatalogEntry(entry)
    if (!parsed) continue
    if (parsed.meta.modelType === 'image-to-video') videoEdit.push(parsed)
    else video.push(parsed)
  }
  const byName = (a: VeniceVideoModel, b: VeniceVideoModel) => a.name.localeCompare(b.name)
  video.sort(byName)
  videoEdit.sort(byName)
  return { video, videoEdit }
}

export async function fetchVeniceVideoCatalog(apiKey: string | undefined, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<{ video: VeniceVideoModel[], videoEdit: VeniceVideoModel[] }> {
  let response = await requestCatalog(fetchImpl, apiKey)
  if ((response.status === 401 || response.status === 403) && apiKey?.trim()) {
    await cancelQuietly(response)
    response = await requestCatalog(fetchImpl)
  }
  if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)) {
    await cancelQuietly(response)
    throw new Error('redirect')
  }
  if (!response.ok) {
    await cancelQuietly(response)
    throw new Error(`status ${response.status}`)
  }
  const text = await response.text()
  if (text.length > MAX_CATALOG_CHARS) throw new Error('too large')
  return parseVeniceVideoCatalog(JSON.parse(text))
}

export default class Venice implements ModelLoader {

  config: Configuration

  constructor(config: Configuration) {
    this.config = config
  }

  async loadModels(): Promise<boolean> {
    const engine = this.config.engines.venice
    if (!engine) return false
    if (!engine.models) {
      engine.models = { chat: [] }
    }

    try {
      const catalog = await fetchVeniceVideoCatalog(engine.apiKey)
      if (!catalog.video.length && !catalog.videoEdit.length) {
        throw new Error('empty')
      }
      engine.models.video = catalog.video as unknown as Model[]
      engine.models.videoEdit = catalog.videoEdit as unknown as Model[]
      return true
    } catch {
      // The list endpoint is optional. A fixed pair keeps Design Studio usable offline.
      console.error('[venice] model list failed')
      applyFallback(this.config)
      return true
    }
  }

}

function applyFallback(config: Configuration): void {
  const engine = config.engines.venice
  if (!engine.models) engine.models = { chat: [] }
  engine.models.video = FALLBACK_VENICE_VIDEO_MODELS.filter((model) => model.meta.modelType === 'text-to-video') as unknown as Model[]
  engine.models.videoEdit = FALLBACK_VENICE_VIDEO_MODELS.filter((model) => model.meta.modelType === 'image-to-video') as unknown as Model[]
}

async function cancelQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The body may already be consumed.
  }
}

async function requestCatalog(fetchImpl: typeof fetch, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return fetchImpl(`${VENICE_API_BASE}/models?type=video`, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers,
  })
}

function parseCatalogEntry(entry: unknown): VeniceVideoModel | null {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  if (record.type !== 'video') return null
  if (typeof record.id !== 'string' || !VENICE_MODEL_ID.test(record.id)) return null
  const spec = record.model_spec && typeof record.model_spec === 'object'
    ? record.model_spec as Record<string, unknown>
    : {}
  if (spec.offline === true) return null
  const constraints = spec.constraints && typeof spec.constraints === 'object'
    ? spec.constraints as Record<string, unknown>
    : {}
  const declared = typeof constraints.model_type === 'string' ? constraints.model_type : ''
  const modelType = classifyModel(record.id, declared)
  if (!modelType) return null
  const rawName = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : record.id
  const name = stripControls(rawName).slice(0, 200) || record.id
  const limitRaw = constraints.prompt_character_limit ?? constraints.promptCharacterLimit
  const promptCharacterLimit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), 20000)
    : undefined
  return {
    id: record.id,
    name,
    meta: {
      modelType,
      durations: stringList(constraints.durations, VENICE_DURATION),
      resolutions: stringList(constraints.resolutions, VENICE_RESOLUTION),
      aspectRatios: stringList(constraints.aspect_ratios ?? constraints.aspectRatios, VENICE_ASPECT),
      ...(promptCharacterLimit ? { promptCharacterLimit } : {}),
    },
  }
}

function classifyModel(id: string, declared: string): VeniceVideoModelType | null {
  const blob = `${declared} ${id}`.toLowerCase()
  if (/(video-to-video|upscale|reference-to-video|extend|motion-control|interpolate)/.test(blob)) return null
  if (declared === 'image-to-video' || id.includes('image-to-video')) return 'image-to-video'
  if (declared === 'text-to-video' || id.includes('text-to-video')) return 'text-to-video'
  return null
}

function stringList(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= 32) break
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!pattern.test(trimmed) || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}
