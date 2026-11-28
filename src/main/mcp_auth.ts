
import { kDefaultHttpPort } from '@/consts'
import { OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { OAuthClientInformation, OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { app, App } from 'electron'
import { randomBytes } from 'node:crypto'
import { loadSettings } from './config'
import { openExternalUrl } from './external_links'
import { HttpServer } from './http_server'
import { useI18n } from './i18n'

export type OnTokensUpdatedCallback = (tokens: OAuthTokens, scope: string) => void

// the callback pages are served from the same loopback origin as the local HTTP API
const kHtmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

// the error page has no script of its own: none may run in it
const kErrorPageCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src https://witsy.bonamy.fr"

const kMaxErrorLength = 256

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  private _codeVerifier?: string
  private _redirectUrl: string | URL
  private _clientMetadata: OAuthClientMetadata
  private _onRedirect: (url: URL) => void
  private _onTokensUpdated: OnTokensUpdatedCallback
  private _clientInformation?: OAuthClientInformationFull
  private _tokens?: OAuthTokens

  constructor(
    redirectUrl: string | URL, 
    clientMetadata: OAuthClientMetadata,
    onRedirect: (url: URL) => void,
    onTokensUpdated: OnTokensUpdatedCallback
  ) {
    this._redirectUrl = redirectUrl
    this._clientMetadata = clientMetadata
    this._onRedirect = onRedirect
    this._onTokensUpdated = onTokensUpdated
  }

  get redirectUrl(): string | URL {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this._clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this._clientInformation = clientInformation
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens
    this._onTokensUpdated(tokens, this.clientMetadata.scope || '')
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this._onRedirect(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved')
    }
    return this._codeVerifier
  }

}

// what one authorization flow needs: flows can run at the same time, so nothing of this
// may live on the manager
type OAuthFlow = {
  type: 'http' | 'sse'
  url: string
  client: Client
  // state of the authorization request the browser was last sent to
  state: string | null
}

export default class McpOAuthManager {
  private app: App
  private httpServer: HttpServer
  private pendingCallbacks: Map<string, {
    resolve: (code: string) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }> = new Map()
  
  constructor(app: App) {
    this.app = app
    this.httpServer = HttpServer.getInstance()
    this.httpServer.unregister('/mcp/callback')
    this.httpServer.register('/mcp/callback', (req, res, parsedUrl) => {
      this.handleCallback(req, res, parsedUrl)
    })
  }

  async getClientMetadata(scope?: string): Promise<OAuthClientMetadata> {

    // we need se ttings
    const settings = loadSettings(this.app)

    // Ensure server is running to get the port
    await this.httpServer.ensureServerRunning(settings?.general?.httpPort || kDefaultHttpPort)
    const callbackUrl = `${this.httpServer.getBaseUrl()}/mcp/callback`
    
    return {
      client_name: `${useI18n(app)('common.appName')} MCP Client`,
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      ...(scope ? { scope } : {})
    }
  }

  private handleCallback(req: any, res: any, parsedUrl: URL): void {
    const t = useI18n(app)
    const code = parsedUrl.searchParams.get('code')
    const error = parsedUrl.searchParams.get('error')
    const state = parsedUrl.searchParams.get('state')

    // a callback only means something to the flow that is waiting for it: without a state,
    // or with one that is unknown, already used or expired, nothing of the request is used
    const pendingCallback = state ? this.pendingCallbacks.get(state) : undefined
    if (!pendingCallback) {
      console.log('[oauth] Refused MCP OAuth callback: no flow is waiting for this state')
      res.writeHead(400)
      res.end('Bad request')
      return
    }

    // a state completes one callback
    clearTimeout(pendingCallback.timeout)
    this.pendingCallbacks.delete(state)

    if (code) {
      console.log('[oauth] Authorization code received for MCP flow')
      res.writeHead(200, kHtmlHeaders)
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${t('mcp.oauth.success.title')}</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 60px 20px; background: rgb(252, 250, 248); color: black; text-align: center; min-height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; padding-top: 12.5%; }
              .logo { width: 8rem; height: 8rem; margin-bottom: 2rem; transform: rotate(5deg); }
              h1 { font-size: 28pt; font-weight: 600; margin: 0 0 1rem 0; }
              p { font-size: 16pt; opacity: 0.8; margin: 0; line-height: 1.5; }
            </style>
          </head>
          <body>
            <img src="/logo.png" alt="Witsy" class="logo">
            <h1>${t('mcp.oauth.success.title')}</h1>
            <p>${t('mcp.oauth.success.message')}</p>
            <script>setTimeout(() => window.close(), 5000);</script>
          </body>
        </html>
      `)

      pendingCallback.resolve(code)

    } else if (error) {
      console.log(`[oauth] Authorization error for MCP flow: ${error}`)
      res.writeHead(400, { ...kHtmlHeaders, 'Content-Security-Policy': kErrorPageCsp })
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>OAuth Authorization Failed</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 60px 20px; background: #0f172a; color: #ffffff; text-align: center; min-height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; align-items: center; }
              .logo { width: 64px; height: 64px; margin-bottom: 32px; }
              h1 { font-size: 28px; font-weight: 600; margin: 0 0 16px 0; color: #ef4444; }
              p { font-size: 16px; opacity: 0.8; margin: 0; line-height: 1.5; }
            </style>
          </head>
          <body>
            <img src="https://witsy.bonamy.fr/img/logo.png" alt="Witsy" class="logo">
            <h1>Authorization Failed</h1>
            <p>Error: ${escapeHtml(error.slice(0, kMaxErrorLength))}</p>
          </body>
        </html>
      `)

      pendingCallback.reject(new Error(`OAuth authorization failed: ${error}`))

    } else {
      console.log(`[oauth] Invalid MCP OAuth callback: missing code/error`)
      res.writeHead(400)
      res.end('Bad request')

      pendingCallback.reject(new Error('No authorization code provided'))
    }
  }

  // the state is what ties a callback to its flow, and what a forged callback has to guess
  private createState(): string {
    return randomBytes(32).toString('hex')
  }

  /**
   * Wait for the OAuth callback that carries this state (it expires after 5 minutes)
   */
  async waitForCallback(flowId: string): Promise<string> {

    const settings = loadSettings(this.app)

    await this.httpServer.ensureServerRunning(settings?.general?.httpPort || kDefaultHttpPort)
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('[oauth] MCP OAuth callback timeout')
        this.pendingCallbacks.delete(flowId)
        reject(new Error('OAuth callback timeout'))
      }, 300000) // 5 minute timeout

      this.pendingCallbacks.set(flowId, { resolve, reject, timeout })
    })
  }

  /**
   * Detect if a server requires OAuth by attempting to connect
   */
  async detectOAuth(type: 'http' | 'sse', url: string, headers: Record<string, string>): Promise<{ requiresOAuth: boolean, metadata?: OAuthClientMetadata }> {
    try {

      // Create appropriate transport based on server type
      let testTransport: any

      if (type === 'sse') {
        // For SSE, we don't pass headers in the transport options during detection
        testTransport = new SSEClientTransport(new URL(url), {})
      } else {
        // For HTTP, pass headers in requestInit
        const transportOptions: any = {
          requestInit: {
            headers: headers,
          }
        }
        testTransport = new StreamableHTTPClientTransport(new URL(url), transportOptions)
      }

      const testClient = new Client({
        name: 'witsy-oauth-detection',
        version: '1.0.0'
      }, {
        capabilities: {}
      })

      try {
        await testClient.connect(testTransport)
        await testClient.close()
        // If connection succeeds, OAuth is not required
        return { requiresOAuth: false }
      } catch (error) {
        // Check if this is an OAuth-related error
        const isOAuthError = this.isOAuthRequiredError(error)

        if (isOAuthError) {
          // OAuth is required - provide standardized Witsy client metadata
          const scope = await this.getServerSupportedScopes(url)
          const clientMetadata = await this.getClientMetadata(scope)
          console.log(`OAuth required for ${url}:`, error.message)
          return { requiresOAuth: true, metadata: clientMetadata }
        } else {
          // Some other error - re-throw
          throw error
        }
      }
    } catch (error) {
      console.error(`Failed to detect OAuth requirement for ${url}:`, error)
      throw error
    }
  }

  /**
   * Check if an error indicates OAuth is required
   */
  isOAuthRequiredError(error: any): boolean {
    // Check for UnauthorizedError from MCP SDK
    if (error instanceof UnauthorizedError) {
      return true
    }

    // Check for HTTP 401 errors with OAuth-specific messages
    const errorMessage = error?.message || ''
    const lowerMessage = errorMessage.toLowerCase()

    // 401 error?
    const is401 = lowerMessage.includes('401') || error?.code === 401 || error?.status === 401 || error?.statusCode === 401

    // Treat dynamic client registration errors as OAuth requirement
    if (lowerMessage.includes('dynamic client registration') ||
        lowerMessage.includes('does not support dynamic client registration')) {
      return true
    }

    // Check for SSE 401 errors (from EventSource)
    if (is401 && lowerMessage.includes('sse error')) {
      return true
    }

    // Look for OAuth-specific error patterns
    if (is401 && (
      lowerMessage.includes('invalid_token') ||
      lowerMessage.includes('missing') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('authentication required')
    )) {
      return true
    }

    // Check for common OAuth error responses
    if (lowerMessage.includes('invalid_token') ||
        lowerMessage.includes('access_denied') ||
        lowerMessage.includes('missing required authorization header') ||
        lowerMessage.includes('insufficient_scope')) {
      return true
    }

    // Generic 401 status code check
    if (is401 || lowerMessage.includes('unauthorized')) {
      return true
    }

    return false
  }

  /**
   * Opens the authorization URL in the user's default browser
   */
  private openBrowser(url: string): void {

    // the authorization endpoint is chosen by the remote server: only a web page may be opened
    let protocol: string | null = null
    try {
      protocol = new URL(url).protocol
    } catch { /* refused below */ }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('OAuth authorization URL refused: only http and https URLs can be opened')
    }

    console.log(`[oauth] Opening browser for authorization`);
    void openExternalUrl(url);
  }

  /**
   * Start OAuth authorization flow - simplified to match reference implementation
   */
  async startOAuthFlow(
    type: 'http' | 'sse',
    url: string,
    clientMetadata: OAuthClientMetadata,
    clientCredentials?: { client_id: string; client_secret: string }
  ): Promise<string> {
    console.log(`[oauth] Attempting to connect to ${url}...`);

    const flow: OAuthFlow = { type, url, client: null, state: null }

    // the redirect URI is the port the callback server really listens on, which is not
    // always the configured one: it is what gets registered and what the browser comes back to
    const settings = loadSettings(this.app)
    await this.httpServer.ensureServerRunning(settings?.general?.httpPort || kDefaultHttpPort)
    const callbackUrl = `${this.httpServer.getBaseUrl()}/mcp/callback`
    clientMetadata = { ...clientMetadata, redirect_uris: [callbackUrl] }

    console.log(`[oauth] Creating OAuth provider...`);
    const oauthProvider = new McpOAuthClientProvider(
      callbackUrl,
      clientMetadata,
      (redirectUrl: URL) => {
        // each authorization request gets its own unguessable state: the callback that
        // brings it back completes this flow and no other
        flow.state = this.createState()
        const urlWithState = new URL(redirectUrl.toString())
        urlWithState.searchParams.set('state', flow.state)

        console.log(`[oauth] OAuth redirect handler called - opening browser`);
        this.openBrowser(urlWithState.toString());
      },
      () => {}
    );
    
    // Set client credentials if provided (for servers that don't support dynamic registration)
    if (clientCredentials) {
      console.log('[oauth] Using provided client credentials');
      const clientInformation = {
        client_id: clientCredentials.client_id,
        client_secret: clientCredentials.client_secret,
        redirect_uris: [callbackUrl],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: `${useI18n(app)('common.appName')} MCP Client`,
      }
      oauthProvider.saveClientInformation(clientInformation);
    }
    
    console.log('[oauth] OAuth provider created');

    console.log('[oauth] Creating MCP client...');
    flow.client = new Client({
      name: `${useI18n(app)('common.appName').toLowerCase()}-oauth-client`,
      version: '1.0.0',
    }, { capabilities: {} });
    console.log('[oauth] Client created');

    console.log('[oauth] Starting OAuth flow...');
    await this.attemptConnection(oauthProvider, flow);
    
    // Return the OAuth configuration with tokens
    const tokens = oauthProvider.tokens();
    return JSON.stringify({
      clientInformation: oauthProvider.clientInformation(),
      clientMetadata,
      tokens,
    });
  }

  /**
   * Attempt connection - matches reference implementation exactly
   */
  private async attemptConnection(oauthProvider: McpOAuthClientProvider, flow: OAuthFlow): Promise<void> {
    console.log('[oauth] Creating transport with OAuth provider...');
    const baseUrl = new URL(flow.url);

    // Create appropriate transport based on server type
    let transport: any
    if (flow.type === 'sse') {
      transport = new SSEClientTransport(baseUrl, {
        authProvider: oauthProvider
      })
    } else {
      transport = new StreamableHTTPClientTransport(baseUrl, {
        authProvider: oauthProvider
      })
    }
    console.log('[oauth] Transport created');

    try {
      console.log('[oauth] Attempting connection (this will trigger OAuth redirect)...');
      await flow.client.connect(transport);
      console.log('[oauth] Connected successfully');
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        console.log('[oauth] OAuth required - waiting for authorization...');
        // the state of the request the browser was just sent to: a later request gets a new one
        const state = flow.state ?? this.createState()
        flow.state = null
        const authCode = await this.waitForCallback(state);
        console.log('[oauth] Authorization code received');
        await transport.finishAuth(authCode);
        console.log('[oauth] Reconnecting with authenticated transport...');
        await this.attemptConnection(oauthProvider, flow);
      } else {
        console.error('[oauth] Connection failed with non-auth error:', error);
        throw error;
      }
    }
  }


  /**
   * Complete OAuth flow with authorization code - for test compatibility
   */
  async completeOAuthFlow(serverUuid: string, authorizationCode: string): Promise<boolean> {
    console.log(`Completing OAuth flow for server ${serverUuid} with code: ${authorizationCode.substring(0, 10)}...`)
    return false
  }


  /**
   * Create an OAuth provider for a server - simplified
   */
  async createOAuthProvider(
    clientMetadata: OAuthClientMetadata, 
    onRedirect: (url: URL) => void,
    onTokensUpdated: OnTokensUpdatedCallback
  ): Promise<McpOAuthClientProvider> {
    
    const redirectUrl = clientMetadata.redirect_uris?.[0] || `${this.httpServer.getBaseUrl()}/mcp/callback`
    return new McpOAuthClientProvider(redirectUrl, clientMetadata, onRedirect, onTokensUpdated)
  }

  shutdown(): void {
  }

  async getServerSupportedScopes(url: string): Promise<string | null> {

    try {

      // get metadata url (.well-known/oauth-protected-resource)
      let response = await fetch(url)
      const headers = response.headers
      const auth = headers.get('www-authenticate')
      if (!auth) return null
      
      // parse the header
      let resourceMetadata = null
      const parts = auth.split(',')
      for (const part of parts) {
        const [key, value] = part.trim().split('=')
        if (key === 'resource_metadata' && value) {
          resourceMetadata = value.replace(/"/g, '')
          break
        }
      }

      // if none
      if (!resourceMetadata) {
        return null
      }

      // now fetch it
      response = await fetch(resourceMetadata)
      if (!response.ok) {
        console.error(`Failed to fetch resource metadata from ${resourceMetadata}: ${response.status} ${response.statusText}`)
        return null
      }
      const json = await response.json()
      if (json.scopes_supported && Array.isArray(json.scopes_supported)) {
        return json.scopes_supported.join(' ')
      }

    } catch (error) {
      console.error('Failed to get server supported scopes:', url, error)
    }

    // too bad
    return null

  }

}