import { vi, beforeAll, afterAll, expect, test } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { useWindowMock } from '@tests/mocks/window'
import { createI18nMock } from '@tests/mocks'
import TiptapEditor from '@components/editor/TiptapEditor.vue'

vi.mock('@services/i18n', () => createI18nMock())
vi.mock('@renderer/utils/dialog', () => ({ default: { alert: vi.fn(() => Promise.resolve()) } }))
vi.mock('@services/docx', () => ({ exportToDocx: vi.fn().mockResolvedValue(new Blob()), saveDocxBlob: vi.fn() }))
vi.mock('@services/pptx', () => ({ exportToPptx: vi.fn().mockResolvedValue(new Blob()), savePptxBlob: vi.fn() }))

enableAutoUnmount(afterAll)

beforeAll(() => {
  useWindowMock()
})

// what the editor shows must be the new markdown once it changed outside the editor
// (the same document as an editor opened on the new markdown)
const mountEditor = async (markdown: string) => {
  const wrapper = mount(TiptapEditor, { props: { modelValue: markdown, filePath: '/project/test.md', readOnly: false, isMarpFile: false } })
  await vi.waitUntil(() => wrapper.vm.editor != null, { timeout: 2000 })
  return wrapper
}

const expectShows = async (before: string, after: string) => {
  const wrapper = await mountEditor(before)
  await wrapper.setProps({ modelValue: after })
  await nextTick()
  const reference = await mountEditor(after)
  // the trailing empty paragraph StarterKit adds after a transaction is not content
  const content = (doc: any) => {
    const json = doc.toJSON()
    while (json.content?.length && json.content.at(-1).type === 'paragraph' && !json.content.at(-1).content) json.content.pop()
    return json
  }
  expect(content(wrapper.vm.editor.state.doc)).toEqual(content(reference.vm.editor.state.doc))
}

test('a small change outside the editor is applied', async () => {
  await expectShows('Hello world\n\nSecond paragraph', 'Hello brave world\n\nSecond paragraph')
})

// found by the rfc6902 differential (npm run verify:rfc6902): recreateTransform can return steps that
// apply but end on another document, with rfc6902 3 and 5 alike; the editor then showed that document
test('a whole new document from outside the editor is shown as it is', async () => {
  const before = [
    '---',
    '1. fox delta ipsum\n2. ipsum brown\n3. brown',
    '> été naïve delta beta été gamma lorem brown',
    '```js\nconst witsy = 59\n```',
    '1. quick été delta\n2. naïve beta\n3. fox',
    '| beta | x |\n| --- | --- |\n| agent ipsum | été |\n| été | brown note |',
    'beta beta fox **alpha alpha** alpha beta *ipsum* `naïve` 日本 naïve beta',
    '## note gamma',
  ].join('\n\n')
  const after = [
    '> gamma delta fox beta alpha été alpha alpha',
    '> delta lorem alpha delta beta beta delta note',
    '## witsy agent',
  ].join('\n\n')
  await expectShows(before, after)
})
