import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { expect, test } from 'vitest'
import ButtonIcon from '@components/ButtonIcon.vue'
import { Trash2Icon } from 'lucide-vue-next'

test('ButtonIcon is non-submitting and exposes its accessible label', () => {
  const wrapper = mount(ButtonIcon, {
    props: { label: 'Delete message' },
    slots: { default: '<svg />' },
  })

  expect(wrapper.attributes('type')).toBe('button')
  expect(wrapper.attributes('aria-label')).toBe('Delete message')
})

test('ButtonIcon derives a label from its icon for existing callers', () => {
  const wrapper = mount(ButtonIcon, {
    slots: { default: () => h(Trash2Icon) },
  })

  expect(wrapper.attributes('aria-label')).toMatch(/Trash/)
})
