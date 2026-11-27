import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { useWindowMock } from '@tests/mocks/window'
import Generator from '@services/generator'
import { store } from '@services/store'
import Message from '@models/message'
import FilesystemPlugin from '@services/plugins/filesystem'
import PythonPlugin from '@services/plugins/python'
import CodeExecutionProgramPlugin from '@services/plugins/code_exec_program'
import { kCodeExecutionPluginPrefix } from '@services/plugins/code_exec_base'
import { computeBlocks } from '@services/message_block_parser'
import { extractPromptInputs, replacePromptInputs } from '@services/prompt'
import { getExportFilename, pathBasename, pathDirname, stripLeadingSeparator } from '@renderer/utils/path_utils'
import { PluginExecutionContext } from 'multi-llm-ts'

const context: PluginExecutionContext = { model: 'mock' }

let llmMock: any

beforeAll(() => {
  useWindowMock()
})

beforeEach(() => {
  vi.clearAllMocks()
  store.loadSettings()
  store.config.engines.mock = {
    models: {
      chat: [
        { id: 'chat', name: 'Chat Model', capabilities: { tools: true, vision: false, reasoning: false, caching: true } }
      ]
    },
    model: { chat: 'chat' }
  } as any
  llmMock = {
    getId: vi.fn(() => 'mock'),
    getName: vi.fn(() => 'Mock'),
    plugins: [],
    complete: vi.fn(async () => ({ content: 'ok', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })),
    generate: vi.fn(async function* () {
      yield { type: 'content', text: 'ok', done: true }
    }),
    stop: vi.fn(),
    clearPlugins: vi.fn(),
    addPlugin: vi.fn(),
  }
})

const filesystem = (allowedPaths: string[]) => new FilesystemPlugin({
  enabled: true,
  allowedPaths,
  allowWrite: false,
  skipConfirmation: true,
} as any, 'workspace1')

describe('filesystem path boundary stress', () => {

  test('rejects parent traversal and empty allow lists', () => {
    const plugin = filesystem(['/tmp/allowed'])
    expect(plugin.mapToAllowedPaths('/tmp/allowed/../etc/passwd')).toBeNull()
    expect(plugin.mapToAllowedPaths('/tmp/allowed/../../etc/passwd')).toBeNull()
    expect(plugin.mapToAllowedPaths('')).toBeNull()
    expect(filesystem([]).mapToAllowedPaths('/tmp/allowed/file')).toBeNull()
  })

  test('accepts a path that stays inside the allowed root', () => {
    const plugin = filesystem(['/tmp/allowed'])
    expect(plugin.mapToAllowedPaths('/tmp/allowed/notes.txt')).toBe('/tmp/allowed/notes.txt')
    expect(plugin.mapToAllowedPaths('/tmp/allowed/./nested/../notes.txt')).toBe('/tmp/allowed/notes.txt')
  })

  test('does not throw on a burst of odd paths', () => {
    const plugin = filesystem(['/tmp/allowed', '~/Documents'])
    const samples = [
      '.', '..', '/', '\\', 'C:\\Windows\\System32', 'C:/Windows/System32',
      '/tmp/allowed', '/tmp/allowed/', 'allowed/../allowed/a',
      '~', '~/Documents/a b/c', './Documents/a', 'Documents\\a',
      '\0', ' ', 'con', 'NUL', 'a'.repeat(4000),
      '/tmp/allowed/\u0000hidden', '/tmp/allowed/./././x',
    ]
    for (let i = 0; i < 50; i++) {
      samples.push(`/tmp/allowed/file-${i}.txt`)
      samples.push(`../${'../'.repeat(i % 5)}etc/passwd`)
      samples.push(`C:\\Users\\me\\docs-${i}\\file`)
    }
    for (const sample of samples) {
      expect(() => plugin.mapToAllowedPaths(sample)).not.toThrow()
    }
  })

})

