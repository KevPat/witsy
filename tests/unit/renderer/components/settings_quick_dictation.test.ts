
import { vi, beforeAll, beforeEach, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { useWindowMock } from '@tests/mocks/window'
import { store } from '@services/store'
import SettingsQuickDictation from '@renderer/settings/SettingsQuickDictation.vue'

beforeAll(() => {
  useWindowMock()
  store.loadSettings()
})

beforeEach(() => {
  vi.clearAllMocks()
})

test('no warning where key-less shortcuts are supported', async () => {
  vi.mocked(window.api.shortcuts.areNativeShortcutsSupported).mockReturnValue(true)
  const wrapper = mount(SettingsQuickDictation)
  expect(wrapper.find('.native-unsupported').exists()).toBe(false)
  expect(wrapper.find('select[name=activation]').exists()).toBe(true)
})

test('tells the user when key-less shortcuts are not supported on the platform', async () => {
  vi.mocked(window.api.shortcuts.areNativeShortcutsSupported).mockReturnValue(false)
  const wrapper = mount(SettingsQuickDictation)
  expect(wrapper.find('.native-unsupported').exists()).toBe(true)
  expect(wrapper.find('.native-unsupported').text()).toBe('settings.voice.quickDictation.nativeShortcutsUnsupported')
  expect(wrapper.find('select[name=activation]').exists()).toBe(false)
})
