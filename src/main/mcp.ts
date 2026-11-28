
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport, SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth'
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types'
import { ChildProcess, spawn } from 'child_process'
import { app, App } from 'electron'
import { PluginParameter, PluginTool } from 'multi-llm-ts'
import { anyDict } from 'types/index'
import { McpClaudeServer, McpClient, McpInstallStatus, McpServer, McpServerWithTools, McpStatus, McpTool } from 'types/mcp'
import { loadSettings, saveSettings, settingsFilePath } from './config'
import { useI18n } from './i18n'
import McpOAuthManager from './mcp_auth'
import Monitor from './monitor'
import { wait } from './utils'
import { emitIpcEventToAll } from './windows'

// need this
export const LEGACY_SUFFIX_PATTERN = /___....$/

// Collision handling constants
const COLLISION_SUFFIX_SEPARATOR = '_'
const MAX_TOOL_NAME_LENGTH = 64

// Values that end up on the installer command line. Registry identifiers look like npm
// package names ("exa", "@owner/server", "@owner/server@1.2.3"). Neither pattern accepts
// whitespace, quotes, a leading dash or any character a shell (or cmd.exe) interprets.
const INSTALL_SERVER_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/
const INSTALL_API_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const INSTALL_VALUE_MAX_LENGTH = 256
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const INSTALL_FAILURES: McpInstallStatus[] = ['api_key_missing', 'not_found', 'error']

const isInstallValue = (value: unknown, pattern: RegExp): value is string => {
  return typeof value === 'string' && value.length <= INSTALL_VALUE_MAX_LENGTH && pattern.test(value)
}

// Splits the arguments field of a stdio server into an argument vector.
// On Windows the field used to be handed to cmd.exe, so it follows the rules Windows programs
// apply to their own command line: double quotes group and are removed, \" and "" (inside
// quotes) are a literal quote, other backslashes are kept (paths).
// Elsewhere quoted groups are kept together, quotes included, as they always were.
const splitStdioArgs = (line: string): string[] => {

  if (typeof line !== 'string') {
    return []
  }

  if (process.platform !== 'win32') {
    return line.match(/"[^"]+"|'[^']+'|\S+/g) || []
  }

  const args: string[] = []
  let current = ''
  let started = false
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '\\') {
      let end = i
      while (line[end + 1] === '\\') end++
      const count = end - i + 1
      if (line[end + 1] === '"') {
        // 2n backslashes + quote: n backslashes, the quote delimits
        // 2n+1 backslashes + quote: n backslashes, the quote is literal
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          current += '"'
          end++
        }
      } else {
        current += '\\'.repeat(count)
      }
      started = true
      i = end
    } else if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        quoted = !quoted
      }
      started = true
    } else if (!quoted && /\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }

  if (started) {
    args.push(current)
  }

  return args

}

type McpSdkTool = {
  name: string
  description?: string | undefined
  inputSchema: {
    [x: string]: unknown
    type: 'object'
    properties?: Record<string, object> | undefined
    required?: string[] | undefined
  }
}

type McpSdkTools = {
  tools: McpSdkTool[]
}

type ToolsCacheEntry = {
  tools: McpSdkTools
  timestamp: number
}

export default class Mcp {

  private readonly CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
  private readonly FAILURE_RETRY_MS = 30 * 1000 // a failed tools/list is asked again after 30 seconds
  private activeReload: Promise<void> = Promise.resolve()
  private pendingReload: Promise<void>|null = null

  app: App
  monitor: Monitor|null
  currentConfig: string|null
  clients: McpClient[]
  logs: { [key: string]: string[] }
  oauthManager: McpOAuthManager
  toolsCache: Map<string, ToolsCacheEntry>

  constructor(app: App) {
    this.app = app
    this.clients = []
    this.monitor = null
    this.currentConfig = null
    this.logs = {}
    this.oauthManager = new McpOAuthManager(app)
    this.toolsCache = new Map()
  }

  private getCachedTools = async (client: McpClient): Promise<McpSdkTools> => {
    
    const uuid = client.server.uuid
    const cached = this.toolsCache.get(uuid)

    // a failure is not cached for ever: the server is asked again after a short while
    // (not at every call: a server that hangs would then delay every prompt)
    if (cached && cached.tools === null) {
      if (Date.now() - cached.timestamp < this.FAILURE_RETRY_MS) {
        return { tools: [] }
      }
    } else if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.tools
    }

