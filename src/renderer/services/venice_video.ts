export const VENICE_API_BASE = 'https://api.venice.ai/api/v1'
export const VENICE_VIDEO_TIMEOUT_MS = 20 * 60 * 1000
export const VENICE_MAX_VIDEO_BYTES = 512 * 1024 * 1024

export const VENICE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const VENICE_DURATION = /^\d{1,3}s$/
export const VENICE_RESOLUTION = /^(?:\d{3,4}p|\d{1,2}K)$/i
export const VENICE_ASPECT = /^\d{1,2}:\d{1,2}$/

const QUEUE_ID = /^[A-Za-z0-9_-]{8,128}$/
const MIN_POLL_MS = 5000
const MAX_POLL_MS = 30000
const MAX_TRANSIENT = 8
const MAX_POLLS = 400
const PROMPT_HARD_CAP = 20000
const IMAGE_BASE64_CAP = 12000000

const VIDEO_FAILURE = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'])

export type VeniceVideoErrorCode = 'cancelled' | 'timeout' | 'failed' | 'rate_limit' | 'invalid' | 'network' | 'malformed' | 'unavailable'

export class VeniceVideoError extends Error {
  code: VeniceVideoErrorCode

  constructor(message: string, code: VeniceVideoErrorCode) {
    super(message)
    this.name = 'VeniceVideoError'
    this.code = code
  }
}

export interface MediaSink {
  write(chunk: Uint8Array): Promise<void>
  finish(): Promise<string>
  abort(): Promise<void>
}

export type VeniceQueueInput = {
  model: string
  prompt: string
  duration?: unknown
  resolution?: unknown
  aspectRatio?: unknown
  durations?: string[]
  resolutions?: string[]
  aspectRatios?: string[]
  promptCharacterLimit?: number
  imageRequired?: boolean
  imageDataUrl?: string
}

export type VeniceGenerateRequest = VeniceQueueInput & {
  apiKey: string
}

export type VeniceGenerateDeps = {
  fetch?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  timeoutMs?: number
  maxBytes?: number
  sink: MediaSink
  signal?: AbortSignal
}

type Clock = {
  fetch: typeof fetch
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now: () => number
  timeoutMs: number
  maxBytes: number
  sink: MediaSink
  signal?: AbortSignal
}

export function redactSecrets(text: string, secret?: string): string {
  let out = text
  if (secret && secret.length >= 4) {
    out = out.split(secret).join('[redacted]')
  }
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  out = out.replace(/https?:\/\/\S+/gi, '[url]')
  return stripControls(out).slice(0, 300)
}

export function isMp4(bytes: Uint8Array): boolean {
  const window = Math.min(bytes.byteLength, 64)
  if (window < 12) return false
  for (let i = 4; i + 4 <= window; i++) {
    if (bytes[i] === 0x66 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x79 && bytes[i + 3] === 0x70) {
      return true
    }
  }
  return false
}

export function buildVeniceQueueBody(input: VeniceQueueInput): Record<string, string> {
  const model = (input.model || '').trim()
  if (!VENICE_MODEL_ID.test(model)) {
    throw new VeniceVideoError('Venice model id is not valid', 'invalid')
  }

  const limit = input.promptCharacterLimit && input.promptCharacterLimit > 0
    ? Math.min(Math.floor(input.promptCharacterLimit), PROMPT_HARD_CAP)
    : PROMPT_HARD_CAP
  const prompt = withoutNulls(input.prompt || '').trim()
  if (!prompt) {
    throw new VeniceVideoError('A prompt is required', 'invalid')
  }
  if (prompt.length > limit) {
    throw new VeniceVideoError('The prompt is too long for this Venice model', 'invalid')
  }

  let duration = normalizeDuration(input.duration)
  if (!duration) {
    duration = input.durations?.find((item) => VENICE_DURATION.test(item)) || '5s'
  }
  assertAllowed(duration, input.durations, VENICE_DURATION, 'duration')

  const body: Record<string, string> = { model, prompt, duration }
  let resolution = optionalString(input.resolution)
  if (!resolution && input.resolutions?.length) {
    resolution = input.resolutions.find((item) => item.toLowerCase() === '720p') || input.resolutions[0]
  }
  if (resolution) {
    assertAllowed(resolution, input.resolutions, VENICE_RESOLUTION, 'resolution')
    body.resolution = resolution
  }
  // An empty allow-list means this model derives aspect from the source image.
  // Models that publish a list require one of those values.
  let aspect = optionalString(input.aspectRatio)
  if (!aspect && input.aspectRatios?.length) {
    aspect = input.aspectRatios.find((item) => item === '16:9') || input.aspectRatios[0]
  }
  if (aspect && input.aspectRatios?.length !== 0) {
    assertAllowed(aspect, input.aspectRatios, VENICE_ASPECT, 'aspect ratio')
    body.aspect_ratio = aspect
  }
  if (input.imageRequired) {
    if (!input.imageDataUrl) {
      throw new VeniceVideoError('This Venice model needs a reference image', 'invalid')
    }
    body.image_url = assertImageDataUrl(input.imageDataUrl)
  }
  return body
}

