
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { useWindowMock } from '@tests/mocks/window'
import { createI18nMock } from '@tests/mocks'
import MessageItemBodyBlock from '@components/MessageItemBodyBlock.vue'

vi.mock('@services/i18n', async () => {
  return createI18nMock()
})

enableAutoUnmount(afterEach)

beforeAll(() => {
  useWindowMock()
})

const mountBlock = async (content: string) => {
  const wrapper = mount(MessageItemBodyBlock, {
    props: { block: { type: 'text', content, start: 0, end: content.length, stable: true }, transient: false },
  })
  await nextTick()
  return wrapper
}

test('The text of an error is kept for the error icon', async () => {
  const wrapper = await mountBlock('Sorry, it failed. <error>401 "invalid" key & more</error>')
  const placeholders = wrapper.findAll('.error-icon-placeholder')
  expect(placeholders).toHaveLength(1)
  expect(placeholders[0].attributes('data-error')).toBe('401 "invalid" key & more')
  expect(wrapper.text()).not.toContain('401')
})

test.each([
  ['a link', '<error>[x](https://a/onmouseover=alert(1)//)</error>'],
  ['a link with a title', '<error>[x](https://a/ "t onmouseover=alert(1) x")</error>'],
  ['an autolink', '<error><https://a/"onmouseover="alert(1)></error>'],
  ['an image', '<error>![x](https://a/b.png "onerror=alert(1)")</error>'],
])('%s in an error adds no attribute to the page', async (_, content) => {
  const wrapper = await mountBlock(`Sorry. ${content}`)
  const elements = [wrapper.element, ...Array.from(wrapper.element.querySelectorAll('*'))]
  const handlers = elements.flatMap((element) => element.getAttributeNames().filter((name) => name.startsWith('on')))
  expect(handlers).toEqual([])
  for (const placeholder of wrapper.findAll('.error-icon-placeholder')) {
    expect(placeholder.element.getAttributeNames().sort()).toEqual(['class', 'data-error'])
    expect(placeholder.element.children).toHaveLength(0)
  }
})
