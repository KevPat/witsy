
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import enMessages from '@root/locales/en.json'
import { useWindowMock } from '@tests/mocks/window'
import { bug } from './bug'

// Dialogs are shown with SweetAlert2, which renders `title` and `html` as markup (only `text` is
// escaped). Some of those strings are built from names the user did not write: the name of a
// skill found in a downloaded SKILL.md, the error text sent back by an MCP server, the name of a
// file. These tests use the real dialog and the real SweetAlert2 (the global test setup replaces
// both) with the English messages, and look at what ends up in the document. The markers are
// inert: jsdom loads no image and no handler does more than set a flag.

vi.doUnmock('sweetalert2/dist/sweetalert2.js')
vi.doUnmock('@renderer/utils/dialog')

enableAutoUnmount(afterEach)

const kMarkup: [string, string][] = [
  ['an image with an error handler', '<img src=x onerror="window.pwned=1">'],
  ['an svg with a load handler', '<svg onload="window.pwned=1">'],
  ['an iframe', '<iframe srcdoc="<script>parent.pwned=1<\\x2fscript>">'],
  ['a link', '<a href="javascript:window.pwned=1">click here to continue'],
  ['a form with a button', '<form action="https://evil.example"><button>OK'],
  ['a style block', '<style>.swal2-cancel{display:none}</style>'],
  ['bold text', '<b>important'],
]

let SkillsList: any
let McpList: any
let DocRepoFiles: any
let store: any

const stubs = {
  ContextMenuTrigger: defineComponent({
    name: 'ContextMenuTrigger',
    setup(_, { slots }) {
      return () => h('div', { class: 'context-menu-trigger-stub' }, [slots.trigger?.(), slots.menu?.(), slots.default?.()])
    }
  }),
  ButtonIcon: defineComponent({
    name: 'ButtonIcon',
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { class: 'button-icon-stub', onClick: () => emit('click') }, slots.default?.())
    }
  }),
  SpinningIcon: defineComponent({
    name: 'SpinningIcon',
    setup() {
      return () => h('span', 'spinner')
    }
  }),
}

const popup = (): HTMLElement | null => document.querySelector<HTMLElement>('.swal2-popup')
const title = (): HTMLElement => document.querySelector<HTMLElement>('.swal2-title')
const body = (): HTMLElement => document.querySelector<HTMLElement>('.swal2-html-container')

// elements that are not part of the dialog itself: the caller only passed strings
const injected = (container: HTMLElement): string[] => {
  return Array.from(container.querySelectorAll('*')).filter((el) => el.tagName !== 'BR').map((el) => el.outerHTML)
}

const click = async (selector: string) => {
  document.querySelector<HTMLElement>(selector).click()
  await flushPromises()
}

const mountSkills = async (name: string): Promise<VueWrapper<any>> => {
  window.api.skills.defaultLocations = vi.fn(() => ['/witsy/skills'])
  window.api.skills.list = vi.fn(() => [{
    id: 'skill_1',
    name,
    description: 'Formats reports',
    rootPath: '/witsy/skills/report',
    skillMdPath: '/witsy/skills/report/SKILL.md',
  }]) as any
  window.api.skills.uninstall = vi.fn(() => ({ success: true })) as any
  const wrapper = mount(SkillsList, { attachTo: document.body, global: { stubs } })
  await wrapper.find('input[name="enabled"]').setValue(true)
  await flushPromises()
  return wrapper
}

const askToDeleteSkill = async (name: string): Promise<VueWrapper<any>> => {
  const wrapper = await mountSkills(name)
  const buttons = wrapper.findAll('.skill-actions .button-icon-stub')
  await buttons[buttons.length - 1].trigger('click')
  await flushPromises()
  expect(popup()).not.toBeNull()
  return wrapper
}

const showMcpLogs = async (lines: string[]): Promise<VueWrapper<any>> => {
  const server = { uuid: 'server-1', registryId: 'server-1', state: 'enabled', type: 'http', url: 'https://mcp.evil.example/mcp', toolSelection: null as any }
  const status = { servers: [{ ...server, tools: null as any }], logs: { 'server-1': lines } }
  const wrapper = mount(McpList, { attachTo: document.body, props: { servers: [server], status, loading: false }, global: { stubs } })
  await flushPromises()
  await wrapper.find('.server-content.clickable').trigger('click')
  await flushPromises()
  expect(popup()).not.toBeNull()
  return wrapper
}