export async function generateVeniceVideo(request: VeniceGenerateRequest, deps: VeniceGenerateDeps): Promise<string> {
  const clock = resolveDeps(deps)
  const apiKey = request.apiKey || ''
  if (clock.signal?.aborted) throw cancelled()

  try {
    const body = buildVeniceQueueBody(request)
    const queued = await postQueue(body, apiKey, clock)
    const fileUrl = await pollUntilVideo(body.model, queued.queueId, queued.downloadUrl, apiKey, clock)
    return fileUrl
  } catch (error) {
    await settle(clock.sink.abort())
    throw asVeniceError(error, clock.signal, apiKey)
  }
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function resolveDeps(deps: VeniceGenerateDeps): Clock {
  return {
    fetch: deps.fetch || globalThis.fetch.bind(globalThis),
    sleep: deps.sleep || defaultSleep,
    now: deps.now || Date.now,
    timeoutMs: deps.timeoutMs ?? VENICE_VIDEO_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? VENICE_MAX_VIDEO_BYTES,
    sink: deps.sink,
    signal: deps.signal,
  }
}

async function postQueue(body: Record<string, string>, apiKey: string, clock: Clock): Promise<{ queueId: string, downloadUrl?: string }> {
  const deadline = clock.now() + clock.timeoutMs
  let transient = 0
  let lastStatus = 429
  while (transient <= MAX_TRANSIENT) {
    throwIfStopped(clock, deadline)
    const response = await veniceFetch('/video/queue', body, apiKey, clock)
    if (isTransient(response.status)) {
      lastStatus = response.status
      transient += 1
      if (transient > MAX_TRANSIENT) break
      await sleepWithin(retryDelay(response, transient, clock.now()), deadline, clock)
      await drain(response)
      continue
    }
    if (!response.ok || isRedirect(response)) {
      throw await failureFrom(response, apiKey)
    }
    const payload = await readJson(response, apiKey)
    return parseQueue(payload)
  }
  throw new VeniceVideoError(
    lastStatus === 429 ? 'Venice rate limit was exceeded' : 'Venice video service is unavailable',
    lastStatus === 429 ? 'rate_limit' : 'unavailable',
  )
}

async function pollUntilVideo(model: string, queueId: string, downloadUrl: string | undefined, apiKey: string, clock: Clock): Promise<string> {
  const deadline = clock.now() + clock.timeoutMs
  let transient = 0
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    throwIfStopped(clock, deadline)
    let response: Response
    try {
      response = await veniceFetch('/video/retrieve', { model, queue_id: queueId }, apiKey, clock)
    } catch (error) {
      if (isAbort(error, clock.signal)) throw cancelled()
      transient += 1
      if (transient > MAX_TRANSIENT) {
        throw new VeniceVideoError('Venice video status could not be reached', 'network')
      }
      await sleepWithin(backoff(transient), deadline, clock)
      continue
    }

    if (isTransient(response.status)) {
      transient += 1
      const delay = retryDelay(response, transient, clock.now())
      await drain(response)
      if (transient > MAX_TRANSIENT) {
        throw new VeniceVideoError(
          response.status === 429 ? 'Venice rate limit was exceeded' : 'Venice video service is unavailable',
          response.status === 429 ? 'rate_limit' : 'unavailable',
        )
      }
      await sleepWithin(delay, deadline, clock)
      continue
    }

    if (!response.ok || isRedirect(response)) {
      throw await failureFrom(response, apiKey)
    }

    transient = 0
    const kind = mediaKind(response.headers.get('content-type'))
    if (kind === 'video') {
      await writeMp4(response, clock, deadline)
      return commit(model, queueId, downloadUrl, apiKey, clock)
    }
    if (kind !== 'json') {
      await drain(response)
      throw new VeniceVideoError('Venice returned an unexpected response', 'malformed')
    }

    const payload = await readJson(response, apiKey)
    const status = parseStatus(payload)
    if (status.status === 'PROCESSING') {
      await sleepWithin(pollDelay(status), deadline, clock)
      continue
    }
    if (status.status === 'COMPLETED') {
      if (!downloadUrl) {
        throw new VeniceVideoError('Venice completed the video without a download link', 'malformed')
      }
      await downloadPrivate(downloadUrl, clock, deadline)
      return commit(model, queueId, downloadUrl, apiKey, clock)
    }
    if (VIDEO_FAILURE.has(status.status)) {
      throw new VeniceVideoError(redactSecrets(status.message || 'Venice video generation failed', apiKey), 'failed')
    }
    throw new VeniceVideoError('Venice returned an unknown video status', 'malformed')
  }
  throw new VeniceVideoError('Video generation timed out', 'timeout')
}

