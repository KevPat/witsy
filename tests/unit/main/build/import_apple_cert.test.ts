
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// build/import_apple_cert.sh only runs on the macOS release runner. Here it is checked statically,
// then executed with stand-ins for `security` and `base64` found first on the PATH.

const script = path.join(__dirname, '../../../../build/import_apple_cert.sh')
const source = fs.readFileSync(script, 'utf-8')
const lines = source.split('\n')

describe('import_apple_cert.sh (static)', () => {

  test('cleanup does not use literal file names', () => {
    expect(source).not.toMatch(/\brm\b[^\n]*\s(CERTIFICATE_PATH|PROFILE_PATH|KEYCHAIN_PATH)\b/)
  })

  test('the decoded certificate is removed by an EXIT trap set before it is written', () => {
    const cleanup = source.match(/^cleanup\(\) \{\n([\s\S]*?)\n\}$/m)
    expect(cleanup?.[1]).toContain('rm -f "$CERTIFICATE_PATH"')
    const trap = lines.findIndex(line => /^trap cleanup EXIT$/.test(line))
    const decode = lines.findIndex(line => line.includes('base64 --decode'))
    expect(trap).toBeGreaterThan(-1)
    expect(decode).toBeGreaterThan(trap)
  })

  test('every variable expansion is quoted', () => {
    const unquoted = lines
      .filter(line => !line.trim().startsWith('#'))
      .filter(line => line.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '').includes('$'))
    expect(unquoted).toEqual([])
  })

  test('the keychain commands are unchanged', () => {
    const commands = lines.filter(line => line.startsWith('security ')).map(line => line.split(' ').slice(0, 2).join(' '))
    expect(commands).toEqual([
      'security find-identity',
      'security create-keychain',
      'security set-keychain-settings',
      'security unlock-keychain',
      'security import',
      'security set-key-partition-list',
      'security list-keychain',
      'security find-identity',
    ])
  })

})

const shells = ['sh', 'bash'].filter(shell => process.platform !== 'win32' && spawnSync(shell, ['-c', 'exit 0']).status === 0)

describe.each(shells)('import_apple_cert.sh run by %s with stand-in tools', (shell) => {

  let root: string
  let runnerTemp: string
  let log: string

  // one line per call: the arguments separated by "|", and for `import` whether the certificate file exists
  const fakeSecurity = `#!/bin/sh
line="$1"
shift
for arg in "$@"; do line="$line|$arg"; done
if [ "\${line%%|*}" = "import" ]; then
  if [ -f "$1" ]; then line="$line|present:$(cat "$1")"; else line="$line|missing"; fi
fi
echo "$line" >> "$FAKE_LOG"
if [ "\${line%%|*}" = "$FAKE_KILL_ON" ]; then kill -TERM "$PPID"; fi
if [ "\${line%%|*}" = "$FAKE_FAIL_ON" ]; then exit 1; fi
exit 0
`

  // macOS syntax: base64 --decode -o <file>. The input is stored as received.
  const fakeBase64 = `#!/bin/sh
[ "$1" = "--decode" ] && [ "$2" = "-o" ] || exit 64
cat > "$3"
`

  const run = (env: Record<string, string> = {}) => spawnSync(shell, [script], {
    cwd: root,
    encoding: 'utf-8',
    env: {
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      BUILD_CERTIFICATE_BASE64: 'Y2VydGlmaWNhdGU=',
      APPLE_PASSWORD: 'test password * $HOME',
      FAKE_LOG: log,
      ...env,
    },
  })

  const calls = () => fs.readFileSync(log, 'utf-8').trim().split('\n')

  // everything the script left behind, in the runner temp folder or next to it
  const leftovers = () => [
    ...fs.readdirSync(runnerTemp).map(name => `runner temp/${name}`),
    ...fs.readdirSync(root).filter(name => !['bin', 'runner temp', 'security.log'].includes(name)),
  ]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-cert-'))
    runnerTemp = path.join(root, 'runner temp')
    log = path.join(root, 'security.log')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(path.join(root, 'bin'))
    fs.writeFileSync(path.join(root, 'bin', 'security'), fakeSecurity, { mode: 0o755 })
    fs.writeFileSync(path.join(root, 'bin', 'base64'), fakeBase64, { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('imports the certificate then removes it', () => {
    const keychain = path.join(runnerTemp, 'build.keychain-db')
    const certificate = path.join(runnerTemp, 'certificate.p12')
    const result = run()
    expect(result.status).toBe(0)
    expect(calls()).toEqual([
      'find-identity|-v|-p|codesigning',
      `create-keychain|-p|test password * $HOME|${keychain}`,
      `set-keychain-settings|-lut|21600|${keychain}`,
      `unlock-keychain|-p|test password * $HOME|${keychain}`,
      `import|${certificate}|-P|test password * $HOME|-A|-t|cert|-f|pkcs12|-k|${keychain}|present:Y2VydGlmaWNhdGU=`,
      `set-key-partition-list|-S|apple-tool:,apple:|-k|test password * $HOME|${keychain}`,
      `list-keychain|-d|user|-s|${keychain}`,
      'find-identity|-v|-p|codesigning',
    ])
    expect(leftovers()).toEqual([])
  })

  test('removes the certificate when the import fails', () => {
    run({ FAKE_FAIL_ON: 'import' })
    expect(calls().some(call => call.startsWith('import|') && call.includes('|present:'))).toBe(true)
    expect(leftovers()).toEqual([])
  })

  test('removes the certificate when the script is terminated half way', () => {
    const result = run({ FAKE_KILL_ON: 'import' })
    expect(result.status).not.toBe(0)
    expect(calls().some(call => call.startsWith('import|') && call.includes('|present:'))).toBe(true)
    expect(calls().some(call => call.startsWith('list-keychain'))).toBe(false)
    expect(leftovers()).toEqual([])
  })

})
