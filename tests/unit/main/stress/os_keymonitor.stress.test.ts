
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { bug } from './bug'

// The platform is pinned to win32 so the key tables are deterministic on every host (macOS CI,
// this Linux machine, Windows developers). win32 delivers modifiers as plain down/up events.
const VK = { leftControl: 0xA2, leftShift: 0xA0, C: 0x43 }

type Ev = { type: 'down' | 'up', keyCode: number, flags: number, isRepeat: boolean }
type Cb = { onDown: ReturnType<typeof vi.fn>, onUp: ReturnType<typeof vi.fn> }

let settings: any = { shortcuts: {} }
let monitorCb: ((ev: Ev) => void) | null = null

vi.mock('@main/config', () => ({ loadSettings: vi.fn(() => settings) }))

vi.mock('autolib', () => ({
  default: {
    startKeyMonitor: vi.fn((cb: (ev: Ev) => void) => { monitorCb = cb; return 0 }),
    stopKeyMonitor: vi.fn(() => 0),
    isKeyMonitorRunning: vi.fn(() => false),
  },
}))

const callbackNames = ['prompt', 'chat', 'command', 'readaloud', 'dictation', 'audioBooth', 'scratchpad', 'realtime', 'studio', 'forge']
const makeCallbacks = (): Record<string, Cb> =>
  Object.fromEntries(callbackNames.map(n => [n, { onDown: vi.fn(), onUp: vi.fn() }]))

const send = (type: 'down' | 'up', keyCode: number) => monitorCb!({ type, keyCode, flags: 0, isRepeat: false })

let KeyMonitor: typeof import('@main/keymonitor').default
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.resetModules()
  KeyMonitor = (await import('@main/keymonitor')).default
})

afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

let km: InstanceType<typeof KeyMonitor> | null = null

beforeEach(() => {
  vi.clearAllMocks()
  monitorCb = null
  settings = { shortcuts: {} }
})

afterEach(() => {
  km?.stop()
  km = null
})

describe('KeyMonitor modifier-only shortcuts', () => {

  const startWith = (shortcut: any): Record<string, Cb> => {
    settings = { shortcuts: { main: shortcut } }
    const callbacks = makeCallbacks()
    km = new KeyMonitor({} as any, callbacks as any)
    km.start()
    return callbacks
  }

  test('a modifier pressed and released alone triggers onDown then onUp', () => {
    const cb = startWith({ type: 'native', leftControl: true })
    send('down', VK.leftControl)
    send('up', VK.leftControl)
    expect(cb.chat.onDown).toHaveBeenCalledTimes(1)
    expect(cb.chat.onUp).toHaveBeenCalledTimes(1)
  })

  test('a modifier+key shortcut fires on the key and releases on key up', () => {
    const cb = startWith({ type: 'native', leftControl: true, key: 'C' })
    send('down', VK.leftControl)
    send('down', VK.C)
    expect(cb.chat.onDown).toHaveBeenCalledTimes(1)
    send('up', VK.C)
    send('up', VK.leftControl)
    expect(cb.chat.onUp).toHaveBeenCalledTimes(1)
  })

  bug('does not fire a modifier-only shortcut that was released while another modifier was held', () => {
    // fails today: handleModifierDown only marks the newly pressed modifier as "alone"; it never
    // clears the "alone" flag of modifiers already held, so Control still counts as pressed alone.
    const cb = startWith({ type: 'native', leftControl: true })
    send('down', VK.leftControl)
    send('down', VK.leftShift)
    send('up', VK.leftControl)
    expect(cb.chat.onUp).not.toHaveBeenCalled()
  })

  bug('seeded fuzz: modifier-only onUp fires only when the modifier was truly alone', () => {
    // fails today: same defect, surfaced over a randomised interleaving of Control/Shift presses.
    const cb = startWith({ type: 'native', leftControl: true })

    let seed = 987654321
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

    // a guaranteed overlap up front, then random valid toggles
    const seq: string[] = ['cd', 'sd', 'su', 'cu']
    let cDown = false, sDown = false
    for (let i = 0; i < 80; i++) {
      const choices: string[] = []
      choices.push(cDown ? 'cu' : 'cd')
      choices.push(sDown ? 'su' : 'sd')
      const pick = choices[Math.floor(rand() * choices.length)]
      if (pick === 'cd') cDown = true
      else if (pick === 'cu') cDown = false
      else if (pick === 'sd') sDown = true
      else sDown = false
      seq.push(pick)
    }
    if (cDown) seq.push('cu')
    if (sDown) seq.push('su')

    // reference model: Control is "alone" only if no Shift was held during its press
    let c = false, s = false, alone = false, expected = 0
    for (const ev of seq) {
      if (ev === 'cd') { c = true; alone = !s }
      else if (ev === 'cu') { if (c && alone) expected++; c = false }
      else if (ev === 'sd') { s = true; if (c) alone = false }
      else if (ev === 'su') { s = false }
    }

    for (const ev of seq) {
      if (ev === 'cd') send('down', VK.leftControl)
      else if (ev === 'cu') send('up', VK.leftControl)
      else if (ev === 'sd') send('down', VK.leftShift)
      else send('up', VK.leftShift)
    }

    expect(cb.chat.onUp).toHaveBeenCalledTimes(expected)
  })

})