async function commit(model: string, queueId: string, downloadUrl: string | undefined, apiKey: string, clock: Clock): Promise<string> {
  const fileUrl = await clock.sink.finish()
  if (!fileUrl?.startsWith('file://')) {
    throw new VeniceVideoError('Could not save the video', 'failed')
  }
  await settle(cleanup(model, queueId, downloadUrl, apiKey, clock))
  return fileUrl
}

async function cleanup(model: string, queueId: string, downloadUrl: string | undefined, apiKey: string, clock: Clock): Promise<void> {
  if (downloadUrl) {
    try {
      const response = await clock.fetch(downloadUrl, {
        method: 'DELETE',
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: clock.signal,
      })
      await drain(response)
    } catch {
      // The file is already local. Revoking the link is best-effort.
    }
  }
  const response = await veniceFetch('/video/complete', { model, queue_id: queueId }, apiKey, clock)
  await drain(response)
}

async function downloadPrivate(url: string, clock: Clock, deadline: number): Promise<void> {
  let transient = 0
  while (true) {
    throwIfStopped(clock, deadline)
    let response: Response
    try {
      response = await clock.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: clock.signal,
        headers: { Accept: 'video/mp4' },
      })
    } catch (error) {
      if (isAbort(error, clock.signal)) throw cancelled()
      transient += 1
      if (transient > 4) throw new VeniceVideoError('Venice video download failed', 'network')
      await sleepWithin(backoff(transient), deadline, clock)
      continue
    }

    if (response.status === 429 || response.status === 503 || response.status === 500) {
      transient += 1
      const delay = retryDelay(response, transient, clock.now())
      await drain(response)
      if (transient > 4) {
        throw new VeniceVideoError(response.status === 429 ? 'Venice rate limit was exceeded' : 'Venice video download failed', response.status === 429 ? 'rate_limit' : 'unavailable')
      }
      await sleepWithin(delay, deadline, clock)
      continue
    }

    if (response.status === 404 || response.status === 410) {
      await drain(response)
      throw new VeniceVideoError('The Venice video download link expired', 'failed')
    }
    if (!response.ok) {
      await drain(response)
      throw new VeniceVideoError('Venice video download failed', 'failed')
    }
    const kind = mediaKind(response.headers.get('content-type'))
    if (kind === 'json') {
      await drain(response)
      throw new VeniceVideoError('Venice did not return a video file', 'malformed')
    }
    await writeMp4(response, clock, deadline)
    return
  }
}