    try {

      // Cache miss or expired, fetch new tools
      const tools = await client.client.listTools()
      this.toolsCache.set(uuid, {
        tools,
        timestamp: Date.now()
      })

      // a connected server that could not list its tools until now has no tool names yet:
      // without them its tools cannot be called
      if (cached && cached.tools === null) {
        const connected = this.clients.find(c => c.server.uuid === uuid && c.client === client.client)
        if (connected) {
          connected.tools = this.resolveToolNames(connected.server, tools.tools.map((tool: McpSdkTool) => tool.name))
          emitIpcEventToAll('mcp-servers-updated')
        }
      }

      return tools

    } catch (e) {

      console.error(`[mcp] Failed to get tools from MCP server ${client.server.url}:`, e)
      this.logs[uuid]?.push(`[mcp] Failed to get tools`)
      this.toolsCache.set(uuid, {
        tools: null,
        timestamp: Date.now()
      })
      return { tools: [] }
    }

  }

  private invalidateToolsCache = (uuid?: string): void => {
    if (uuid) {
      this.toolsCache.delete(uuid)
    } else {
      this.toolsCache.clear()
    }
  }

  getStatus = (): McpStatus => {

    const allServers = this.getServers()
    const statusServers = []

    for (const server of allServers) {
      // Skip disabled servers
      if (server.state === 'disabled') {
        continue
      }

      const persistentClient = this.clients.find(c => c.server.uuid === server.uuid)
      if (persistentClient) {
        statusServers.push({
          ...persistentClient.server,
          tools: persistentClient.tools
        })
        continue
      }

      // Check cache for non-persistent servers
      const cached = this.toolsCache.get(server.uuid)
      if (cached) {
        if (cached.tools !== undefined) {
          // We have tools (success) or null (error)
          const tools = Array.isArray(cached.tools?.tools) ? cached.tools.tools : []
          const toolNames = tools.map((tool: McpSdkTool) => this.getMappedToolName(server, tool.name))
          statusServers.push({
            ...server,
            tools: cached.tools === null ? null : toolNames
          })
        }
      } else {
        // No cache entry yet - server is starting
        statusServers.push({
          ...server,
          tools: undefined
        })
      }
    }

    return {
      servers: statusServers,
      logs: this.logs
    }
  }

  getAllServersWithTools = async (): Promise<McpServerWithTools[]> => {
    const results: McpServerWithTools[] = []
    
    for (const client of this.clients) {
      try {
        const tools: McpSdkTools = await this.getCachedTools(client)
        const mcpTools: McpTool[] = tools.tools.filter((tool: any) => {
          if (Array.isArray(client.server.toolSelection) && !client.server.toolSelection.includes(tool.name)) {
            return false
          } else {
            return true
          }
        }).map((tool: any) => ({
          name: tool.name,
          function: this.getMappedToolName(client.server, tool.name),
          description: tool.description || tool.name
        }))
        
        results.push({
          ...client.server,
          tools: mcpTools
        })
      } catch (e) {
        console.error(`[mcp] Failed to get tools from MCP server ${client.server.url}:`, e)
        results.push({
          ...client.server,
          tools: []
        })
      }
    }
    
    return results
  }

  getServers = (): McpServer[] => {

    // load
    const config = loadSettings(this.app)

    // backwards compatibility
    // @ts-expect-error backwards compatibility
    if (config.mcp.disabledMcpServers) {

      // @ts-expect-error backwards compatibility
      for (const server of config.mcp.disabledMcpServers) {
        // create extra entry
        if (!config.mcp.mcpServersExtra[server]) {
          config.mcp.mcpServersExtra[server] = {}
        }
        config.mcp.mcpServersExtra[server].state = 'disabled'
      }

      // delete
      // @ts-expect-error backwards compatibility
      delete config.mcp.disabledMcpServers
      saveSettings(this.app, config)

    }

    // now we can do it
    return [
      ...config.mcp.servers.map((server: McpServer) => ({
        ...server,
        toolSelection: server.toolSelection ?? null
      })),
      ...Object.keys(config.mcpServers ?? {}).reduce((arr: McpServer[], key: string) => {
        // "args" (like cwd and env) is optional in the mcpServers format
        const entry: Partial<McpClaudeServer> = config.mcpServers[key] ?? {}
        const extra = config.mcp.mcpServersExtra?.[key]
        arr.push({
          uuid: key.replace('@', ''),
          registryId: key,
          label: extra?.label || undefined,
          state: extra?.state || 'enabled',
          type: 'stdio',
          command: entry.command,
          url: Array.isArray(entry.args) ? entry.args.join(' ') : '',
          cwd: entry.cwd,
          env: entry.env,
          oauth: extra?.oauth || undefined,
          toolSelection: extra?.toolSelection || null,
          toolMappings: extra?.toolMappings || undefined
        })
        return arr
      }, [])
    ]
  }

  deleteServer = (uuid: string): boolean => {

    // we need a config
    let deleted = false
    const config = loadSettings(this.app)

    // first shutdown the client
    const client = this.clients.find((c: McpClient) => c.server.uuid === uuid)
    if (client) {
      this.disconnect(client)
    }

    // invalidate cache for this server
    this.invalidateToolsCache(uuid)

    // is it a normal server
    if (config.mcp.servers.find((s: McpServer) => s.uuid === uuid)) {
      config.mcp.servers = config.mcp.servers.filter((s: McpServer) => s.uuid !== uuid)
      deleted = true
    } else if (config.mcpServers[uuid]) {
      delete config.mcpServers[uuid]
      deleted = true
    } else if (config.mcpServers[`@${uuid}`]) {
      delete config.mcpServers[`@${uuid}`]
      deleted = true
    }

    // found
    if (deleted) {
      this.monitor?.stop()
      saveSettings(this.app, config)
      this.startConfigMonitor()
      return true
    }

    // not found
    return false

  }

  installServer = async (registry: string, server: string, apiKey: string): Promise<McpInstallStatus> => {

    const argv = this.getInstallArgv(registry, server, apiKey)
    if (!argv) return 'error'

    try {

      const before = this.getServers()

      this.monitor?.stop()
      this.logs[server] = this.logs[server] || []

      await this.runInstaller(server, argv)

      // now we should be able to connect
      const after = this.getServers()
      const servers = after.filter(s => !before.find(b => b.uuid === s.uuid))
      if (servers.length === 1) {
        await this.connectToServer(servers[0])
      }

      // done
      return 'success'

    } catch (e) {
      return INSTALL_FAILURES.includes(e) ? e : 'error'
    } finally {
      this.startConfigMonitor()
    }
    
  }

  // settles on every path: known installer message, process exit, spawn error or timeout
  private runInstaller = (server: string, argv: string[]): Promise<void> => {

    return new Promise<void>((resolve, reject) => {

      let settled = false
      let failTimeout: NodeJS.Timeout = null
      let installTimeout: NodeJS.Timeout = null
      let childProcess: ChildProcess = null

      const settle = (status: McpInstallStatus) => {
        if (settled) return
        settled = true
        clearTimeout(failTimeout)
        clearTimeout(installTimeout)
        if (status === 'success') {
          resolve()
        } else {
          childProcess?.kill()
          reject(status)
        }
      }

      try {

        // npx is a .cmd shim on Windows, which only cmd.exe can start: the arguments
        // were validated against a charset that means nothing to it, and no shell is used elsewhere
        const [file, ...args] = process.platform === 'win32'
          ? [process.env.comspec || 'cmd.exe', '/d', '/s', '/c', ...argv]
          : argv
        childProcess = spawn(file, args, { shell: false, windowsHide: true })

      } catch (error) {
        console.error(`[mcp] Error installing MCP server ${server}:`, error)
        this.logs[server].push(`Error installing MCP server ${server}: ${error.message}`)
        settle('error')
        return
      }

      installTimeout = setTimeout(() => {
        console.error(`[mcp] MCP install ${server} timed out`)
        this.logs[server].push(`MCP install ${server} timed out`)
        settle('error')
      }, INSTALL_TIMEOUT_MS)

      childProcess.on('error', (error) => {
        console.error(`[mcp] Error installing MCP server ${server}:`, error)
        this.logs[server].push(`Error installing MCP server ${server}: ${error.message}`)
        settle('error')
      })

      childProcess.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          console.error(`[mcp] MCP install ${server} exited with code ${code}`)
          this.logs[server].push(`MCP install ${server} exited with code ${code}`)
        }
        settle(code === 0 ? 'success' : 'error')
      })

      childProcess.stderr.on('data', (data: Buffer) => {
        const stderr = data.toString()
        console.error(`[mcp] MCP install ${server} stderr:`, stderr)
        this.logs[server].push(`MCP install ${server} stderr: ${stderr}`)

        // leave some time for a more specific message
        if (stderr.includes('Failed to install') && !settled) {
          clearTimeout(failTimeout)
          failTimeout = setTimeout(() => settle('error'), 250)
        }

        if (stderr.includes('Server not found')) {
          settle('not_found')
        }

      })

      childProcess.stdout.on('data', (data: Buffer) => {
        const stdout = data.toString()
        console.log(`[mcp] MCP install ${server} stdout:`, stdout)
        this.logs[server].push(`MCP install ${server} stdout: ${stdout}`)

        if (stdout.includes('successfully installed')) {
          settle('success')
        }

        if (stdout.includes('Please enter your Smithery API key')) {
          settle('api_key_missing')
        }

      })

    })

  }

  // the installer command as an argument vector, or null when the registry is unknown
  // or when a value that would end up on the command line is refused
  private getInstallArgv = (registry: string, server: string, apiKey: string): string[]|null => {

    if (registry !== 'smithery') {
      return null
    }

    if (!isInstallValue(server, INSTALL_SERVER_PATTERN)) {
      console.error('[mcp] Refused to install MCP server: the server name is not a valid registry identifier')
      return null
    }

    if (apiKey && !isInstallValue(apiKey, INSTALL_API_KEY_PATTERN)) {
      console.error(`[mcp] Refused to install MCP server ${server}: the API key contains unexpected characters`)
      return null
    }

    return [
      'npx', '-y', '@smithery/cli@latest', 'install', server, '--client', 'witsy',
      ...(apiKey ? ['--key', apiKey] : [])
    ]

  }

  // for display only: installServer never runs this string
  getInstallCommand = (registry: string, server: string, apiKey: string): string|null => {
    return this.getInstallArgv(registry, server, apiKey)?.join(' ') ?? null
  }

  editServer = async (server: McpServer): Promise<boolean> => {

    // we need a config
    let edited = false
    const config = loadSettings(this.app)

    // create?
    if (!server.uuid) {
      server.uuid = crypto.randomUUID()
      server.registryId = server.uuid
      config.mcp.servers.push(server)
      edited = true
    }

    // disconnect before editing
    const client = this.clients.find((c: McpClient) => c.server.uuid === server.uuid)
    if (client) {
      this.disconnect(client)
    }

    // invalidate cache for this server
    this.invalidateToolsCache(server.uuid)

    // search for server in normal server
    const original = config.mcp.servers.find((s: McpServer) => s.uuid === server.uuid)
    if (original) {
      original.type = server.type
      original.state = server.state
      if (server.label !== undefined) {
        if (server.label.trim().length) {
          original.label = server.label.trim()
        } else {
          delete original.label
        }
      }
      original.command = server.command
      original.url = server.url
      original.cwd = server.cwd
      original.env = server.env
      original.headers = server.headers
      original.oauth = server.oauth
      original.timeout = server.timeout
      original.toolSelection = server.toolSelection ?? null
      edited = true
    }

    // and in mcp servers
    const originalMcp = config.mcpServers[server.registryId]
    if (originalMcp) {

      // extra information
      if (!config.mcp.mcpServersExtra[server.registryId]) {
        config.mcp.mcpServersExtra[server.registryId] = {}
      }

      // extra
      config.mcp.mcpServersExtra[server.registryId].state = server.state
      config.mcp.mcpServersExtra[server.registryId].toolSelection = server.toolSelection ?? null
      
      // label
      if (server.label !== undefined) {
        if (server.label.trim().length) {
          config.mcp.mcpServersExtra[server.registryId].label = server.label.trim()
        } else {
          delete config.mcp.mcpServersExtra[server.registryId].label
        }
      }

      // rest is normal
      originalMcp.command = server.command
      originalMcp.args = server.url.split(' ')
      originalMcp.cwd = server.cwd
      originalMcp.env = server.env
      originalMcp.headers = server.headers
      config.mcp.mcpServersExtra[server.registryId].oauth = server.oauth
      edited = true
    }

    // if added
    if (edited) {
      this.monitor?.stop()
      saveSettings(this.app, config)
      await this.connectToServer(server)
      this.startConfigMonitor()
      return true
    }
    
    // too bad
    return false

  }

  updateTokens = async (server: McpServer, tokens: OAuthTokens, scope: string): Promise<boolean> => {

    // we need a config
    const config = loadSettings(this.app)

    // create?
    if (server.uuid === null) {
      return false
    }

    // save only if needed
    let edited = false

    // search for server in normal server
    const original = config.mcp.servers.find((s: McpServer) => s.uuid === server.uuid)
    if (original && original.oauth) {
      if (JSON.stringify(original.oauth.tokens) !== JSON.stringify(tokens)) {
        original.oauth.tokens = tokens
        original.oauth.scope = scope
        edited = true
      }
    }

    // and in mcp servers
    const originalMcp = config.mcpServers[server.registryId]
    if (originalMcp && config.mcp.mcpServersExtra[server.registryId]?.oauth) {
      if (JSON.stringify(config.mcp.mcpServersExtra[server.registryId].oauth.tokens) !== JSON.stringify(tokens)) {
        config.mcp.mcpServersExtra[server.registryId].oauth.tokens = tokens
        config.mcp.mcpServersExtra[server.registryId].oauth.scope = scope
        edited = true
      }
    }

    // save
    if (edited) {
      this.monitor?.stop()
      saveSettings(this.app, config)
      this.startConfigMonitor()
    }

    // done
    return true

  }  

  shutdown = async (): Promise<void> => {
    // one client that fails to close must not keep the others open
    const clients = this.clients
    this.clients = []
    for (const client of clients) {
      try {
        await client.client.close()
      } catch (e) {
        console.error(`[mcp] Failed to close MCP server ${client.server.url}:`, e)
      }
    }
    this.invalidateToolsCache()
    this.oauthManager.shutdown()
  }

  // reloads run one after the other (the settings monitor fires them without waiting):
  // two at the same time would each connect every server.
  // a reload that has not started yet reads the settings when it starts, so it serves all callers
  reload = (): Promise<void> => {
    if (this.pendingReload) {
      return this.pendingReload
    }
    const run = this.activeReload.then(async () => {
      this.pendingReload = null
      await this.shutdown()
      await this.connect()
    })
    this.pendingReload = run
    this.activeReload = run.catch(() => { /* reported to the caller */ })
    return run
  }

  restartServer = async (uuid: string): Promise<boolean> => {

    const servers = this.getServers()
    const server = servers.find(s => s.uuid === uuid)
    if (!server || server.state !== 'enabled') return false

    // Step 1: Disconnect and clear cache to show "starting" status
    const mcpClient = this.clients.find((c: McpClient) => c.server.uuid === server.uuid)
    if (mcpClient) {
      this.disconnect(mcpClient)
    }

    // Clear cache to set tools = undefined (starting status)
    this.toolsCache.delete(server.uuid)

    // Notify UI to show "starting" status
    emitIpcEventToAll('mcp-servers-updated')

    // Step 2: Small delay to ensure UI updates (use existing wait utility)
    await wait(100)

    // Step 3: Reconnect
    const success = await this.connectToServer(server)

    // Final notification is already handled by connectToServer

    return success
  }
  
  connect = async (): Promise<void> => {

    // now connect to servers
    const servers = this.getServers()
    for (const server of servers) {
      await this.connectToServer(server)
    }

    // save
    this.startConfigMonitor()

    // done
    console.log('[mcp] Servers connected', this.clients.map(client => client.server.uuid))

  }

  private startConfigMonitor = (): void => {
    if (!this.monitor) {
      this.monitor = new Monitor(() => {
        const servers = this.getServers()
        if (JSON.stringify(servers) !== this.currentConfig) {
          console.log('[mcp] Servers changed, reloading')
          this.reload()
        }
      })
    }
    // what we compare against is what we have just connected or saved ourselves:
    // if not, the next unrelated settings change reloads every server
    try {
      this.currentConfig = JSON.stringify(this.getServers())
    } catch (e) {
      console.error('[mcp] Failed to read the servers configuration', e)
    }
    this.monitor.start(settingsFilePath(this.app))
  }

  private connectToServer = async(server: McpServer): Promise<boolean> => {

    // first check if we already have a client for this server
    const existingClient = this.clients.find(client => client.server.uuid === server.uuid)
    if (existingClient) {
      try {
        await existingClient.client.close()
      } catch { /* empty */}
      this.clients = this.clients.filter(client => client !== existingClient)
    }

    // clear logs
    this.logs[server.uuid] = []

    // enabled
    if (server.state !== 'enabled') {
      return false
    }
    
    // now connect
    let client: Client = null
    if (server.type === 'stdio') {
      client = await this.connectToStdioServer(server)
    } else if (server.type === 'sse') {
      client = await this.connectToSseServer(server)
    } else if (server.type === 'http') {
      client = await this.connectToStreamableHttpServer(server)
    }

    if (!client) {
      console.error(`[mcp] Failed to connect to MCP server ${server.url}`)
      this.toolsCache.set(server.uuid, {
        tools: null,
        timestamp: 0,
      })
      emitIpcEventToAll('mcp-servers-updated')
      return false
    }

    // // reload on change
    // client.setNotificationHandler({ method: 'notifications/tools/list_changed' }, async () => {
    //   await this.reload()
    // })

    // get tools
    const tools = await this.getCachedTools({ client, server, tools: [] } as McpClient)
    const toolNames = tools.tools.map((tool: McpSdkTool) => tool.name)

    // detect and resolve collisions, build final tool names using mappings
    const finalToolNames = this.resolveToolNames(server, toolNames)

    // store
    this.clients.push({
      client,
      server,
      tools: finalToolNames
    })

    // done
    return true

  }

  private resolveToolNames = (server: McpServer, toolNames: string[]): string[] => {

    // detect and resolve collisions
    const mappings = this.detectAndResolveCollisions(
      server.uuid,
      toolNames,
      server.toolMappings
    )

    // persist mappings if any collisions were detected
    if (Object.keys(mappings).length > 0) {
      server.toolMappings = mappings
      this.persistServerMappings(server)
    } else if (server.toolMappings && Object.keys(server.toolMappings).length > 0) {
      // Clear old mappings if no collisions exist anymore
      server.toolMappings = undefined
      this.persistServerMappings(server)
    }

    // build final tool names using mappings
    return toolNames.map((name: string) => this.getMappedToolName(server, name))

  }

  private connectToStdioServer = async(server: McpServer): Promise<Client> => {

    try {

      // the transport starts the command without a shell, on every platform (on Windows
      // it resolves .cmd shims such as npx and escapes their arguments itself):
      // each argument reaches the server as it is, whatever characters it holds
      const command = server.command
      const args = splitStdioArgs(server.url)

      // now environment
      let env = {
        ...getDefaultEnvironment(),
        ...server.env,
      }

      // if env is empty, remove it
      if (Object.keys(env).length === 0) {
        env = undefined
      }

      // working directory
      const cwd = server.cwd || undefined

      // console.log('[mcp] MCP Stdio command', process.platform, command, args, env)

      const transport = new StdioClientTransport({
        command, args, env, stderr: 'pipe', cwd
      })

      // start transport to get errors
      await transport.start()
      transport.stderr?.on('data', async (data: Buffer) => {
        const error = data.toString()
        this.logs[server.uuid].push(error)
      })

      // build the client
      const client = new Client({
        name: `${useI18n(app)('common.appName').toLowerCase()}-oauth-client`,
        version: '1.0.0'
      })

      client.onerror = (e) => {
        this.logs[server.uuid].push(e.message)
      }

      // disable start and connect
      transport.start = async () => {}
      await client.connect(transport)

      // done
      return client

    } catch (e) {
      console.error(`[mcp] Failed to connect to MCP server ${server.command} ${server.url}:`, e)
      this.logs[server.uuid].push(`Failed to connect to MCP server "${server.command} ${server.url}"\n`)
      this.logs[server.uuid].push(`Error: ${e.message}\n`)
      if (e.message.startsWith('spawn')) {
        const words = e.message.split(' ')
        if (words.length >= 2) {
          const cmd = e.message.split(' ')[1]
          this.logs[server.uuid].push(`Command not found: ${cmd}. Please install it and/or add it to your PATH.\n`)
          this.logs[server.uuid].push('Check https://github.com/Kochava-Studios/witsy/wiki/MCP-Server-not-starting-on-macOS-and-Linux for more information.')
        } else {
          this.logs[server.uuid].push('Command not found. Please install it and/or add it to your PATH.\n')
          this.logs[server.uuid].push('Check https://github.com/Kochava-Studios/witsy/wiki/MCP-Server-not-starting-on-macOS-and-Linux for more information.')
        }
      }
    }

  }

  private connectToSseServer = async(server: McpServer): Promise<Client> => {

    try {

      // track unique errors to avoid duplicates
      const seenErrors = new Set<string>()

      // prepare transport options
      const transportOptions: SSEClientTransportOptions = {}

      // add OAuth provider if configured
      if (server.oauth && (server.oauth.tokens || server.oauth.clientId)) {

        const clientMetadata = await this.oauthManager.getClientMetadata(server.oauth.tokens?.scope ?? server.oauth.scope)
        const oauthProvider = await this.oauthManager.createOAuthProvider(clientMetadata, (redirectUrl) => {
          console.log(`[mcp] OAuth authorization required. Please visit: ${redirectUrl.toString()}`)
          this.logs[server.uuid].push(`[mcp] OAuth authorization required. Please visit: ${redirectUrl.toString()}`)
        }, (tokens: OAuthTokens, scope: string) => {
          this.updateTokens(server, tokens, scope)
        })

        // Set existing tokens if available
        if (server.oauth.tokens) {
          oauthProvider.saveTokens(server.oauth.tokens)
        }

        // Set existing client registration if available
        if (server.oauth.clientId && server.oauth.clientSecret) {
          // Reconstruct clientInformation from compact format
          const clientInformation = {
            client_id: server.oauth.clientId,
            client_secret: server.oauth.clientSecret,
            redirect_uris: clientMetadata.redirect_uris,
            token_endpoint_auth_method: 'client_secret_post',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: `${useI18n(app)('common.appName')} MCP Client`,
            ...(server.oauth.scope ? { scope: server.oauth.scope } : {})
          }
          oauthProvider.saveClientInformation(clientInformation)
        }
        transportOptions.authProvider = oauthProvider
      }

      // get transport
      const transport = new SSEClientTransport(
        new URL(server.url),
        transportOptions
      )
      transport.onerror = (e) => {
        if (!seenErrors.has(e.message)) {
          seenErrors.add(e.message)
          this.logs[server.uuid].push(this.translateError(e.message))
        }
      }
      // transport.onmessage = (message: any) => {
      //   console.log('[mcp] MCP SSE message', message)
      // }

      // build the client
      const client = new Client({
        name: `${useI18n(app)('common.appName').toLowerCase()}-oauth-client`,
        version: '1.0.0'
      })

      client.onerror = (e) => {
        if (!seenErrors.has(e.message)) {
          seenErrors.add(e.message)
          this.logs[server.uuid].push(this.translateError(e.message))
        }
      }

      // connect
      await client.connect(transport)

      // add some logs
      if (this.logs[server.uuid].length === 0) {
        this.logs[server.uuid].push(`Connected to MCP server at ${server.url}`)
      }

      // done
      return client


    } catch (e) {
      console.error(`[mcp] Failed to connect to MCP server ${server.url}:`, e)
      this.logs[server.uuid] = this.logs[server.uuid] || []
      // Only add catch error if logs are empty (no errors from handlers)
      if (this.logs[server.uuid].length === 0) {
        this.logs[server.uuid].push(this.translateError(e.message))
      }
    }

  }

  private connectToStreamableHttpServer = async(server: McpServer): Promise<Client> => {

    try {

      // track unique errors to avoid duplicates
      const seenErrors = new Set<string>()

      // prepare transport options
      const transportOptions: StreamableHTTPClientTransportOptions = {
        requestInit: {
          headers: server.headers || {},
        }
      }

      // add OAuth provider if configured
      if (server.oauth && (server.oauth.tokens || server.oauth.clientId)) {

        const clientMetadata = await this.oauthManager.getClientMetadata(server.oauth.tokens?.scope ?? server.oauth.scope)
        const oauthProvider = await this.oauthManager.createOAuthProvider(clientMetadata, (redirectUrl) => {
          console.log(`[mcp] OAuth authorization required. Please visit: ${redirectUrl.toString()}`)
          this.logs[server.uuid].push(`[mcp] OAuth authorization required. Please visit: ${redirectUrl.toString()}`)
        }, (tokens: OAuthTokens, scope: string) => {
          this.updateTokens(server, tokens, scope)
        })

        // Set existing tokens if available
        if (server.oauth.tokens) {
          oauthProvider.saveTokens(server.oauth.tokens)
        }

        // Set existing client registration if available
        if (server.oauth.clientId && server.oauth.clientSecret) {
          // Reconstruct clientInformation from compact format
          const clientInformation = {
            client_id: server.oauth.clientId,
            client_secret: server.oauth.clientSecret,
            redirect_uris: clientMetadata.redirect_uris,
            token_endpoint_auth_method: 'client_secret_post',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: `${useI18n(app)('common.appName')} MCP Client`,
            ...(server.oauth.scope ? { scope: server.oauth.scope } : {})
          }
          oauthProvider.saveClientInformation(clientInformation)
        }
        transportOptions.authProvider = oauthProvider
      }

      // get transport
      const transport = new StreamableHTTPClientTransport(new URL(server.url), transportOptions)
      transport.onerror = (e) => {
        if (!seenErrors.has(e.message)) {
          seenErrors.add(e.message)
          this.logs[server.uuid].push(this.translateError(e.message))
        }
      }
      // transport.onmessage = (message: any) => {
      //   console.log('[mcp] HTTP message', message)
      // }

      // build the client
      const client = new Client({
        name: `${useI18n(app)('common.appName').toLowerCase()}-oauth-client`,
        version: '1.0.0'
      })

      client.onerror = (e) => {
        if (!seenErrors.has(e.message)) {
          seenErrors.add(e.message)
          this.logs[server.uuid].push(this.translateError(e.message))
        }
      }

      // connect
      await client.connect(transport)

      // add some logs
      if (this.logs[server.uuid].length === 0) {
        this.logs[server.uuid].push(`Connected to MCP server at ${server.url}`)
      }

      // done
      return client


    } catch (e) {
      console.error(`[mcp] Failed to connect to MCP server ${server.url}:`, e)
      // Only add catch error if logs are empty (no errors from handlers)
      if (this.logs[server.uuid].length === 0) {
        this.logs[server.uuid].push(this.translateError(e.message))
      }
    }

  }  
  
  private disconnect = (client: McpClient): void => {
    client.client.close()
    this.clients = this.clients.filter(c => c !== client)
  }

  getServerTools = async (uuid: string): Promise<McpTool[]> => {

    const client = this.clients.find(client => client.server.uuid === uuid)
    if (!client) return []

    const tools = await this.getCachedTools(client)
    return tools.tools.map((tool: McpSdkTool) => ({
      name: tool.name,
      function: this.getMappedToolName(client.server, tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema
    }))

  }

  getLlmTools = async (): Promise<PluginTool[]> => {
    const allTools: PluginTool[] = []
    for (const client of this.clients) {
      try {
        const tools = await this.getCachedTools(client)
        for (const tool of tools.tools) {

          // skip disabled tools
          if (Array.isArray(client.server.toolSelection) && !client.server.toolSelection.includes(tool.name)) {
            continue
          }

          try {
            const toolDef = this.mcpToPluginTool(client.server, tool)
            allTools.push(toolDef)
          } catch (e) {
            console.error(`[mcp] Failed to convert MCP tool ${tool.name} from MCP server ${client.server.url}:`, e)
          }
        }
      } catch (e) {
        console.error(`[mcp] Failed to get tools from MCP server ${client.server.url}:`, e)
      }
    }
    return allTools
  }

  callTool = async (name: string, args: anyDict, abortSignal?: AbortSignal): Promise<any> => {

    const client = this.clients.find(client => client.tools.includes(name))
    if (!client) {
      throw new Error(`Tool ${name} not found`)
    }

    // resolve mapped name back to original for the MCP call
    const tool = this.originalToolName(name)
    console.log(`[mcp] Calling MCP tool`, tool, args)

    const timeout = client.server.timeout ? client.server.timeout * 1000 : undefined
    return await client.client.callTool({
      name: tool,
      arguments: args
    }, CompatibilityCallToolResultSchema, { signal: abortSignal, ...(timeout ? { timeout } : {}) })

  }

  public originalToolName = (name: string): string => {
    
    // handle legacy for some time
    // (a current tool can also end like a legacy suffix: "fetch___data" is a real name)
    if (LEGACY_SUFFIX_PATTERN.test(name) && !this.clients.some(client => client.tools.includes(name))) {
      name = name.replace(LEGACY_SUFFIX_PATTERN, '')
    }
    
    // Check all servers' toolMappings to find if this is a mapped name
    // If found, return the original name (the key in the mapping)
    // If not found, return as-is (it's already the original name)
    const servers = this.getServers()
    for (const server of servers) {
      if (server.toolMappings) {
        for (const [original, mapped] of Object.entries(server.toolMappings)) {
          if (mapped === name) {
            return original
          }
        }
      }
    }
    return name
  }

  // Get the mapped name for a tool (applies collision suffix if needed)
  protected getMappedToolName(server: McpServer, originalName: string): string {
    return server.toolMappings?.[originalName] || originalName
  }

  // Detect collisions and create mappings for a new server's tools
  // If existingMappings is provided (server reconnecting), those mappings are preserved
  protected detectAndResolveCollisions(
    newServerUuid: string,
    newTools: string[],
    existingMappings?: Record<string, string>
  ): Record<string, string> {
    const mappings: Record<string, string> = {}
    const existingToolNames = new Set<string>()

    // Gather all tool names from existing servers (with their mappings applied)
    const servers = this.getServers()
    for (const server of servers) {
      if (server.uuid === newServerUuid) continue

      const cached = this.toolsCache.get(server.uuid)
      if (cached?.tools?.tools) {
        for (const tool of cached.tools.tools) {
          const mappedName = this.getMappedToolName(server, tool.name)
          existingToolNames.add(mappedName)
        }
      }
    }

    // Check new server's tools for collisions
    for (const toolName of newTools) {
      // If server already has a mapping for this tool, preserve it
      if (existingMappings?.[toolName]) {
        mappings[toolName] = existingMappings[toolName]
        existingToolNames.add(existingMappings[toolName])
        continue
      }

      if (existingToolNames.has(toolName)) {
        // Find next available suffix: the name that is tested is the one that is stored,
        // truncated if needed to fit max tool name length
        const candidate = (suffix: number): string => {
          const suffixStr = `${COLLISION_SUFFIX_SEPARATOR}${suffix}`
          const name = `${toolName}${suffixStr}`
          if (name.length <= MAX_TOOL_NAME_LENGTH) return name
          return `${toolName.slice(0, MAX_TOOL_NAME_LENGTH - suffixStr.length)}${suffixStr}`
        }
        let suffix = 1
        while (existingToolNames.has(candidate(suffix))) {
          suffix++
        }
        const mappedName = candidate(suffix)
mappings[toolName] = mappedName
        existingToolNames.add(mappedName)
      }
    }

    return mappings
  }

  /**
   * Persist tool mappings for a server to config
   */
  protected persistServerMappings = (server: McpServer): void => {
    const config = loadSettings(this.app)

    // Find and update the server in config.mcp.servers
    const configServer = config.mcp.servers.find((s: McpServer) => s.uuid === server.uuid)
    if (configServer) {
      if (Object.keys(server.toolMappings || {}).length > 0) {
        configServer.toolMappings = server.toolMappings
      } else {
        delete configServer.toolMappings
      }
      this.monitor?.stop()
      saveSettings(this.app, config)
      this.startConfigMonitor()
      return
    }

    // Check mcpServersExtra for registry servers (legacy mcpServers format)
    if (server.registryId) {
      // Create entry if it doesn't exist
      if (!config.mcp.mcpServersExtra[server.registryId]) {
        config.mcp.mcpServersExtra[server.registryId] = {}
      }
      if (Object.keys(server.toolMappings || {}).length > 0) {
        config.mcp.mcpServersExtra[server.registryId].toolMappings = server.toolMappings
      } else {
        delete config.mcp.mcpServersExtra[server.registryId].toolMappings
      }
      this.monitor?.stop()
      saveSettings(this.app, config)
      this.startConfigMonitor()
    }
  }

  private translateError(errorMessage: string): string {
    const i18n = useI18n(this.app)

    // Check for fetch/connection errors
    if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
      return i18n('mcp.connectionErrors.fetchFailed')
    }

    // Check for OAuth/auth errors
    if (errorMessage.includes('POSTing to endpoint') && errorMessage.includes('HTTP 500')) {
      return i18n('mcp.connectionErrors.authFailed')
    }

    if (errorMessage.includes('server_error') || errorMessage.includes('Internal Server Error')) {
      return i18n('mcp.connectionErrors.authFailed')
    }

    // Return original message if no translation found
    return errorMessage
  }

  protected mcpSchemaToParameters = (properties: Record<string, any>, required: string[]): PluginParameter[] => {
    const parameters: PluginParameter[] = []
    for (const [key, prop] of Object.entries<any>(properties)) {
      const param: PluginParameter = {
        name: key,
        type: prop.type || 'string',
        description: prop.description || key,
        required: required.includes(key),
      }
      if (prop.enum) {
        param.enum = prop.enum
      }
      if (prop.type === 'array') {
        const items = prop.items || { type: 'string' }
        if (items.type === 'object' && items.properties) {
          param.items = { type: 'object', properties: this.mcpSchemaToParameters(items.properties, items.required ?? []) }
        } else if (items.type === 'array' && items.items) {
          param.items = { type: 'array', items: { type: items.items.type || 'string' } }
        } else {
          param.items = { type: items.type || 'string' }
        }
      }
      if (prop.type === 'object' && prop.properties) {
        param.items = { type: 'object', properties: this.mcpSchemaToParameters(prop.properties, prop.required ?? []) }
      }
      parameters.push(param)
    }
    return parameters
  }

  protected mcpToPluginTool = (server: McpServer, tool: McpSdkTool): PluginTool => {
    const required = tool.inputSchema?.required ?? []
    const parameters = tool.inputSchema?.properties
      ? this.mcpSchemaToParameters(tool.inputSchema.properties as Record<string, any>, required as string[])
      : []
    return {
      name: this.getMappedToolName(server, tool.name),
      description: tool.description ? tool.description : tool.name,
      parameters,
    }
  }

  // OAuth delegation methods
  detectOAuth = async (type: 'http' | 'sse', url: string, headers: Record<string, string>) => {
    return this.oauthManager.detectOAuth(type, url, headers)
  }

  startOAuthFlow = async (type: 'http' | 'sse', url: string, clientMetadata: any, clientCredentials?: { client_id: string; client_secret: string }): Promise<string> => {
    return this.oauthManager.startOAuthFlow(type, url, clientMetadata, clientCredentials)
  }

  completeOAuthFlow = async (serverUuid: string, authorizationCode: string): Promise<boolean> => {
    const server = this.getServers().find(s => s.uuid === serverUuid)
    if (!server || !server.oauth) {
      // Check if OAuth manager can handle it (for interactive flows)
      return this.oauthManager.completeOAuthFlow(serverUuid, authorizationCode)
    }

    try {
      // First try to complete through the OAuth manager (for interactive flows)
      const managerResult = await this.oauthManager.completeOAuthFlow(serverUuid, authorizationCode)
      if (managerResult) {
        return true
      }

      // If that didn't work, try the transport method (for existing connected clients)
      const client = this.clients.find(c => c.server.uuid === serverUuid)
      if (client && client.client.transport && 'finishAuth' in client.client.transport) {
        // Complete the OAuth flow
        await (client.client.transport as any).finishAuth(authorizationCode)
        return true
      }
    } catch (error) {
      console.error(`[mcp] Failed to complete OAuth flow for server ${serverUuid}:`, error)
      this.logs[serverUuid]?.push(`Failed to complete OAuth flow: ${error.message}`)
    }

    return false
  }

}
