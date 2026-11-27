import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { enableAutoUnmount, mount, VueWrapper } from '@vue/test-utils'
import { useWindowMock } from '@tests/mocks/window'
import { store, kMediaChatId } from '@services/store'
import { kHistoryVersion } from '@/consts'
import { Configuration } from '@/types/config'
import ImageCreator from '@services/image'
import { FALLBACK_VENICE_VIDEO_MODELS } from '@services/venice'
import { VENICE_API_BASE } from '@services/venice_video'
import DesignStudio from '@screens/DesignStudio.vue'
import defaultSettings from '@root/defaults/settings.json'
import Chat from '@models/chat'
import Message from '@models/message'
import Dialog from '@renderer/utils/dialog'

// Pressure tests for the Design Studio cancel flow. Venice and the main process
// are faked in memory: nothing here reaches a network or the disk.
//
// Tests declared with test.fails describe a bug that exists today: they assert
// the behaviour the app should have and are reported as passing while the bug
// is present. Drop the .fails once the bug is fixed.

enableAutoUnmount(afterEach)

vi.mock('@services/image', async (importOriginal) => {
  const mod: any = await importOriginal()
  mod.default.prototype.execute = vi.fn()
  return mod
})

const API_KEY = 'sk-fake-studio-cancel-key'
const TEXT_MODEL = FALLBACK_VENICE_VIDEO_MODELS[0].id

type Gate = { promise: Promise<void>, open: () => void }

function gate(): Gate {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

function mp4(stamp: number): Uint8Array {
  const bytes = new Uint8Array(4096)
  for (let i = 0; i < bytes.byteLength; i++) bytes[i] = (i * 31 + stamp) & 0xff
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0)
  return bytes
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The main process side of the media IPC calls.
function fakeMain() {
  const open = new Set<string>()
  const published: string[] = []
  const state = { opened: 0, appends: 0, aborted: 0, holdFinish: null as Gate | null, finishing: 0 }
  window.api.file.mediaOpen = vi.fn(async () => {
    const id = `session-${++state.opened}`
    open.add(id)
    return id
  })
  window.api.file.mediaAppend = vi.fn(async (id: string) => {
    if (!open.has(id)) throw new Error('Media session not found')
    state.appends += 1
  })
  window.api.file.mediaFinish = vi.fn(async (id: string) => {
    if (!open.has(id)) throw new Error('Media session not found')
    open.delete(id)
    state.finishing += 1
    if (state.holdFinish) await state.holdFinish.promise
    const url = `file:///videos/${id}.mp4`
    published.push(url)
    return url
  })
  window.api.file.mediaAbort = vi.fn(async (id: string) => {
    if (open.delete(id)) state.aborted += 1
  })
  window.api.file.delete = vi.fn(() => true)
  return { open, published, state }
}

// A Venice that sends half of each video, then waits for the test to let the rest through.
function fakeVenice() {
  const jobs: { release: Gate, halfSent: boolean, aborted: boolean }[] = []
  const counts = { queue: 0, retrieve: 0, complete: 0, other: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (!url.startsWith(`${VENICE_API_BASE}/video/`) || (init.headers as Record<string, string>).Authorization !== `Bearer ${API_KEY}`) {
      counts.other += 1
      throw new Error('unexpected request')
    }
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (url.endsWith('/video/queue')) {
      counts.queue += 1
      jobs.push({ release: gate(), halfSent: false, aborted: false })
      return json({ model: TEXT_MODEL, queue_id: `queue-id-${jobs.length - 1}` })
    }
    const index = Number(String(JSON.parse(String(init.body)).queue_id).slice('queue-id-'.length))
    if (url.endsWith('/video/complete')) {
      counts.complete += 1
      return json({ success: true })
    }
    counts.retrieve += 1
    const job = jobs[index]
    const payload = mp4(index)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // A real fetch body fails as soon as its request is aborted.
        init.signal?.addEventListener('abort', () => {
          job.aborted = true
          controller.error(new DOMException('Aborted', 'AbortError'))
        })
      },
      async pull(controller) {
        if (!job.halfSent) {
          job.halfSent = true
          controller.enqueue(payload.slice(0, 2048))
          return
        }
        await job.release.promise
        if (job.aborted) return
        controller.enqueue(payload.slice(2048))
        controller.close()
      },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } })
  }))
  return { jobs, counts }
}

