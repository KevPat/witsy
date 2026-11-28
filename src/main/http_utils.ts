import { IncomingMessage, ServerResponse } from 'node:http'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { App } from 'electron'
import * as config from './config'

// the CLI reads the same file name (src/cli/config.ts)
export const kApiTokenFile = 'http-api-token'

const kMaxBodySize = 32 * 1024 * 1024

let apiToken: string | null = null

/**
 * An error that carries the HTTP status code to answer with
 */
export class HttpError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

/**
 * Send JSON response
 */
export function sendJson(res: ServerResponse, data: any, statusCode = 200): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Send error response
 */
export function sendError(res: ServerResponse, message: string, statusCode = 400): void {
  sendJson(res, { success: false, error: message }, statusCode)
}

/**
 * Send the response for an error caught by a handler:
 * the status of an HttpError, 500 for anything else
 */
export function sendHandlerError(res: ServerResponse, error: unknown): void {
  const statusCode = error instanceof HttpError ? error.statusCode : 500
  sendError(res, error instanceof Error ? error.message : 'Internal server error', statusCode)
}

/**
 * Generate the API token of this session and store it in the user data folder,
 * readable by the current user only. Local clients (the CLI) read it from there.
 */
export function createApiToken(app: App): void {
  apiToken = crypto.randomBytes(32).toString('hex')
  try {
    const tokenFile = path.join(app.getPath('userData'), kApiTokenFile)
    // a file left by a previous session may have wider permissions: mode only applies on creation
    fs.rmSync(tokenFile, { force: true })
    fs.writeFileSync(tokenFile, apiToken, { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    console.error('[http] Could not write the API token file:', error instanceof Error ? error.message : 'unknown error')
  }
}

/**
 * Check that the request carries `Authorization: Bearer <API token>`
 */
export function hasValidApiToken(req: IncomingMessage): boolean {
  if (!apiToken) return false
  const authorization = req.headers.authorization
  if (typeof authorization !== 'string') return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization)
  if (!match) return false
  // digests have the same length whatever was sent, as timingSafeEqual requires
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest()
  return crypto.timingSafeEqual(digest(match[1]), digest(apiToken))
}

const readBody = (req: IncomingMessage): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer | string) => {
      if (rejected) return
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > kMaxBodySize) {
        rejected = true
        chunks.length = 0
        reject(new HttpError(413, 'Request body too large'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * Parse request parameters from GET query or POST body
 * A POST body is only accepted as JSON: any other content type is answered with 415
 * so that a web page cannot send one without a CORS preflight
 */
export async function parseParams(req: IncomingMessage, parsedUrl: URL): Promise<Record<string, string>> {
  const params: Record<string, string> = {}

  // Parse query parameters (GET requests)
  parsedUrl.searchParams.forEach((value, key) => {
    params[key] = value
  })

  // Parse POST body if present
  if (req.method === 'POST') {
    try {
      const body = await readBody(req)

      if (body) {
        const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (mediaType !== 'application/json') {
          throw new HttpError(415, 'Unsupported content type: the request body must be application/json')
        }
        const jsonData = JSON.parse(body)
        Object.assign(params, jsonData)
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      console.error('[http] Error parsing POST body:', error instanceof Error ? error.name : 'unknown error')
    }
  }

  return params
}

/**
 * Check if HTTP endpoints are enabled in configuration
 * If disabled, sends 404 response and returns false
 * If enabled, returns true
 */
export function isHttpEndpointsEnabled(app: App, res: ServerResponse): boolean {
  const settings = config.loadSettings(app)
  if (!settings.general.enableHttpEndpoints) {
    res.writeHead(404)
    res.end()
    return false
  }
  return true
}
