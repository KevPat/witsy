
import { vi, test, expect } from 'vitest'
import { screen } from 'electron'
import Computer from '@main/computer'
import nut from '@main/automations/computer_nut'
import { mouse, keyboard, Key } from '@nut-tree-fork/nut-js'

const spyMove = vi.spyOn(nut, 'mouseMove')
const spyLeftClick = vi.spyOn(nut, 'leftClick')
const spyLeftClickDrag = vi.spyOn(nut, 'leftClickDrag')
const spyRightClick = vi.spyOn(nut, 'rightClick')
const spyMiddleClick = vi.spyOn(nut, 'middleClick')
const spyDoubleClick = vi.spyOn(nut, 'doubleClick')
const spyType = vi.spyOn(nut, 'type')
const spyKey = vi.spyOn(nut, 'key')

vi.mock('electron', async () => {
  return {
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
      getDisplayNearestPoint: vi.fn(() => ({ size: { width: 1920, height: 1080 } })),
    },
    desktopCapturer: {
      getSources: () => [
        { name: 'Entire Screen', thumbnail: { resize: () => ({ toJPEG: () => ({ toString: () => 'screenshot' }) }) } }
      ],
    },
  }
})

vi.mock('@nut-tree-fork/nut-js', async () => {
  return {
    mouse: {
      getPosition: vi.fn(() => ({ x: 0, y: 0 })),
      setPosition: vi.fn(),
      click: vi.fn(),
      leftClick: vi.fn(),
      rightClick: vi.fn(),
      doubleClick: vi.fn(),
      drag: vi.fn(),
    },
    keyboard: {
      config: { autoDelayMs: 0 },
      pressKey: vi.fn(),
      releaseKey: vi.fn(),
      type: vi.fn(),
    },
    // the real enum: the key map must only use members that exist in nut-js
    Key: (await vi.importActual<typeof import('@nut-tree-fork/shared')>('@nut-tree-fork/shared')).Key,
  }
})

test('Is available', async () => {
  await expect(Computer.isAvailable()).resolves.toBe(true)
})

test('Get active display  ', async () => {
  expect(Computer.getActiveDisplay()).toBeDefined()
  expect(screen.getCursorScreenPoint).toHaveBeenCalled()
  expect(screen.getDisplayNearestPoint).toHaveBeenCalled()
})

test('Get screen info', async () => {
  expect(Computer.getScreenSize()).toEqual({ width: 1920, height: 1080 })
  expect(Computer.getScreenNumber()).toBe(1)
  expect(Computer.getScaledScreenSize()).toEqual({ width: 1280, height: 720 })
})

test('Coordinates conversion', async () => {
  expect(Computer.realToScaled(640, 400)).toEqual({ x: 1280/3, y: 800/3 })
  expect(Computer.scaledToReal(1280/3, 800/3)).toEqual({ x: 640, y: 400 })
})

test('Take screenshot', async () => {
  await expect(Computer.takeScreenshot()).resolves.toBe('screenshot')
})

