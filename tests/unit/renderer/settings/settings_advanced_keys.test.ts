import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import Settings from '@screens/Settings.vue'
import { store } from '@services/store'
import { useWindowMock } from '@tests/mocks/window'
import { switchToTab, tabs } from '../screens/settings_utils'

enableAutoUnmount(afterAll)

vi.mock('@services/store.ts', async (importOriginal) => {
  const mod: any = await importOriginal()
  return {
    store: {
      ...mod.store,
      saveSettings: vi.fn()
    }
  }
})

beforeEach(() => {
  useWindowMock()
  store.loadSettings()
  store.load = () => {}
})

test('no key storage warning when the key store is healthy', async () => {
  const wrapper = mount(Settings)
  const tab = await switchToTab(wrapper, tabs.indexOf('settingsAdvanced'))
  expect(tab.find('.safe-keys-weak').exists()).toBe(false)
  expect(tab.find('.safe-keys-undecryptable').exists()).toBe(false)
})

test('a weak key store (Linux basic_text) is reported while safe storage is on (L-10)', async () => {
  vi.mocked(window.api.config.keyStorageStatus).mockReturnValue({ encryptionAvailable: true, weak: true, undecryptable: [], notStored: [] })
  const wrapper = mount(Settings)
  const tab = await switchToTab(wrapper, tabs.indexOf('settingsAdvanced'))
  expect(tab.find('.safe-keys-weak').exists()).toBe(true)
  expect(tab.find('.safe-keys-weak').text()).toBe('settings.advanced.safeKeysWeak')

  // the warning is about the key store: it goes away when keys are not stored there
  await tab.find('.form-field.safe-keys input').setValue(false)
  expect(tab.find('.safe-keys-weak').exists()).toBe(false)
})

test('keys that could not be decrypted are reported (D-01)', async () => {
  vi.mocked(window.api.config.keyStorageStatus).mockReturnValue({ encryptionAvailable: true, weak: false, undecryptable: ['engines.anthropic.apiKey', 'engines.openai.apiKey'], notStored: [] })
  const wrapper = mount(Settings)
  const tab = await switchToTab(wrapper, tabs.indexOf('settingsAdvanced'))
  expect(tab.find('.safe-keys-undecryptable').exists()).toBe(true)
  expect(tab.find('.safe-keys-weak').exists()).toBe(false)
})
