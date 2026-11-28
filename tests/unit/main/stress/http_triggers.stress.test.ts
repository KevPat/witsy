import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installHttpTriggers } from '@main/http_triggers'
import * as window from '@main/window'
import * as config from '@main/config'
import PromptAnywhere from '@main/automations/anywhere'
import Commander from '@main/automations/commander'
import ReadAloud from '@main/automations/readaloud'
import Dictation from '@main/automations/dictation'
import { bug } from './bug'

// Every trigger is a GET that changes state (opens a window, starts dictation, reads the selection
// aloud, pre-fills a prompt). A GET is a CORS "simple request": any web page can fire it with an
// <img> tag or a navigation and no preflight is sent. The handlers are captured from a fake
// httpServer.register and called with inert req/res objects; all window and automation modules are
// mocked so nothing is opened and no native automation runs.

vi.mock('@main/window', () => ({
  openMainWindow: vi.fn(),
  openSettingsWindow: vi.fn(),
  openDesignStudioWindow: vi.fn(),
  openAgentForgeWindow: vi.fn(),
  openRealtimeChatWindow: vi.fn(),
  openPromptAnywhere: vi.fn(),
  openCommandPicker: vi.fn(),
}))

vi.mock('@main/config', () => ({
  loadSettings: vi.fn(),
}))

vi.mock('@main/automations/anywhere', () => ({ default: { open: vi.fn() } }))
vi.mock('@main/automations/commander', () => ({ default: { initCommand: vi.fn() } }))
vi.mock('@main/automations/readaloud', () => ({ default: { read: vi.fn() } }))
vi.mock('@main/automations/dictation', () => ({ default: { initDictation: vi.fn() } }))
vi.mock('@main/automations/automator', () => ({
  default: vi.fn(() => ({ getForemostApp: vi.fn(async () => null) })),
}))

type Handler = (req: any, res: any, url: URL) => Promise<void> | void

let routes: Map<string, Handler>

const response = () => {
  const res: any = { statusCode: 0, body: '' }
  res.writeHead = vi.fn((status: number) => { res.statusCode = status })
  res.end = vi.fn((chunk?: any) => { if (chunk) res.body += String(chunk) })
  return res
}

const get = async (route: string, query: string, headers: Record<string, string>) => {
  const res = response()
  await routes.get(route)!({ method: 'GET', headers }, res, new URL(`http://localhost:8090${route}${query}`))
  return res
}

// the headers a browser attaches to a cross-site subresource or navigation request
const kCrossSite = {
  origin: 'https://evil.example',
  referer: 'https://evil.example/page.html',
  'sec-fetch-site': 'cross-site',
}

// every state-changing trigger, the query that selects the branch, and the side effect it causes
const kTriggers: [string, string, string, () => any][] = [
  ['/api/chat', '', 'opens the main window', () => window.openMainWindow],
  ['/api/chat', '?text=injected', 'opens the main window with attacker text', () => window.openMainWindow],
  ['/api/scratchpad', '', 'opens the scratchpad', () => window.openMainWindow],
  ['/api/settings', '', 'opens the settings window', () => window.openSettingsWindow],
  ['/api/studio', '', 'opens the design studio', () => window.openDesignStudioWindow],
  ['/api/forge', '', 'opens the agent forge', () => window.openAgentForgeWindow],
  ['/api/realtime', '', 'opens the realtime (microphone) window', () => window.openRealtimeChatWindow],
  ['/api/prompt', '', 'opens prompt anywhere', () => PromptAnywhere.open],
  ['/api/prompt', '?text=injected', 'opens prompt anywhere with attacker text', () => window.openPromptAnywhere],
  ['/api/command', '', 'starts an AI command on the current selection', () => Commander.initCommand],
  ['/api/command', '?text=injected', 'opens the command picker with attacker text', () => window.openCommandPicker],
  ['/api/transcribe', '', 'starts dictation (microphone)', () => Dictation.initDictation],
  ['/api/readaloud', '', 'reads the current selection aloud', () => ReadAloud.read],
]

const kRoutes = [...new Set(kTriggers.map(([route]) => route))]

// small deterministic PRNG so a failing fuzz case can be reproduced from its seed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: true } } as any)
  routes = new Map()
  installHttpTriggers({ register: vi.fn((p: string, h: Handler) => routes.set(p, h)) } as any, {} as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('http triggers: cross-site GET requests (CSRF)', () => {

  test('the table covers every registered state-changing route', () => {
    expect([...routes.keys()].filter((r) => r !== '/api/health').sort()).toEqual([...kRoutes].sort())
  })

  bug.each(kTriggers)('a cross-site GET %s%s is refused before it %s', async (route, query, _, sideEffect) => {
    // fails today: the handler performs the action for any GET, whatever Origin/Referer/Sec-Fetch-Site says
    await get(route, query, kCrossSite)
    expect(sideEffect()).not.toHaveBeenCalled()
  })

  test('a same-machine GET without browser headers still triggers the action', async () => {
    // the legitimate use (curl, Stream Deck, Shortcuts) must keep working after a fix
    for (const [route, query, , sideEffect] of kTriggers) {
      vi.clearAllMocks()
      vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: true } } as any)
      const res = await get(route, query, {})
      expect(res.statusCode).toBe(200)
      expect(sideEffect()).toHaveBeenCalledTimes(1)
    }
  })

  test('/api/health is read-only', async () => {
    const res = await get('/api/health', '', kCrossSite)
    expect(res.statusCode).toBe(200)
    for (const [, , , sideEffect] of kTriggers) expect(sideEffect()).not.toHaveBeenCalled()
  })

})

describe('http triggers: the enableHttpEndpoints gate', () => {

  test.each(['/api/health', ...kRoutes])('%s answers 404 and does nothing when endpoints are disabled', async (route) => {
    vi.mocked(config.loadSettings).mockReturnValue({ general: { enableHttpEndpoints: false } } as any)
    const res = await get(route, '?text=x', {})
    expect(res.statusCode).toBe(404)
    for (const [, , , sideEffect] of kTriggers) expect(sideEffect()).not.toHaveBeenCalled()
  })

})

describe('http triggers: query string fuzz', () => {

  const kPieces = ['text', '=', '&', '%', '%zz', '%00', '%C3%28', '+', '#', '?', ';', '[]', '__proto__', 'constructor',
    '\u0000', '\u202e', '\ud83d\ude00', ' ', '"', '\'', '<script>', '../', 'a'.repeat(300), '=='.repeat(40)]

  test('every route answers every query without throwing', async () => {
    const rand = mulberry32(0xC0FFEE)
    for (let i = 0; i < 300; i++) {
      const route = kRoutes[Math.floor(rand() * kRoutes.length)]
      const count = 1 + Math.floor(rand() * 8)
      let query = '?'
      for (let j = 0; j < count; j++) query += kPieces[Math.floor(rand() * kPieces.length)]
      const res = await get(route, query, {})
      expect(res.end, `seed 0xC0FFEE iteration ${i}: ${route}${query}`).toHaveBeenCalledTimes(1)
      expect([200, 500], `seed 0xC0FFEE iteration ${i}: ${route}${query}`).toContain(res.statusCode)
    }
  })

  test('a query cannot pollute Object.prototype through parseParams', async () => {
    await get('/api/chat', '?__proto__=polluted&constructor=x&text=hi', {})
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'text')).toBe(false)
  })

})