test('Execute actions', async () => {
  await expect(Computer.executeAction({ action: 'cursor_position' })).resolves.toHaveProperty('x')
  await expect(Computer.executeAction({ action: 'cursor_position' })).resolves.toHaveProperty('y')
  expect(mouse.getPosition).toHaveBeenLastCalledWith()
  
  await expect(Computer.executeAction({ action: 'mouse_move', coordinate: [1280/3, 800/3] })).resolves.toBe(true)
  expect(spyMove).toHaveBeenLastCalledWith(640, 400)
  expect(mouse.setPosition).toHaveBeenLastCalledWith({ x: 640, y: 400 })

  await expect(Computer.executeAction({ action: 'left_click' })).resolves.toBe(true)
  expect(spyLeftClick).toHaveBeenCalled()
  expect(mouse.leftClick).toHaveBeenLastCalledWith()

  await expect(Computer.executeAction({ action: 'left_click_drag', coordinate: [1280/3, 800/3] })).resolves.toBe(true)
  expect(spyLeftClickDrag).toHaveBeenLastCalledWith(640, 400)
  expect(mouse.drag).toHaveBeenLastCalledWith([{ x: 0, y: 0 }, { x: 640, y: 400 }])

  await expect(Computer.executeAction({ action: 'right_click' })).resolves.toBe(true)
  expect(spyRightClick).toHaveBeenCalled()
  expect(mouse.rightClick).toHaveBeenLastCalledWith()

  await expect(Computer.executeAction({ action: 'middle_click' })).resolves.toBe(true)
  expect(spyMiddleClick).toHaveBeenCalled()
  expect(mouse.click).toHaveBeenLastCalledWith(1)

  await expect(Computer.executeAction({ action: 'double_click' })).resolves.toBe(true)
  expect(spyDoubleClick).toHaveBeenCalled()
  expect(mouse.doubleClick).toHaveBeenLastCalledWith(0)

  await expect(Computer.executeAction({ action: 'type', text: 'Hello' })).resolves.toBe(true)
  expect(spyType).toHaveBeenLastCalledWith('Hello')
  expect(keyboard.type).toHaveBeenLastCalledWith('Hello')

  await expect(Computer.executeAction({ action: 'key', text: 'Return' })).resolves.toBe(true)
  expect(spyKey).toHaveBeenLastCalledWith('Return')
  expect(keyboard.pressKey).toHaveBeenLastCalledWith(Key.Return)
  expect(keyboard.releaseKey).toHaveBeenLastCalledWith(Key.Return)

  await expect(Computer.executeAction({ action: 'key', text: 'ctrl+a' })).resolves.toBe(true)
  expect(keyboard.pressKey).toHaveBeenLastCalledWith(Key.LeftControl, Key.A)
  expect(keyboard.releaseKey).toHaveBeenLastCalledWith(Key.LeftControl, Key.A)

})

test('Key names are translated to nut-js keys', async () => {

  await nut.isAvailable()

  const cases: [string, Key[]][] = [
    ['Return', [Key.Return]],
    ['Enter', [Key.Return]],
    ['KP_Enter', [Key.Enter]],
    ['Tab', [Key.Tab]],
    ['Escape', [Key.Escape]],
    ['BackSpace', [Key.Backspace]],
    ['Delete', [Key.Delete]],
    ['space', [Key.Space]],
    ['Up', [Key.Up]],
    ['Down', [Key.Down]],
    ['Left', [Key.Left]],
    ['Right', [Key.Right]],
    ['Home', [Key.Home]],
    ['End', [Key.End]],
    ['Page_Up', [Key.PageUp]],
    ['Page_Down', [Key.PageDown]],
    ['Prior', [Key.PageUp]],
    ['Next', [Key.PageDown]],
    ['F1', [Key.F1]],
    ['F5', [Key.F5]],
    ['F12', [Key.F12]],
    ['ctrl', [Key.LeftControl]],
    ['Control_L', [Key.LeftControl]],
    ['alt', [Key.LeftAlt]],
    ['shift', [Key.LeftShift]],
    ['super', [Key.LeftSuper]],
    ['cmd', [Key.LeftSuper]],
    ['meta', [Key.LeftSuper]],
    ['a', [Key.A]],
    ['Z', [Key.Z]],
    ['0', [Key.Num0]],
    ['9', [Key.Num9]],
    ['minus', [Key.Minus]],
    ['ctrl+a', [Key.LeftControl, Key.A]],
    ['ctrl+shift+Tab', [Key.LeftControl, Key.LeftShift, Key.Tab]],
    ['alt+F4', [Key.LeftAlt, Key.F4]],
    ['cmd+space', [Key.LeftSuper, Key.Space]],
    ['ctrl+plus', [Key.LeftControl, Key.Add]],
    // models are not consistent with case, underscores and spaces
    ['RETURN', [Key.Return]],
    ['escape', [Key.Escape]],
    ['backspace', [Key.Backspace]],
    ['PageDown', [Key.PageDown]],
    ['page_up', [Key.PageUp]],
    ['CTRL+C', [Key.LeftControl, Key.C]],
    ['Ctrl + Alt + Delete', [Key.LeftControl, Key.LeftAlt, Key.Delete]],
    ['f11', [Key.F11]],
    ['Page Up', [Key.PageUp]],
    // keypad digits are not the digits of the top row
    ['KP_0', [Key.NumPad0]],
    ['KP_7', [Key.NumPad7]],
    ['shift+KP_3', [Key.LeftShift, Key.NumPad3]],
  ]

  for (const [text, keys] of cases) {
    vi.mocked(keyboard.pressKey).mockClear()
    vi.mocked(keyboard.releaseKey).mockClear()
    await nut.key(text)
    expect(keys.every((key) => typeof key === 'number'), text).toBe(true)
    expect(keyboard.pressKey, text).toHaveBeenCalledTimes(1)
    expect(keyboard.pressKey, text).toHaveBeenCalledWith(...keys)
    expect(keyboard.releaseKey, text).toHaveBeenCalledTimes(1)
    expect(keyboard.releaseKey, text).toHaveBeenCalledWith(...keys)
  }

})

