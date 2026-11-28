
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runVbs } from '@el3um4s/run-vbs'
import applescript from 'applescript'
import WindowsAutomator from '@main/automations/windows'
import MacosAutomator from '@main/automations/macos'
import { bug } from './bug'

// Every OS-touching dependency is replaced so the automators only build scripts, never run them.
vi.mock('electron', () => ({ app: {} }))

vi.mock('@main/config', () => ({
  loadSettings: vi.fn(() => ({ automation: { altWinCopyPaste: false } })),
}))

vi.mock('@el3um4s/run-vbs', () => ({ runVbs: vi.fn(async () => undefined) }))

vi.mock('powershell', () => ({ default: vi.fn() }))

vi.mock('autolib', () => ({ default: { getForemostWindow: vi.fn() } }))

vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: { config: {}, pressKey: vi.fn(), releaseKey: vi.fn(), type: vi.fn() },
  mouse: {},
  Key: { LeftControl: 'LeftControl', LeftCmd: 'LeftCmd', C: 'C', V: 'V', A: 'A' },
}))

// applescript executes the script through a callback; we resolve it and keep the script
vi.mock('applescript', () => ({
  default: { execString: vi.fn((_script: string, cb: (err: Error | null, rtn: unknown) => void) => cb(null, '')) },
}))
const execString = vi.mocked(applescript.execString)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

//
// A tiny VBScript statement splitter. VBScript separates statements with newlines and `:` and
// escapes a double quote inside a string by doubling it (""). A payload that can close the
// string literal early therefore introduces extra top-level statements; a raw newline inside a
// literal or an unterminated literal is a syntax error. The markers below flag both.
//
const vbsStatements = (script: string): string[] => {
  const out: string[] = []
  let cur = ''
  let inStr = false
  for (let i = 0; i < script.length; i++) {
    const c = script[i]
    if (inStr) {
      if (c === '"') {
        if (script[i + 1] === '"') { cur += '""'; i++ }
        else { inStr = false; cur += c }
      } else if (c === '\n' || c === '\r') {
        out.push('__RAW_NEWLINE_IN_STRING__')
        cur += c
      } else {
        cur += c
      }
    } else if (c === '"') {
      inStr = true
      cur += c
    } else if (c === '\n' || c === '\r' || c === ':') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  if (inStr) out.push('__UNTERMINATED_STRING__')
  if (cur.trim()) out.push(cur.trim())
  return out
}

const activateScriptFor = async (title: string): Promise<string> => {
  vi.mocked(runVbs).mockClear()
  await new WindowsAutomator().activateApp(title)
  return (vi.mocked(runVbs).mock.calls[0][0] as { vbs: string }).vbs
}

describe('WindowsAutomator.activateApp VBScript injection', () => {

  test('a benign window title produces exactly three well-formed statements', async () => {
    const stmts = vbsStatements(await activateScriptFor('My Document - Notepad'))
    expect(stmts).toHaveLength(3)
    expect(stmts).not.toContain('__RAW_NEWLINE_IN_STRING__')
    expect(stmts).not.toContain('__UNTERMINATED_STRING__')
  })

  test.each([
    ['double quote', '"'],
    ['newline', 'line1\nline2'],
    ['statement injection', '" : CreateObject("WScript.Shell").Run("calc") \''],
    ['carriage return + run', 'x"\r\nCreateObject("WScript.Shell").Run("calc")'],
  ])('a window title with %s cannot alter the VBScript', async (_name, payload) => {
    // S-04: the title used to be interpolated into the .vbs with no escaping, so the payload
    // closed the AppActivate string literal and added statements / broke it.
    const stmts = vbsStatements(await activateScriptFor(payload))
    expect(stmts).not.toContain('__RAW_NEWLINE_IN_STRING__')
    expect(stmts).not.toContain('__UNTERMINATED_STRING__')
    expect(stmts).toHaveLength(3)
  })

})

describe('WindowsAutomator fixed-script methods do not interpolate anything', () => {

  test.each([
    ['selectAll', (a: WindowsAutomator) => a.selectAll()],
    ['moveCaretBelow', (a: WindowsAutomator) => a.moveCaretBelow()],
    ['deleteSelectedText', (a: WindowsAutomator) => a.deleteSelectedText()],
  ])('%s builds a constant, well-formed script', async (_name, run) => {
    vi.mocked(runVbs).mockClear()
    await run(new WindowsAutomator())
    const vbs = (vi.mocked(runVbs).mock.calls[0][0] as { vbs: string }).vbs
    const stmts = vbsStatements(vbs)
    expect(stmts).not.toContain('__RAW_NEWLINE_IN_STRING__')
    expect(stmts).not.toContain('__UNTERMINATED_STRING__')
    expect(vbs).not.toContain('${')
  })

})

//
// AppleScript string literals escape a double quote as \" and a backslash as \\, and cannot
// contain a raw newline. The parser decodes the `whose name is "…"` literal that focusApp builds.
//
const parseAppleScriptName = (script: string): { malformed: boolean, value: string } => {
  const marker = 'whose name is "'
  const at = script.indexOf(marker)
  if (at < 0) return { malformed: true, value: '' }
  let value = ''
  let terminated = false
  let malformed = false
  for (let j = at + marker.length; j < script.length; j++) {
    const c = script[j]
    if (c === '\\') {
      const n = script[j + 1]
      if (n === '"') { value += '"'; j++ }
      else if (n === '\\') { value += '\\'; j++ }
      else value += '\\'
    } else if (c === '"') {
      terminated = true
      break
    } else if (c === '\n' || c === '\r') {
      malformed = true
      break
    } else {
      value += c
    }
  }
  if (!terminated) malformed = true
  return { malformed, value }
}

const focusScriptFor = async (window: string): Promise<string> => {
  execString.mockClear()
  await new MacosAutomator().focusApp({ id: 'com.test.app', name: 'Test', path: '', window })
  return execString.mock.calls[0][0]
}

describe('MacosAutomator.focusApp AppleScript quoting', () => {

  test('a benign window title round-trips through the AppleScript literal', async () => {
    const parsed = parseAppleScriptName(await focusScriptFor('My Window'))
    expect(parsed.malformed).toBe(false)
    expect(parsed.value).toBe('My Window')
  })

  test('an embedded double quote is escaped correctly', async () => {
    const parsed = parseAppleScriptName(await focusScriptFor('say "hi"'))
    expect(parsed.malformed).toBe(false)
    expect(parsed.value).toBe('say "hi"')
  })

  bug.each([
    ['trailing backslash', 'C:\\Users\\me\\'],
    ['embedded newline', 'line1\nline2'],
    ['backslash then quote', 'a\\"b'],
  ])('a window title with %s stays a well-formed, intact AppleScript literal', async (_name, payload) => {
    // fails today: macos.ts escapes `"` but not `\` or newlines, so the title either breaks the
    // literal (backslash eats the closing quote) or spans lines (syntax error).
    const parsed = parseAppleScriptName(await focusScriptFor(payload))
    expect(parsed.malformed).toBe(false)
    expect(parsed.value).toBe(payload)
  })

})
