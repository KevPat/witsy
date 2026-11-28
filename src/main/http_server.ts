import { IncomingMessage, ServerResponse, createServer as defaultCreateServer } from 'node:http'
import * as portfinder from 'portfinder'
import * as path from 'node:path'
import * as fs from 'node:fs'

export type RequestHandler = (req: IncomingMessage, res: ServerResponse, parsedUrl: URL) => Promise<void> | void

/**
 * Checks a route opts out of. By default a request is refused when its Host is not a
 * loopback authority (DNS rebinding), when it carries an Origin header or when the browser
 * flags it as cross-site or same-site: no legitimate client of this server is a web page.
 */
export type RouteOptions = {
  // routes authenticated by other means and reached through a tunnel
  allowAnyHost?: boolean
  allowOrigin?: boolean
  // routes reached by a cross-site navigation, such as an OAuth redirect
  allowCrossSite?: boolean
}

type Route = { handler: RequestHandler, options: RouteOptions }

const kLoopbackAuthority = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

// the OAuth provider redirects the browser to this route
const kRouteOptions: Record<string, RouteOptions> = {
  '/mcp/callback': { allowCrossSite: true },
}

const getRejection = (req: IncomingMessage, options: RouteOptions): string | null => {

  // nothing is ever allowed cross-origin, so no preflight can succeed
  if (req.method === 'OPTIONS') {
    return 'Preflight requests are not allowed'
  }

  const host = req.headers.host
  if (!options.allowAnyHost && (typeof host !== 'string' || !kLoopbackAuthority.test(host.trim()))) {
    return 'Host not allowed'
  }

  if (!options.allowOrigin && req.headers.origin !== undefined) {
    return 'Requests from web pages are not allowed'
  }

  const site = req.headers['sec-fetch-site']
  if (!options.allowCrossSite && typeof site === 'string' && ['cross-site', 'same-site'].includes(site.trim().toLowerCase())) {
    return 'Cross-site requests are not allowed'
  }

  return null
}

/**
 * Unified HTTP server for all callback/webhook needs in the application
 */
export class HttpServer {
  private static instance: HttpServer | null = null
  private server: any = null
  private port: number | null = null
  private routes: Map<string, Route> = new Map()
  private createServer: typeof defaultCreateServer

  private constructor(createServer: typeof defaultCreateServer = defaultCreateServer) {
    this.createServer = createServer
  }

  /**
   * Get the singleton instance of the HTTP server
   */
  static getInstance(createServer?: typeof defaultCreateServer): HttpServer {
    if (!HttpServer.instance) {
      HttpServer.instance = new HttpServer(createServer)
    }
    return HttpServer.instance
  }

  /**
   * Get the port the server is running on
   */
  getPort(): number | null {
    return this.port
  }

  /**
   * Get the base URL of the server
   */
  getBaseUrl(): string {
    if (this.port) {
      return `http://localhost:${this.port}`
    }
    throw new Error('HTTP server is not running')
  }

  /**
   * Register a route handler
   * @param path The path to handle (e.g., '/oauth/callback')
   *             Use '*' suffix for prefix matching (e.g., '/agent/run/*')
   * @param handler The request handler function
   * @param options The request checks this route opts out of (none by default)
   * @throws Error if path already exists
   */
  register(path: string, handler: RequestHandler, options?: RouteOptions): void {
    if (this.routes.has(path)) {
      throw new Error(`Path conflict: Route '${path}' already registered`)
    }
    this.routes.set(path, { handler, options: { ...kRouteOptions[path], ...options } })
    console.log(`[http] Registered route: ${path}`)
  }

  /**
   * Unregister a route handler
   * @param path The path to unregister
   */
  unregister(path: string): void {
    if (this.routes.delete(path)) {
      console.log(`[http] Unregistered route: ${path}`)
    }
  }

  /**
   * Ensure the HTTP server is running
   */
  async ensureServerRunning(port: number): Promise<void> {

    if (this.server) {
      return
    }

    // Find an available port
    this.port = await portfinder.getPortPromise({ port })
    console.log(`[http] Starting server on port ${this.port}`)
    
    this.server = this.createServer((req, res) => {
      
      // Ignore favicon requests
      if (req.url === '/favicon.ico') {
        res.writeHead(404)
        res.end()
        return
      }

      // Process logo request
      if (req.url === '/logo.png') {
        const assetsFolder = process.env.DEBUG ? 'assets' : process.resourcesPath;
        const fileData = fs.readFileSync(path.join(assetsFolder, 'icon.png'));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.write(fileData);
        res.end();
        return;
      }

      console.log(`[http] ${req.method} ${req.url}`)

      try {
        const parsedUrl = new URL(req.url || '/', `http://localhost:${this.port}`)
        const path = parsedUrl.pathname

        // Find matching route
        let route: Route | undefined

        // First try exact match
        route = this.routes.get(path)

        // If no exact match, try wildcard matches
        if (!route) {
          for (const [routePath, candidate] of this.routes) {
            if (routePath.endsWith('*')) {
              const prefix = routePath.slice(0, -1) // Remove the *
              if (path.startsWith(prefix)) {
                route = candidate
                break
              }
            }
          }
        }

        // unknown paths are checked too so that a web page cannot probe the routes
        const rejection = getRejection(req, route?.options ?? {})
        if (rejection) {
          console.warn(`[http] Request refused: ${rejection}`)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: rejection }))
          return
        }

        const handler = route?.handler
        if (handler) {
          // Execute the handler
          const result = handler(req, res, parsedUrl)
          
          // If handler returns a promise, handle it
          if (result instanceof Promise) {
            result.catch((error) => {
              console.error(`[http] Handler error for path ${path}:`, error)
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end('Internal Server Error')
              }
            })
          }
        } else {
          console.log(`[http] No handler found for path: ${path}`)
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
        }
      } catch (error) {
        console.error('[http] Server error:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal Server Error')
        }
      }
    })

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[http] Server listening on http://localhost:${this.port}`)
    })

    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[http] Port ${this.port} is already in use - server may already be running`)
      } else {
        console.error('[http] Server error:', err)
      }
    })
  }

  /**
   * Shutdown the HTTP server
   * @private Internal method for testing/cleanup
   */
  private shutdown(): void {
    if (this.server) {
      console.log('[http] Shutting down server')
      this.server.close()
      this.server = null
      this.port = null
      this.routes.clear()
    }
  }

  /**
   * Get all registered routes (for debugging/testing)
   */
  getRegisteredRoutes(): string[] {
    return Array.from(this.routes.keys())
  }
}