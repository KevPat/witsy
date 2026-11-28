
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { runVbs } from '@el3um4s/run-vbs'
import WindowsAutomator, { vbsString } from '@main/automations/windows'

vi.mock('electron', () => ({ app: {} }))

vi.mock('@main/config', () => ({
  loadSettings: vi.fn(() => ({ automation: { altWinCopyPaste: false } })),
}))

vi.mock('@el3um4s/run-vbs', () => ({ runVbs: vi.fn(async () => undefined) }))

vi.mock('powershell', () => ({ default: vi.fn() }))

vi.mock('autolib', () => ({ default: { getForemostWindow: vi.fn() } }))

vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: { config: {}, pressKey: vi.fn(), releaseKey: vi.fn(), type: vi.fn() },
  Key: { LeftControl: 'LeftControl', C: 'C', V: 'V', A: 'A' },
}))

const activateScript = (target: string) => `
      Set WshShell = WScript.CreateObject("WScript.Shell")
      WshShell.AppActivate ${target}
      WScript.Sleep 200
    `

const activate = async (title: any): Promise<string | undefined> => {
  await new WindowsAutomator().activateApp(title)
  return (vi.mocked(runVbs).mock.calls[0]?.[0] as { vbs: string } | undefined)?.vbs
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('vbsString', () => {

  test('plain text becomes one quoted literal', () => {
    expect(vbsString('My Document - Notepad')).toBe('"My Document - Notepad"')
    expect(vbsString('100% done: C:\\Users\\me\\a.txt \'draft\'')).toBe('"100% done: C:\\Users\\me\\a.txt \'draft\'"')
  })

  test('double quotes are doubled', () => {
    expect(vbsString('"')).toBe('""""')
    expect(vbsString('say "hi"')).toBe('"say ""hi"""')
  })

  test('control characters are removed', () => {
    expect(vbsString('line1\r\nline2\ttab\0nul\x7fdel\x85nel')).toBe('"line1line2tabnuldelnel"')
  })

  test('non-ASCII characters never enter a quoted literal', () => {
    expect(vbsString('café')).toBe('"caf" & ChrW(233)')
    expect(vbsString('é" : x')).toBe('ChrW(233) & """ : x"')
    expect(vbsString('中文 - Notepad')).toBe('ChrW(20013) & ChrW(25991) & " - Notepad"')
    expect(vbsString('a\u2028b')).toBe('"a" & ChrW(8232) & "b"')
    expect(vbsString('ok 😀')).toBe('"ok " & ChrW(55357) & ChrW(56832)')
  })

  test('the length is bounded without splitting a surrogate pair', () => {
    expect(vbsString('a'.repeat(5000))).toBe(`"${'a'.repeat(512)}"`)
    expect(vbsString('"'.repeat(5000))).toBe(`"${'""'.repeat(512)}"`)
    expect(vbsString(`${'a'.repeat(511)}😀`)).toBe(`"${'a'.repeat(511)}"`)
  })

  test('empty and non-string values give a valid expression', () => {
    expect(vbsString('')).toBe('""')
    expect(vbsString('\r\n')).toBe('""')
    expect(vbsString(undefined as any)).toBe('""')
    expect(vbsString(null as any)).toBe('""')
    expect(vbsString(42 as any)).toBe('"42"')
    expect(vbsString({ toString: () => '" : Evil' } as any)).toBe('""" : Evil"')
  })

})

describe('WindowsAutomator.activateApp', () => {

  test('a plain title is activated', async () => {
    expect(await activate('My Document - Notepad')).toBe(activateScript('"My Document - Notepad"'))
    expect(runVbs).toHaveBeenCalledTimes(1)
  })

  test('a title that closes the string and adds statements stays one literal', async () => {
    expect(await activate('x" : CreateObject("WScript.Shell").Run "calc" : y = "')).toBe(
      activateScript('"x"" : CreateObject(""WScript.Shell"").Run ""calc"" : y = """')
    )
  })

  test('a title with line breaks cannot start a new statement', async () => {
    const script = await activate('x"\r\nCreateObject("WScript.Shell").Run "calc"\n\'')
    expect(script).toBe(activateScript('"x""CreateObject(""WScript.Shell"").Run ""calc""\'"'))
    expect(script!.trim().split('\n')).toHaveLength(3)
  })

  test('a non-ASCII character cannot hide the quote that follows it', async () => {
    expect(await activate('中" : CreateObject(Chr(87)).Run Chr(99) : Rem ')).toBe(
      activateScript('ChrW(20013) & """ : CreateObject(Chr(87)).Run Chr(99) : Rem "')
    )
  })

  test.each([
    ['empty', ''],
    ['only control characters', '\r\n\t'],
    ['missing', undefined],
  ])('nothing runs for a title that is %s', async (_name, title) => {
    expect(await activate(title)).toBeUndefined()
    expect(runVbs).not.toHaveBeenCalled()
  })

})
