import { mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import ButtonIcon from '@components/ButtonIcon.vue'

test('ButtonIcon is non-submitting and exposes its explicit accessible label', async () => {
  const onSubmit = vi.fn()
  const wrapper = mount(ButtonIcon, {
    props: { label: 'Delete message' },
    slots: { default: '<svg />' },
  })
  const form = document.createElement('form')
  form.addEventListener('submit', onSubmit)
  document.body.appendChild(form)
  form.appendChild(wrapper.element)

  expect(wrapper.attributes('type')).toBe('button')
  expect(wrapper.attributes('aria-label')).toBe('Delete message')
  await wrapper.trigger('click')
  expect(onSubmit).not.toHaveBeenCalled()

  wrapper.unmount()
  form.remove()
})

test('ButtonIcon does not infer a label from slotted icon names', () => {
  const warnings: string[] = []
  const wrapper = mount(ButtonIcon, {
    // @ts-expect-error label is deliberately omitted to verify runtime behavior
    props: {},
    slots: { default: '<svg name="trash-2" />' },
    global: {
      config: {
        warnHandler: (message) => warnings.push(message),
      },
    },
  })

  expect(warnings).toContain('Missing required prop: "label"')
  expect(wrapper.attributes('aria-label')).toBeUndefined()
})
