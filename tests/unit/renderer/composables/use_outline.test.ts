import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { expect, test, vi } from 'vitest'
import { useOutline } from '@composables/useOutline'

const editor = () => ({
  state: {
    doc: {
      descendants: vi.fn(),
    },
  },
  on: vi.fn(),
  off: vi.fn(),
  chain: vi.fn(),
})

test('useOutline detaches listeners when the editor changes and on unmount', async () => {
  const first = editor()
  const second = editor()
  const current = ref<any>(first)
  const wrapper = mount(defineComponent({
    setup() {
      useOutline(current)
      return {}
    },
    template: '<div />',
  }))

  expect(first.on).toHaveBeenCalledWith('update', expect.any(Function))
  current.value = second
  await wrapper.vm.$nextTick()
  expect(first.off).toHaveBeenCalledWith('update', expect.any(Function))
  expect(second.on).toHaveBeenCalledWith('update', expect.any(Function))

  wrapper.unmount()
  expect(second.off).toHaveBeenCalledWith('update', expect.any(Function))
})