const addDocument = async (file: string): Promise<VueWrapper<any>> => {
  window.api.file.pickFile = vi.fn(() => [file]) as any
  window.api.docrepo.isSourceSupported = vi.fn(() => false)
  const selectedRepo = { uuid: 'repo-1', name: 'Repo', embeddingEngine: 'openai', embeddingModel: 'model', workspaceId: 'workspace', documents: [] as any[] }
  const wrapper = mount(DocRepoFiles, { attachTo: document.body, props: { selectedRepo }, global: { stubs } })
  await flushPromises()
  await wrapper.find('button[name="addDocs"]').trigger('click')
  await flushPromises()
  expect(popup()).not.toBeNull()
  return wrapper
}

beforeAll(async () => {
  useWindowMock()
  window.api.config.getI18nMessages = vi.fn(() => ({ en: enMessages }))
  vi.resetModules()
  store = (await import('@services/store')).store
  store.loadSettings()
  store.load = () => {}
  store.config.workspaceId = 'workspace'
  SkillsList = (await import('@components/SkillsList.vue')).default
  McpList = (await import('@renderer/mcp/List.vue')).default
  DocRepoFiles = (await import('@renderer/docrepo/Files.vue')).default
})

beforeEach(() => {
  // SweetAlert2 finishes opening and closing a dialog in timers
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network access is not allowed in tests') }))
  store.config.plugins.skills.enabled = false
  store.config.skills.locations = []
})

afterEach(async () => {
  document.querySelector<HTMLElement>('.swal2-confirm')?.click()
  await flushPromises()
  vi.runAllTimers()
  vi.useRealTimers()
  document.querySelectorAll('.swal2-container').forEach((el) => el.remove())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect((window as any).pwned).toBeUndefined()
})

describe('dialogs: deleting a skill', () => {

  test('the dialog names the skill and deletes it only when confirmed', async () => {
    await askToDeleteSkill('report-writer')
    expect(title().textContent).toBe('Delete "report-writer"')
    expect(injected(title())).toEqual([])
    await click('.swal2-cancel')
    expect(window.api.skills.uninstall).not.toHaveBeenCalled()
    expect(popup()).toBeNull()
  })

  test('the skill is deleted when the user confirms', async () => {
    await askToDeleteSkill('report-writer')
    await click('.swal2-confirm')
    expect(window.api.skills.uninstall).toHaveBeenCalledWith('workspace', 'skill_1')
  })

  test.each(kMarkup)('%s in the name of a skill is shown as text in the list', async (_, markup) => {
    const wrapper = await mountSkills(`report ${markup}`)
    const cell = wrapper.find('td.skill-name > div')
    expect(cell.text()).toBe(`report ${markup}`)
    expect(cell.findAll('*').filter((el) => el.element.closest('svg') === null)).toEqual([])
  })

  test.each(kMarkup)('%s in the name of a skill is shown as text in the dialog', async (_, markup) => {
    // title: t('...confirmUninstallTitle', { skill: skill.name }) and SweetAlert2 renders title as html
    await askToDeleteSkill(`report ${markup}`)
    expect(injected(title())).toEqual([])
    expect(title().textContent).toBe(`Delete "report ${markup}"`)
  })

  test('a skill name cannot hide the cancel button of its own confirmation', async () => {
    // same sink: a <style> element in the title is live inside the dialog
    await askToDeleteSkill('report <style>.swal2-cancel{display:none}</style>')
    expect(popup().querySelector('style')).toBeNull()
  })

})

describe('dialogs: the logs of an mcp server', () => {

  test('plain log lines are shown one per line', async () => {
    await showMcpLogs(['Failed to connect to MCP server', 'Error: 401 Unauthorized'])
    expect(title().textContent).toBe('MCP Server Logs')
    expect(body().textContent).toBe('Failed to connect to MCP serverError: 401 Unauthorized')
    expect(body().querySelectorAll('br')).toHaveLength(1)
    expect(injected(body())).toEqual([])
  })

  test.each(kMarkup)('%s in an error returned by the server is shown as text', async (_, markup) => {
    // html: logs.join('<br>') and the log lines contain the error text of the server
    await showMcpLogs(['Failed to connect to MCP server', `Error: ${markup}`])
    expect(injected(body())).toEqual([])
    expect(body().textContent).toContain(markup)
  })

})

describe('dialogs: a document that cannot be added', () => {

  test('the name of the file is shown without its folder', async () => {
    await addDocument('/home/user/Downloads/archive.xyz')
    expect(title().textContent).toBe('File format not supported')
    expect(body().textContent).toBe('archive.xyz')
    expect(injected(body())).toEqual([])
  })

  bug.each(kMarkup.filter(([, markup]) => !markup.includes('/')))('%s in the name of a file is shown as text', async (_, markup) => {
    // html: fileNames.join('<br/>') with the names of the files the user picked
    await addDocument(`/home/user/Downloads/${markup}.xyz`)
    expect(injected(body())).toEqual([])
    expect(body().textContent).toBe(`${markup}.xyz`)
  })

})