describe('python plugin input stress', () => {

  test('native and embedded runtimes accept empty, CRLF, and large scripts', async () => {
    const embedded = new PythonPlugin({ enabled: true, runtime: 'embedded' } as any, 'workspace1')
    const native = new PythonPlugin({ enabled: true, runtime: 'native', binpath: '/usr/bin/python3' } as any, 'workspace1')
    const scripts = [
      '',
      '1+1',
      '1+1\n',
      '1+1\r\n',
      'x = 1\r\n',
      'print(1)\r\n',
      '# comment\n',
      'value = "line1\\nline2"\n',
      'a'.repeat(20000),
      'print("""multi\r\nline""")\r\n',
    ]
    for (const script of scripts) {
      const embeddedResult = await embedded.execute(context, { script })
      const nativeResult = await native.execute(context, { script })
      expect(embeddedResult).toEqual({ result: 'bonjour' })
      expect(nativeResult).toEqual({ result: 'bonjour' })
    }
    expect(window.api.interpreter.pyodide).toHaveBeenCalled()
    expect(window.api.interpreter.python).toHaveBeenCalled()
  })

  test('does not wrap a last line that already prints', async () => {
    const native = new PythonPlugin({ enabled: true, runtime: 'native', binpath: '/usr/bin/python3' } as any, 'workspace1')
    await native.execute(context, { script: 'print(42)' })
    expect(window.api.interpreter.python).toHaveBeenCalledWith('print(42)')
  })

})

describe('code execution program stress', () => {

  const plugin = () => new CodeExecutionProgramPlugin()

  test('rejects a program without steps and an unknown tool', async () => {
    const code = plugin()
    const missing = await code.execute(context, { tool: 'nope', parameters: {} })
    expect(missing).toEqual({ error: 'Tool "nope" not found' })
    const bad = await code.execute(context, {
      tool: `${kCodeExecutionPluginPrefix}run_program`,
      parameters: { program: { steps: 'nope' } },
    })
    expect(bad.error).toMatch(/steps/)
  })

  test('stops before the first step when already aborted', async () => {
    const code = plugin()
    const aborted: PluginExecutionContext = { model: 'mock', abortSignal: AbortSignal.abort() }
    const result = await code.execute(aborted, {
      tool: `${kCodeExecutionPluginPrefix}run_program`,
      parameters: {
        program: { steps: [{ id: 's1', tool: 'missing_tool', args: { q: '{{s0.result}}' } }] },
      },
    })
    expect(result).toEqual({ error: 'Workflow cancelled' })
  })

  test('reports a missing variable instead of throwing', async () => {
    const code = plugin()
    const result = await code.execute(context, {
      tool: `${kCodeExecutionPluginPrefix}run_program`,
      parameters: {
        program: { steps: [{ id: 's1', tool: 'missing_tool', args: { q: '{{never.ran}}' } }] },
      },
    })
    expect(result.error).toBeTruthy()
    expect(result.failedStep).toBe('s1')
  })

  test('get_tools_info survives a large and empty name list', async () => {
    const code = plugin()
    const names = Array.from({ length: 40 }, (_, i) => `tool_${i}`)
    const empty = await code.execute(context, {
      tool: `${kCodeExecutionPluginPrefix}get_tools_info`,
      parameters: { tools_names: [] },
    })
    const many = await code.execute(context, {
      tool: `${kCodeExecutionPluginPrefix}get_tools_info`,
      parameters: { tools_names: names },
    })
    expect(empty.tools_info).toEqual([])
    expect(many.tools_info).toHaveLength(40)
    expect(many.tools_info[0].error).toMatch(/not found/)
  })

})

