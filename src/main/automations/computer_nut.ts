
//
// code from https://github.com/corbt/agent.exe
//

// get some enums from nut-js
// and declare some interfaces and variables
// to avoid typescript lint errors

enum Button {
  LEFT = 0,
  MIDDLE = 1,
  RIGHT = 2
}

interface Point {
  x: number
  y: number
}

interface Mouse {
  getPosition(): Promise<Point>
  setPosition(point: Point): Promise<Mouse>
  click(button: any): Promise<Mouse>
  leftClick(): Promise<Mouse>
  rightClick(): Promise<Mouse>
  doubleClick(button: any): Promise<Mouse>
  drag(points: Point[]): Promise<Mouse>
}

interface Keyboard {
  config: any
  pressKey(...keys: any[]): Promise<Keyboard>
  releaseKey(...keys: any[]): Promise<Keyboard>
  type(text: string): Promise<Keyboard>
}

let mouse: Mouse
let keyboard: Keyboard

// the Key enum of nut-js: its numeric values change between nut-js versions, never hard-code them
let Key: Record<string, number>

// xdotool-style key names sent by computer-use models -> member of the nut-js Key enum
// looked up on the lower-cased name without underscores and spaces (Page_Up, page_up, PageUp...)
const keyNames: Record<string, string> = {
  return: 'Return', enter: 'Return', kpenter: 'Enter',
  tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp', prior: 'PageUp',
  pagedown: 'PageDown', pgdn: 'PageDown', next: 'PageDown',
  ctrl: 'LeftControl', control: 'LeftControl', controll: 'LeftControl', controlr: 'RightControl',
  alt: 'LeftAlt', altl: 'LeftAlt', altr: 'RightAlt', option: 'LeftAlt',
  shift: 'LeftShift', shiftl: 'LeftShift', shiftr: 'RightShift',
  super: 'LeftSuper', superl: 'LeftSuper', superr: 'RightSuper',
  cmd: 'LeftSuper', command: 'LeftSuper', meta: 'LeftSuper', win: 'LeftSuper', windows: 'LeftSuper',
  capslock: 'CapsLock', print: 'Print', menu: 'Menu',
  minus: 'Minus', '-': 'Minus', equal: 'Equal', '=': 'Equal', plus: 'Add',
  comma: 'Comma', ',': 'Comma', period: 'Period', '.': 'Period',
  slash: 'Slash', '/': 'Slash', backslash: 'Backslash', '\\': 'Backslash',
  semicolon: 'Semicolon', ';': 'Semicolon', apostrophe: 'Quote', quote: 'Quote', '\'': 'Quote',
  grave: 'Grave', '`': 'Grave',
  bracketleft: 'LeftBracket', '[': 'LeftBracket', bracketright: 'RightBracket', ']': 'RightBracket',
}

const toNutKey = (name: string): number|undefined => {
  const key = name.toLowerCase().replace(/[_\s]/g, '')
  if (/^[a-z]$/.test(key)) return Key[key.toUpperCase()]
  if (/^[0-9]$/.test(key)) return Key[`Num${key}`]
  if (/^kp[0-9]$/.test(key)) return Key[`NumPad${key[2]}`]
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return Key[key.toUpperCase()]
  return Object.prototype.hasOwnProperty.call(keyNames, key) ? Key[keyNames[key]] : undefined
}

export default {

  async isAvailable(): Promise<boolean> {
    try {
      const nutPackage = '@nut-tree-fork/nut-js';
      ({ mouse, keyboard, Key } = await import(nutPackage));
      return true
    } catch {
      console.log('Error loading nut-js. Disabling computer interaction.');
      return false
    }
  },

  async getCursorPosition(): Promise<Point> {
    return await mouse.getPosition()
  },

  async mouseMove(x: number, y: number) {
    await mouse.setPosition({ x, y })
  },

  async leftClick() {
    await mouse.leftClick()
  },

  async rightClick() {
    await mouse.rightClick()
  },

  async middleClick() {
    await mouse.click(Button.MIDDLE)
  },

  async doubleClick() {
    await mouse.doubleClick(Button.LEFT)
  },

  async leftClickDrag(x: number, y: number) {
    const position = await mouse.getPosition()
    return mouse.drag([position, { x, y }])
  },

  async key(text: string) {
    const keys = text.split('+').map((key) => {
      const mappedKey = toNutKey(key);
      if (mappedKey === undefined) {
        throw new Error(`Tried to press unknown key: ${key}`);
      }
      return mappedKey;
    });
    // pressKey holds the keys down: without the release a modifier stays stuck after the action
    try {
      await keyboard.pressKey(...keys);
    } catch (e) {
      try {
        await keyboard.releaseKey(...keys);
      } catch { /* best effort: the error of the press is the one to report */ }
      throw e;
    }
    await keyboard.releaseKey(...keys);
  },

  async type(text: string) {
    const oldDelay = keyboard.config.autoDelayMs
    keyboard.config.autoDelayMs = 0
    await keyboard.type(text)
    keyboard.config.autoDelayMs = oldDelay
  }

}