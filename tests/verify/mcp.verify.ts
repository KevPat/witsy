//
// mcp (S-12): stdio MCP servers are started by the packaged app without a shell, and the app talks to
// them: the server lists its tools to the app. On Windows that includes a server started through an
// npm .cmd shim (npx) and one started as `cmd /c ...`, the two cases PR #3 asked to check by hand.
// The server reports the arguments it received, so what reaches it can be compared with the settings.
//

import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LaunchedApp, launchApp, makeHome, record, repoRoot, waitFor } from './harness'

const suite = 'mcp'
let launched: LaunchedApp
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-mcp-')))
const serverFile = path.join(dir, 'server.cjs')
const win = process.platform === 'win32'

// a minimal stdio server: one tool whose description is the list of its arguments
const serverSource = `
const sdk = ${JSON.stringify(path.join(repoRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs'))}
const { Server } = require(sdk + '/server/index.js')
const { StdioServerTransport } = require(sdk + '/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require(sdk + '/types.js')
const server = new Server({ name: 'verify', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'verify_args', description: JSON.stringify(process.argv.slice(2)), inputSchema: { type: 'object', properties: {} } }] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
server.connect(new StdioServerTransport())
`

// a local package with a bin: npx runs it through its own .cmd shim on Windows, with no registry involved
const npxPackage = path.join(path.dirname(serverFile), 'npx-package')
fs.mkdirSync(npxPackage, { recursive: true })
fs.writeFileSync(path.join(npxPackage, 'package.json'), JSON.stringify({ name: 'witsy-verify-mcp-server', version: '1.0.0', bin: { 'witsy-verify-mcp-server': 'server.cjs' } }))
fs.writeFileSync(path.join(npxPackage, 'server.cjs'), '#!/usr/bin/env node\n' + serverSource)

type Case = { uuid: string, label: string, command: string, url: string, expectArgs?: string[] }
const cases: Case[] = [
  { uuid: 'verify-node', label: 'node', command: 'node', url: `${serverFile} plain-arg second`, expectArgs: ['plain-arg', 'second'] },
  { uuid: 'verify-npx', label: 'npx (an npm .cmd shim on Windows)', command: 'npx', url: `--yes ${npxPackage} via-npx`, expectArgs: ['via-npx'] },
]
if (win) {
  cases.push({ uuid: 'verify-cmd', label: 'cmd /c', command: 'cmd', url: `/c node ${serverFile} via-cmd`, expectArgs: ['via-cmd'] })
  // characters a shell would interpret reach the server as they are (no shell in between)
  cases.push({ uuid: 'verify-special', label: 'special characters', command: 'node', url: `${serverFile} "a b" a&b 100% ^c "x|y"`, expectArgs: ['a b', 'a&b', '100%', '^c', 'x|y'] })
}

beforeAll(async () => {
  fs.writeFileSync(serverFile, serverSource)
  const servers = cases.map((c) => ({ uuid: c.uuid, registryId: c.uuid, state: 'enabled', type: 'stdio', label: c.label, command: c.command, url: c.url, toolSelection: null }))
  launched = await launchApp(makeHome(suite, { settings: { mcp: { servers, mcpServersExtra: {}, smitheryApiKey: '' }, plugins: { mcp: { enabled: true } } } }))
})

afterAll(async () => {
  await launched?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

for (const c of cases) {
  test(`a stdio server started with ${c.label} connects and lists its tools`, async () => {
    const tools = await waitFor(async () => {
      const all = await launched.window.evaluate(() => (window as any).api.mcp.getAllServersWithTools())
      const entry = all.find((e: any) => (e.server?.uuid ?? e.uuid) === c.uuid)
      return entry?.tools?.length ? entry.tools : null
    }, 60000, 1000).catch(async (e) => { record(suite, { [`${c.uuid}-error`]: String(e), [`${c.uuid}-raw`]: await launched.window.evaluate(() => (window as any).api.mcp.getAllServersWithTools()).catch((x: any) => String(x)) }); return null })
    const logs = launched.logs.filter((l) => l.includes(c.uuid) || /\[mcp\]/.test(l)).slice(-10)
    const args = tools ? JSON.parse(tools[0].description ?? tools[0].function?.description ?? '[]') : null
    record(suite, { [c.uuid]: { connected: !!tools, args, logs } })
    expect(tools, `not connected: ${logs.join('\n')}`).toBeTruthy()
    if (c.expectArgs) expect(args).toEqual(c.expectArgs)
  })
}
