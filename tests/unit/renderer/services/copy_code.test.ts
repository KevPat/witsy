
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { renderMarkdown } from '@main/markdown'
import { installCopyCodeHandler } from '@services/copy_code'
import { useWindowMock } from '@tests/mocks/window'

// The "Copy code" link under a code block has no inline handler (the content security policy of
// the app forbids them): one listener on the document serves every link.

let uninstall: () => void
let writeText: ReturnType<typeof vi.fn>

const show = (html: string): HTMLElement => {
  const holder = document.createElement('div')
  holder.innerHTML = html
  document.body.appendChild(holder)
  return holder
}

beforeAll(() => {
  useWindowMock()
})

beforeEach(() => {
  vi.useFakeTimers()
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  window.api.base64.decode = (data: string) => Buffer.from(data, 'base64').toString()
  uninstall = installCopyCodeHandler()
})

afterEach(() => {
  uninstall()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('the link of a rendered code block has no handler of its own', () => {
  const holder = show(renderMarkdown('```js\nconst a = 1\n```'))
  const link = holder.querySelector('a.copy-code')
  expect(link.getAttributeNames().sort()).toEqual(['class', 'data-copy-code'])
  expect(holder.innerHTML).not.toMatch(/\son[a-z]+=/)
})

test('a click on the link copies the code of the block', () => {
  const code = 'const text = \'it\\\'s "quoted"\'\nconsole.log(`${text} <b>&amp;</b> é 漢字`)'
  const holder = show(renderMarkdown(`\`\`\`js\n${code}\n\`\`\``))
  holder.querySelector<HTMLElement>('a.copy-code').click()
  expect(writeText).toHaveBeenCalledOnce()
  expect(writeText).toHaveBeenCalledWith(`${code}\n`)
})

test('the link says the code was copied, then goes back to its label', () => {
  const holder = show(renderMarkdown('```js\nconst a = 1\n```'))
  const link = holder.querySelector<HTMLElement>('a.copy-code')
  expect(link.textContent).toBe('Copy code')
  link.click()
  expect(link.textContent).toBe('Copied!')
  vi.advanceTimersByTime(999)
  expect(link.textContent).toBe('Copied!')
  vi.advanceTimersByTime(1)
  expect(link.textContent).toBe('Copy code')
})

test('each block copies its own code', () => {
  const holder = show(renderMarkdown('```js\nfirst()\n```\n\ntext\n\n```py\nsecond()\n```'))
  const links = holder.querySelectorAll<HTMLElement>('a.copy-code')
  expect(links).toHaveLength(2)
  links[1].click()
  expect(writeText).toHaveBeenLastCalledWith('second()\n')
  links[0].click()
  expect(writeText).toHaveBeenLastCalledWith('first()\n')
})

test('a link that is displayed after the handler was installed works too', () => {
  const holder = show('<p>nothing yet</p>')
  holder.innerHTML = renderMarkdown('```js\nlater()\n```')
  holder.querySelector<HTMLElement>('a.copy-code').click()
  expect(writeText).toHaveBeenCalledWith('later()\n')
})

test('a click inside the link counts as a click on the link', () => {
  const holder = show('<p><a class="copy-code" data-copy-code="aGVsbG8="><span>Copy code</span></a></p>')
  holder.querySelector<HTMLElement>('span').click()
  expect(writeText).toHaveBeenCalledWith('hello')
})

test('the click does nothing else', () => {
  const holder = show(renderMarkdown('```js\nconst a = 1\n```'))
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  holder.querySelector('a.copy-code').dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
})

test.each([
  ['a link without code', '<a class="copy-code">Copy code</a>'],
  ['another link', '<a class="other" data-copy-code="aGVsbG8=">Copy code</a>'],
  ['an element that is not a link', '<span class="copy-code" data-copy-code="aGVsbG8=">Copy code</span>'],
  ['plain text', '<p>Copy code</p>'],
])('a click on %s copies nothing', (_, html) => {
  const holder = show(html)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  holder.firstElementChild.dispatchEvent(event)
  expect(writeText).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
  expect(holder.firstElementChild.textContent).toBe('Copy code')
})

test('a clipboard that refuses the text does not break the page', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  writeText.mockRejectedValue(new Error('not allowed'))
  const holder = show(renderMarkdown('```js\nconst a = 1\n```'))
  expect(() => holder.querySelector<HTMLElement>('a.copy-code').click()).not.toThrow()
  await vi.advanceTimersByTimeAsync(0)
  expect(console.error).toHaveBeenCalled()
})

test('code that cannot be decoded is not copied and the link keeps its label', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.api.base64.decode = () => { throw new Error('bad data') }
  const holder = show(renderMarkdown('```js\nconst a = 1\n```'))
  const link = holder.querySelector<HTMLElement>('a.copy-code')
  expect(() => link.click()).not.toThrow()
  expect(writeText).not.toHaveBeenCalled()
  expect(link.textContent).toBe('Copy code')
})

test('once removed, the handler copies nothing', () => {
  uninstall()
  const holder = show(renderMarkdown('```js\nconst a = 1\n```'))
  holder.querySelector<HTMLElement>('a.copy-code').click()
  expect(writeText).not.toHaveBeenCalled()
})