async function mountStudio(mediaType: 'video' | 'image' = 'video') {
  const wrapper: VueWrapper<any> = mount(DesignStudio)
  const settings = wrapper.findComponent({ name: 'Settings' })
  await settings.find<HTMLSelectElement>('[name=type]').setValue(mediaType)
  await settings.find<HTMLSelectElement>('[name=engine]').setValue(mediaType === 'video' ? 'venice' : 'openai')
  await settings.find<HTMLTextAreaElement>('[name=prompt]').setValue('a gondola at dusk')
  const generate = () => settings.find<HTMLButtonElement>('[name=generate]')
  const cancel = () => settings.find<HTMLButtonElement>('[name=cancel]')
  return { wrapper, settings, generate, cancel }
}

beforeAll(() => {
  useWindowMock({ dialogResponse: 1, modelDefaults: true })

  window.api.config.load = () => {
    const settings = JSON.parse(JSON.stringify(defaultSettings)) as Configuration
    settings.studio.type = 'video'
    settings.studio.engines.video = 'venice'
    settings.engines.venice = {
      apiKey: API_KEY,
      models: {
        chat: [],
        video: [FALLBACK_VENICE_VIDEO_MODELS[0]],
        videoEdit: [FALLBACK_VENICE_VIDEO_MODELS[1]],
      },
      model: { chat: '', video: TEXT_MODEL },
    } as unknown as Configuration['engines'][string]
    settings.engines.openai = {
      apiKey: 'openai',
      models: { chat: [], image: [{ id: 'gpt-image-1', name: 'gpt-image-1' }] },
      model: { chat: '', image: 'gpt-image-1' },
    } as unknown as Configuration['engines'][string]
    return settings
  }

  window.api.history.load = vi.fn(() => ({
    version: kHistoryVersion,
    folders: [],
    chats: [
      Chat.fromJson({ uuid: kMediaChatId, messages: [new Message('system', 'This is a system message.')] }),
    ],
    quickPrompts: [],
  }))
})

beforeEach(() => {
  store.loadSettings()
  store.loadHistory()
  vi.spyOn(Dialog, 'show')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(ImageCreator.prototype.execute).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('the cancel button only exists while a generation is running', async () => {
  const main = fakeMain()
  const venice = fakeVenice()
  const { wrapper, generate, cancel } = await mountStudio()
  expect(cancel().exists()).toBe(false)

  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends > 0)
  expect(cancel().exists()).toBe(true)
  expect(generate().element.disabled).toBe(true)

  venice.jobs[0].release.open()
  await vi.waitUntil(() => wrapper.vm.selection.length === 1)
  await wrapper.vm.$nextTick()

  expect(cancel().exists()).toBe(false)
  expect(generate().element.disabled).toBe(false)
  expect(wrapper.vm.selection[0].attachments[0].url).toBe('file:///videos/session-1.mp4')
  expect(Dialog.show).not.toHaveBeenCalled()
})

test('cancelling a Venice download stops it, drops the partial file, and shows nothing', async () => {
  const main = fakeMain()
  const venice = fakeVenice()
  const { wrapper, generate, cancel } = await mountStudio()

  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends > 0)
  await cancel().trigger('click')

  expect(cancel().exists()).toBe(false)
  expect(generate().element.disabled).toBe(false)
  await vi.waitUntil(() => main.state.aborted === 1)
  venice.jobs[0].release.open()
  await wrapper.vm.$nextTick()

  expect(venice.jobs[0].aborted).toBe(true)
  expect(main.open.size).toBe(0)
  expect(main.published).toEqual([])
  expect(window.api.file.mediaFinish).not.toHaveBeenCalled()
  expect(venice.counts.complete).toBe(0)
  expect(wrapper.vm.selection).toHaveLength(0)
  expect(wrapper.vm.chat.messages.filter((message: Message) => message.role === 'user')).toHaveLength(0)
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(API_KEY)
})