test('Every supported key name maps to a member of the nut-js Key enum', async () => {

  await nut.isAvailable()

  const names = [
    'Return', 'Enter', 'KP_Enter', 'Tab', 'Escape', 'Esc', 'space', 'BackSpace', 'Delete', 'Del', 'Insert', 'Ins',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Page_Up', 'PgUp', 'Prior', 'Page_Down', 'PgDn', 'Next',
    'ctrl', 'control', 'Control_L', 'Control_R', 'alt', 'Alt_L', 'Alt_R', 'option', 'shift', 'Shift_L', 'Shift_R',
    'super', 'Super_L', 'Super_R', 'cmd', 'command', 'meta', 'win', 'windows', 'Caps_Lock', 'Print', 'Menu',
    'minus', '-', 'equal', '=', 'plus', 'comma', ',', 'period', '.', 'slash', '/', 'backslash', '\\',
    'semicolon', ';', 'apostrophe', 'quote', '\'', 'grave', '`', 'bracketleft', '[', 'bracketright', ']',
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ]

  for (const name of names) {
    vi.mocked(keyboard.pressKey).mockClear()
    await nut.key(name)
    const pressed = vi.mocked(keyboard.pressKey).mock.calls[0]
    expect(pressed, name).toHaveLength(1)
    expect(typeof pressed[0], name).toBe('number')
    expect(Key[pressed[0]], name).toBeTypeOf('string')
  }

})

test('Escape is pressed although its nut-js value is 0', async () => {
  await nut.isAvailable()
  expect(Key.Escape).toBe(0)
  vi.mocked(keyboard.pressKey).mockClear()
  await nut.key('Escape')
  expect(keyboard.pressKey).toHaveBeenCalledWith(0)
})

test('Unknown key names are refused and nothing is pressed', async () => {

  await nut.isAvailable()

  for (const text of ['Hyper_L', 'F25', 'f0', 'ab', '', ' ', 'KP_10', 'ctrl+', 'ctrl++', 'ctrl+nope', 'constructor', '__proto__', 'toString']) {
    vi.mocked(keyboard.pressKey).mockClear()
    vi.mocked(keyboard.releaseKey).mockClear()
    await expect(nut.key(text), text).rejects.toThrow('Tried to press unknown key')
    expect(keyboard.pressKey, text).not.toHaveBeenCalled()
    expect(keyboard.releaseKey, text).not.toHaveBeenCalled()
  }

  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(Computer.executeAction({ action: 'key', text: 'ctrl+nope' })).resolves.toBe(false)

})

test('Keys are released even when pressing them fails', async () => {
  await nut.isAvailable()
  vi.mocked(keyboard.pressKey).mockClear()
  vi.mocked(keyboard.releaseKey).mockClear()
  vi.mocked(keyboard.pressKey).mockRejectedValueOnce(new Error('press failed'))
  await expect(nut.key('ctrl+a')).rejects.toThrow('press failed')
  expect(keyboard.releaseKey).toHaveBeenCalledWith(Key.LeftControl, Key.A)
})

test('A failed release does not hide the error of the press', async () => {
  await nut.isAvailable()
  vi.mocked(keyboard.pressKey).mockRejectedValueOnce(new Error('press failed'))
  vi.mocked(keyboard.releaseKey).mockRejectedValueOnce(new Error('release failed'))
  await expect(nut.key('ctrl+a')).rejects.toThrow('press failed')
})

test('A failed release is reported', async () => {
  await nut.isAvailable()
  vi.mocked(keyboard.releaseKey).mockRejectedValueOnce(new Error('release failed'))
  await expect(nut.key('ctrl+a')).rejects.toThrow('release failed')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(keyboard.releaseKey).mockRejectedValueOnce(new Error('release failed'))
  await expect(Computer.executeAction({ action: 'key', text: 'ctrl+a' })).resolves.toBe(false)
})


