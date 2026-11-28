
import { beforeEach, describe, expect, test, vi } from 'vitest'
import applescript from 'applescript'
import MacosAutomator, { appleScriptString } from '@main/automations/macos'

vi.mock('applescript', () => ({
  default: { execString: vi.fn((_script: string, cb: (err: Error | null, rtn: unknown) => void) => cb(null, '')) },
}))

vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: { config: {}, pressKey: vi.fn(), releaseKey: vi.fn(), type: vi.fn() },
  Key: { LeftCmd: 'LeftCmd', C: 'C', V: 'V', A: 'A' },
}))

const windowScript = (id: string, window: string) => `
          tell application "System Events"
            set appProcess to first application process whose bundle identifier is ${id}
            tell appProcess
              set frontmost to true
              set focusedWindow to first window whose name is ${window}
              perform action "AXRaise" of focusedWindow
              set value of attribute "AXFocused" of focusedWindow to true
            end tell
          end tell
        `

const appScript = (id: string) => `
          tell application "System Events"
            set appProcess to first application process whose bundle identifier is ${id}
            tell appProcess
              set frontmost to true
            end tell
          end tell
        `

const focus = async (id: any, window?: any): Promise<string | undefined> => {
  await new MacosAutomator().focusApp({ id, name: 'Test', path: '/Applications/Test.app', window })
  return vi.mocked(applescript.execString).mock.calls[0]?.[0]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('appleScriptString', () => {

  test.each([
    ['plain text', 'My Window', '"My Window"'],
    ['a double quote', 'say "hi"', '"say \\"hi\\""'],
    ['a backslash', 'C:\\Users\\me', '"C:\\\\Users\\\\me"'],
    ['a trailing backslash', 'folder\\', '"folder\\\\"'],
    ['a backslash before a quote', 'a\\"b', '"a\\\\\\"b"'],
    ['line breaks and tabs', 'line1\nline2\r\nline3\tend', '"line1\\nline2\\r\\nline3\\tend"'],
    ['an escape written out in the title', 'a\\nb', '"a\\\\nb"'],
    ['other control characters', 'a\0b\x07c\x7fd\x85e', '"abcde"'],
    ['non-ASCII text', 'Résumé — 文档 😀', '"Résumé — 文档 😀"'],
    ['an empty value', '', '""'],
  ])('%s', (_name, value, expected) => {
    expect(appleScriptString(value)).toBe(expected)
  })

  test('non-string values give a valid literal', () => {
    expect(appleScriptString(undefined as any)).toBe('""')
    expect(appleScriptString(null as any)).toBe('""')
    expect(appleScriptString(42 as any)).toBe('"42"')
    expect(appleScriptString({ toString: () => '" & x & "' } as any)).toBe('"\\" & x & \\""')
  })

})

describe('MacosAutomator.focusApp', () => {

  test('a plain window title is focused', async () => {
    expect(await focus('com.apple.TextEdit', 'Untitled 1')).toBe(windowScript('"com.apple.TextEdit"', '"Untitled 1"'))
    expect(applescript.execString).toHaveBeenCalledTimes(1)
  })

  test('the app alone is focused without a window title', async () => {
    expect(await focus('com.apple.TextEdit')).toBe(appScript('"com.apple.TextEdit"'))
    expect(await new MacosAutomator().focusApp({ id: 'com.apple.TextEdit', name: 'TextEdit', path: '', window: '' })).toBe(true)
    expect(vi.mocked(applescript.execString).mock.calls[1][0]).toBe(appScript('"com.apple.TextEdit"'))
  })

  test.each([
    ['a double quote', 'say "hi"', '"say \\"hi\\""'],
    ['a backslash', 'a\\b', '"a\\\\b"'],
    ['a trailing backslash', 'C:\\Users\\me\\', '"C:\\\\Users\\\\me\\\\"'],
    ['a backslash before a quote', 'a\\"b', '"a\\\\\\"b"'],
    ['a newline', 'line1\nline2', '"line1\\nline2"'],
    ['an expression that runs a shell command', '" & (do shell script "id") & "', '"\\" & (do shell script \\"id\\") & \\""'],
    ['a backslash-quote that closes the literal and comments out the rest', '\\" & (do shell script (string id {105, 100})) --', '"\\\\\\" & (do shell script (string id {105, 100})) --"'],
  ])('a window title with %s stays one string literal', async (_name, title, literal) => {
    expect(await focus('com.test.app', title)).toBe(windowScript('"com.test.app"', literal))
  })

  test('a hostile application id stays one string literal', async () => {
    const id = 'com.test.app" or name is "Finder'
    expect(await focus(id, 'Main')).toBe(windowScript('"com.test.app\\" or name is \\"Finder"', '"Main"'))
    vi.mocked(applescript.execString).mockClear()
    expect(await focus('x\\"\ndo shell script (string id {105, 100})\n--')).toBe(
      appScript('"x\\\\\\"\\ndo shell script (string id {105, 100})\\n--"')
    )
  })

  test('nothing runs without an application id', async () => {
    expect(await new MacosAutomator().focusApp({ id: '', name: 'Test', path: '', window: 'Main' })).toBe(false)
    expect(applescript.execString).not.toHaveBeenCalled()
  })

})