async function writeMp4(response: Response, clock: Clock, deadline: number): Promise<void> {
  const declared = contentLength(response)
  if (declared !== null && declared > clock.maxBytes) {
    await drain(response)
    throw new VeniceVideoError('The video is larger than the download limit', 'invalid')
  }

  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > clock.maxBytes) {
      throw new VeniceVideoError('The video is larger than the download limit', 'invalid')
    }
    if (!isMp4(bytes)) throw new VeniceVideoError('Venice returned data that is not an MP4', 'malformed')
    await clock.sink.write(bytes)
    return
  }

  const pending: Uint8Array[] = []
  let pendingBytes = 0
  let accepted = false
  let total = 0
  try {
    while (true) {
      throwIfStopped(clock, deadline)
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > clock.maxBytes) {
        throw new VeniceVideoError('The video is larger than the download limit', 'invalid')
      }
      if (!accepted) {
        pending.push(value)
        pendingBytes += value.byteLength
        if (pendingBytes < 32) continue
        const header = concatBytes(pending)
        if (!isMp4(header)) throw new VeniceVideoError('Venice returned data that is not an MP4', 'malformed')
        accepted = true
        pending.length = 0
        await clock.sink.write(header)
      } else {
        await clock.sink.write(value)
      }
    }
    if (!accepted) {
      const header = concatBytes(pending)
      if (!isMp4(header)) throw new VeniceVideoError('Venice returned data that is not an MP4', 'malformed')
      await clock.sink.write(header)
    }
  } finally {
    await settle(reader.cancel())
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

async function veniceFetch(path: string, body: Record<string, string>, apiKey: string, clock: Clock): Promise<Response> {
  if (!path.startsWith('/video/') || path.includes('..') || path.includes('//')) {
    throw new VeniceVideoError('Venice video request was refused', 'invalid')
  }
  try {
    return await clock.fetch(`${VENICE_API_BASE}${path}`, {
      method: 'POST',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: clock.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, video/mp4',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (isAbort(error, clock.signal)) throw cancelled()
    throw error
  }
}

function parseQueue(payload: unknown): { queueId: string, downloadUrl?: string } {
  if (!payload || typeof payload !== 'object') {
    throw new VeniceVideoError('Venice returned an unreadable queue response', 'malformed')
  }
  const record = payload as Record<string, unknown>
  if (typeof record.queue_id !== 'string' || !QUEUE_ID.test(record.queue_id)) {
    throw new VeniceVideoError('Venice returned an invalid queue id', 'malformed')
  }
  let downloadUrl: string | undefined
  if (record.download_url != null && record.download_url !== '') {
    if (typeof record.download_url !== 'string') {
      throw new VeniceVideoError('Venice returned an unreadable queue response', 'malformed')
    }
    downloadUrl = record.download_url
  }
  return { queueId: record.queue_id, downloadUrl }
}

function parseStatus(payload: unknown): { status: string, average?: number, elapsed?: number, message?: string } {
  if (!payload || typeof payload !== 'object') {
    throw new VeniceVideoError('Venice returned an unreadable status', 'malformed')
  }
  const record = payload as Record<string, unknown>
  if (typeof record.status !== 'string' || !record.status.trim()) {
    throw new VeniceVideoError('Venice returned an unreadable status', 'malformed')
  }
  const average = finiteNumber(record.average_execution_time)
  const elapsed = finiteNumber(record.execution_duration)
  return {
    status: record.status.trim().toUpperCase(),
    average,
    elapsed,
    message: extractError(record),
  }
}

async function readJson(response: Response, apiKey: string): Promise<unknown> {
  const declared = contentLength(response)
  if (declared !== null && declared > 1048576) {
    await drain(response)
    throw new VeniceVideoError('Venice returned an unexpected response', 'malformed')
  }
  const text = await response.text()
  if (text.length > 1048576) {
    throw new VeniceVideoError('Venice returned an unexpected response', 'malformed')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new VeniceVideoError(redactSecrets('Venice returned an unreadable status', apiKey), 'malformed')
  }
}

async function failureFrom(response: Response, apiKey: string): Promise<VeniceVideoError> {
  if (isRedirect(response)) {
    await drain(response)
    return new VeniceVideoError('Venice video API returned a redirect, which was refused', 'failed')
  }
  const message = await readErrorMessage(response, apiKey)
  if (response.status === 429) return new VeniceVideoError(message, 'rate_limit')
  if (response.status === 503 || response.status === 500) return new VeniceVideoError(message, 'unavailable')
  return new VeniceVideoError(message, 'failed')
}

async function readErrorMessage(response: Response, apiKey: string): Promise<string> {
  let text = ''
  try {
    text = (await response.text()).slice(0, 4000)
  } catch {
    text = ''
  }
  let message = ''
  if (text) {
    try {
      message = extractError(JSON.parse(text))
    } catch {
      message = ''
    }
  }
  if (!message) {
    if (response.status === 401) message = 'Venice rejected the API key'
    else if (response.status === 402) message = 'Venice account balance is too low for this video'
    else if (response.status === 404) message = 'Venice could not find that video'
    else if (response.status === 413) message = 'The reference image is too large'
    else if (response.status === 422) message = 'Venice rejected the prompt'
    else message = `Venice video request failed (${response.status})`
  }
  return redactSecrets(message, apiKey)
}

function extractError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  if (record.error && typeof record.error === 'object') {
    const inner = record.error as Record<string, unknown>
    if (typeof inner.message === 'string') return inner.message
  }
  if (typeof record.message === 'string') return record.message
  return ''
}

function assertImageDataUrl(value: string): string {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(value)
  if (!match) throw new VeniceVideoError('The reference image must be a JPEG, PNG, WebP, or GIF', 'invalid')
  const encoded = match[2].replace(/\s/g, '')
  if (!encoded || encoded.length > IMAGE_BASE64_CAP) {
    throw new VeniceVideoError('The reference image is too large', 'invalid')
  }
  return `data:${match[1]};base64,${encoded}`
}

function assertAllowed(value: string, allow: string[] | undefined, pattern: RegExp, label: string): void {
  if (allow && allow.length && !allow.includes(value)) {
    throw new VeniceVideoError(`Venice ${label} is not supported by this model`, 'invalid')
  }
  if (!pattern.test(value)) {
    throw new VeniceVideoError(`Venice ${label} is not valid`, 'invalid')
  }
}

function normalizeDuration(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1000) return `${value}s`
  return optionalString(value)
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mediaKind(contentType: string | null): 'json' | 'video' | 'unknown' {
  const value = (contentType || '').split(';')[0].trim().toLowerCase()
  if (value === 'video/mp4' || value === 'application/octet-stream') return 'video'
  if (value === 'application/json' || value === 'text/json' || value.endsWith('+json')) return 'json'
  return 'unknown'
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 503
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)
}

function pollDelay(status: { average?: number, elapsed?: number }): number {
  if (status.average !== undefined && status.elapsed !== undefined) {
    const remaining = status.average - status.elapsed
    if (remaining > 0) return clamp(Math.round(remaining / 3), MIN_POLL_MS, MAX_POLL_MS)
  }
  return MIN_POLL_MS
}

function retryDelay(response: Response, attempt: number, now: number): number {
  const header = response.headers.get('retry-after')?.trim()
  if (header) {
    if (/^\d+(\.\d+)?$/.test(header)) return clamp(Math.round(Number(header) * 1000), 1000, 60000)
    const when = Date.parse(header)
    if (Number.isFinite(when)) return clamp(when - now, 1000, 60000)
  }
  return backoff(attempt)
}

function backoff(attempt: number): number {
  return clamp(2000 * (2 ** Math.min(attempt, 4)), 2000, 30000)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

async function sleepWithin(ms: number, deadline: number, clock: Clock): Promise<void> {
  const remaining = deadline - clock.now()
  if (remaining <= 0) throw new VeniceVideoError('Video generation timed out', 'timeout')
  await clock.sleep(Math.min(ms, remaining), clock.signal)
  if (clock.signal?.aborted) throw cancelled()
  if (clock.now() >= deadline) throw new VeniceVideoError('Video generation timed out', 'timeout')
}

function throwIfStopped(clock: Clock, deadline: number): void {
  if (clock.signal?.aborted) throw cancelled()
  if (clock.now() >= deadline) throw new VeniceVideoError('Video generation timed out', 'timeout')
}

function cancelled(): VeniceVideoError {
  return new VeniceVideoError('Video generation was cancelled', 'cancelled')
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

function asVeniceError(error: unknown, signal: AbortSignal | undefined, apiKey: string): VeniceVideoError {
  if (isAbort(error, signal)) return cancelled()
  if (error instanceof VeniceVideoError) {
    return new VeniceVideoError(redactSecrets(error.message, apiKey), error.code)
  }
  const message = error instanceof Error ? error.message : 'Video generation failed'
  return new VeniceVideoError(redactSecrets(message || 'Video generation failed', apiKey), 'network')
}

async function settle(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    // Cleanup is best-effort.
  }
}

async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The body may already be consumed.
  }
}

function withoutNulls(value: string): string {
  return value.split(String.fromCharCode(0)).join('')
}

export function stripControls(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    const drop = code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)
    if (!drop) out += char
  }
  return out
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