describe('prompt substitution stress', () => {

  test('replaces safe tokens and leaves unknown tokens', () => {
    const prompt = '{{name}} {{city:where}} {{count::0}} {{output.1}}'
    const replaced = replacePromptInputs(prompt, {
      name: 'Ada',
      city: 'Paris',
      count: '3',
      'output.1': 'previous',
    })
    expect(replaced).toBe('Ada Paris 3 previous')
    expect(replacePromptInputs('keep {{missing}}', {})).toBe('keep {{missing}}')
    expect(replacePromptInputs('', { name: 'x' })).toBe('')
  })

  test('extracts a large unique set of inputs once each', () => {
    const parts = Array.from({ length: 80 }, (_, i) => `{{field${i}:desc ${i}:default ${i}}}`)
    const inputs = extractPromptInputs(parts.join(' '))
    expect(inputs).toHaveLength(80)
    expect(inputs[79].name).toBe('field79')
    expect(inputs[79].defaultValue).toBe('default 79')
    const again = extractPromptInputs(parts.concat(parts).join(' '))
    expect(again).toHaveLength(80)
  })

})

describe('generator option sanitizing', () => {

  const run = (opts: Record<string, unknown>) => {
    const messages = [
      new Message('system', 'sys'),
      new Message('user', 'hello'),
      new Message('assistant', ''),
    ]
    const generator = new Generator(store.config)
    return generator.generate(llmMock, messages, { model: 'chat', streaming: false, ...opts } as any)
  }

  test('coerces numeric strings and drops garbage', async () => {
    const rc = await run({
      maxTokens: '128',
      temperature: '0.25',
      top_p: '0.9',
      top_k: '40',
      timeout: '1500',
      contextWindowSize: '8192',
    })
    expect(rc).toBe('success')
    const opts = llmMock.complete.mock.calls[0][2]
    expect(opts.maxTokens).toBe(128)
    expect(opts.temperature).toBeCloseTo(0.25)
    expect(opts.top_k).toBe(40)
    expect(opts.timeout).toBe(1500)
  })

  test('survives a burst of malformed option bags', async () => {
    const bags = [
      { maxTokens: '' },
      { temperature: 'nope' },
      { top_k: null },
      { timeout: undefined },
      { maxTokens: '12.9', temperature: '1e-1' },
      { top_p: '  ' },
      { reasoningBudget: '-3' },
      { thinkingBudget: '2.2' },
    ]
    for (const bag of bags) {
      llmMock.complete.mockClear()
      const rc = await run(bag)
      expect(rc).toBe('success')
    }
  })

})

describe('message block parser streaming edges', () => {

  const opts = {
    role: 'assistant' as const,
    transient: true,
    toolCalls: [],
    toolCallsDisplay: 'summary' as const,
  }

  test('does not throw on truncated markup and empty input', () => {
    const samples = [
      null,
      '',
      '   \n\n',
      'hello',
      '<artifact title="draft">partial',
      '<artifact title="draft">done</artifact>',
      '```js\nconst x = 1\n',
      '| a | b |\n| --- |',
      'see <tool id="1"></tool> now',
      'a'.repeat(8000),
    ]
    for (const sample of samples) {
      expect(() => computeBlocks(sample, opts)).not.toThrow()
      expect(() => computeBlocks(sample, { ...opts, transient: false, role: 'user' })).not.toThrow()
    }
  })

})

describe('path helpers across separators', () => {

  test('basename, dirname, and export names accept both separators', () => {
    expect(pathBasename('/users/foo/project')).toBe('project')
    expect(pathBasename('C:\\Users\\foo\\project')).toBe('project')
    expect(pathBasename('file.txt')).toBe('file.txt')
    expect(pathDirname('/users/foo/project')).toBe('/users/foo')
    expect(pathDirname('C:\\Users\\foo\\project')).toBe('C:\\Users\\foo')
    expect(pathDirname('file.txt')).toBe('')
    expect(stripLeadingSeparator('/foo/bar')).toBe('foo/bar')
    expect(stripLeadingSeparator('\\foo\\bar')).toBe('foo\\bar')
    expect(getExportFilename('C:\\docs\\My Report.md', 'default')).toBe('My Report')
    expect(getExportFilename(undefined, 'default')).toBe('default')
    expect(getExportFilename('/tmp/archive.tar.gz', 'default')).toBe('archive.tar')
  })

})
