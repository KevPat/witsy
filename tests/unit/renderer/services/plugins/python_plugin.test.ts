import { vi, beforeEach, expect, test } from 'vitest'
import { useWindowMock } from '@tests/mocks/window'
import Python from '@services/plugins/python'
import { PluginExecutionContext } from 'multi-llm-ts'

const context: PluginExecutionContext = {
  model: 'mock',
}

const nativeConfig = {
  enabled: true,
  runtime: 'native',
  binpath: 'python3',
}

beforeEach(() => {
  vi.clearAllMocks()
  useWindowMock()
})

async function nativeScript(script: string): Promise<string> {
  const python = vi.fn(async () => ({ result: ['ok'] }))
  window.api.interpreter.python = python
  const plugin = new Python(nativeConfig, 'workspace1')
  await plugin.execute(context, { script })
  expect(python).toHaveBeenCalledTimes(1)
  return python.mock.calls[0][0]
}

test('native runtime prints a trailing expression and skips statements', async () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['\n', ''],
    ['\r\n', ''],
    ['1+1\n', 'print(1+1)'],
    ['x = 1', 'x = 1'],
    ['x = 1\n', 'x = 1'],
    ['foo.bar += 2', 'foo.bar += 2'],
    ['n := 1', 'n := 1'],
    ['(n := 1)', '(n := 1)'],
    ['# comment', '# comment'],
    ['  # comment', '  # comment'],
    ['1+1', 'print(1+1)'],
    ['1+1\r\n', 'print(1+1)'],
    ['print(1+1)', 'print(1+1)'],
    ['print(1+1)\n', 'print(1+1)'],
    ['x == 1', 'print(x == 1)'],
    ['x = 1\r\n1+1\r\n', 'x = 1\nprint(1+1)'],
  ]

  for (const [script, expected] of cases) {
    expect(await nativeScript(script)).toBe(expected)
  }
})

test('embedded runtime does not rewrite the script', async () => {
  const plugin = new Python({ enabled: true, runtime: 'embedded' }, 'workspace1')
  await plugin.execute(context, { script: '1+1\r\n' })
  expect(window.api.interpreter.pyodide).toHaveBeenCalledWith('1+1\r\n')
  expect(window.api.interpreter.python).not.toHaveBeenCalled()
})