test('ten generate and cancel cycles in a row leave one result: the last one', async () => {
  const main = fakeMain()
  const venice = fakeVenice()
  const { wrapper, generate, cancel } = await mountStudio()

  for (let cycle = 1; cycle <= 10; cycle++) {
    await generate().trigger('click')
    await vi.waitUntil(() => main.state.appends === cycle)
    await cancel().trigger('click')
    expect(generate().element.disabled).toBe(false)
  }
  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends === 11)
  // Old jobs are let go only now: none of them may come back to life.
  for (const job of venice.jobs) job.release.open()
  await vi.waitUntil(() => wrapper.vm.selection.length === 1)
  await wrapper.vm.$nextTick()

  expect(venice.counts).toEqual({ queue: 11, retrieve: 11, complete: 1, other: 0 })
  expect(venice.jobs.slice(0, 10).every((job) => job.aborted)).toBe(true)
  expect(main.state.aborted).toBe(10)
  expect(main.open.size).toBe(0)
  expect(main.published).toEqual(['file:///videos/session-11.mp4'])
  const messages = wrapper.vm.chat.messages.filter((message: Message) => message.role === 'user')
  expect(messages).toHaveLength(1)
  expect(messages[0].attachments[0].url).toBe('file:///videos/session-11.mp4')
  expect(cancel().exists()).toBe(false)
  expect(generate().element.disabled).toBe(false)
  expect(Dialog.show).not.toHaveBeenCalled()
})

test('a cancelled job that fails afterwards does not raise an error dialog over the next one', async () => {
  const main = fakeMain()
  const venice = fakeVenice()
  const { wrapper, generate, cancel } = await mountStudio()

  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends === 1)
  // The abort call to the main process fails, and so does everything after it for this job.
  window.api.file.mediaAbort = vi.fn(async () => { throw new Error('Media session not found') })
  await cancel().trigger('click')
  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends === 2)
  for (const job of venice.jobs) job.release.open()
  await vi.waitUntil(() => wrapper.vm.selection.length === 1)
  await wrapper.vm.$nextTick()

  expect(wrapper.vm.selection[0].attachments[0].url).toBe('file:///videos/session-2.mp4')
  expect(Dialog.show).not.toHaveBeenCalled()
  expect(generate().element.disabled).toBe(false)
})

test('leaving the studio during a download cancels it', async () => {
  const main = fakeMain()
  const venice = fakeVenice()
  const { wrapper, generate } = await mountStudio()

  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends > 0)
  wrapper.unmount()
  await vi.waitUntil(() => main.state.aborted === 1)

  expect(venice.jobs[0].aborted).toBe(true)
  expect(main.published).toEqual([])
  expect(Dialog.show).not.toHaveBeenCalled()
})

test.fails('BUG: a cancel that lands while the file is being published does not leave an unlisted file on disk', async () => {
  const main = fakeMain()
  const venice = fakeVenice()
  main.state.holdFinish = gate()
  const { wrapper, generate, cancel } = await mountStudio()

  await generate().trigger('click')
  await vi.waitUntil(() => main.state.appends > 0)
  venice.jobs[0].release.open()
  await vi.waitUntil(() => main.state.finishing === 1)
  await cancel().trigger('click')
  main.state.holdFinish.open()
  await vi.waitUntil(() => main.published.length === 1)

  // The studio shows nothing for this job, so the saved file must be removed as well.
  await vi.waitFor(() => expect(window.api.file.delete).toHaveBeenCalledWith('file:///videos/session-1.mp4'), { timeout: 250 })
  expect(wrapper.vm.chat.messages.filter((message: Message) => message.role === 'user')).toHaveLength(0)
})

test.fails('BUG: cancelling an engine that cannot be stopped does not leave its result as an unlisted file', async () => {
  fakeMain()
  const finished = gate()
  let started = false
  vi.mocked(ImageCreator.prototype.execute).mockImplementation(async () => {
    started = true
    await finished.promise
    return { url: 'file:///images/late.png' }
  })
  const { wrapper, generate, cancel } = await mountStudio('image')

  await generate().trigger('click')
  await vi.waitUntil(() => started)
  expect(cancel().exists()).toBe(true)
  await cancel().trigger('click')
  finished.open()

  await vi.waitFor(() => expect(window.api.file.delete).toHaveBeenCalledWith('file:///images/late.png'), { timeout: 250 })
  expect(wrapper.vm.chat.messages.filter((message: Message) => message.role === 'user')).toHaveLength(0)
})
