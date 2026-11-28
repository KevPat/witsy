
import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { bug } from './bug'

// Static checks of the build and packaging configuration. Nothing is built or executed.

const root = path.join(__dirname, '../../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8')
const pkg = JSON.parse(read('package.json'))
const forgeConfig = read('forge.config.ts')

// e_machine of an ELF file / machine of a PE file
const elfMachine = (file: string): number => fs.readFileSync(file).readUInt16LE(18)
const peMachine = (file: string): number => {
  const buffer = fs.readFileSync(file)
  return buffer.readUInt16LE(buffer.readUInt32LE(0x3c) + 4)
}
const machOCpu = (file: string): number => fs.readFileSync(file).readUInt32LE(4)

const EM_X86_64 = 0x3e
const EM_AARCH64 = 0xb7
const PE_AMD64 = 0x8664
const PE_ARM64 = 0xaa64
const MACHO_X86_64 = 0x01000007
const MACHO_ARM64 = 0x0100000c

describe('npm scripts on Windows', () => {

  const offenders = (pattern: RegExp) => Object.keys(pkg.scripts).filter(name => pattern.test(pkg.scripts[name]))

  bug('no script relies on single quotes', () => {
    // cmd.exe, which npm uses on Windows, passes single quotes through literally: the globs match nothing
    expect(offenders(/'/)).toEqual([])
  })

  bug('no script sets environment variables with POSIX syntax', () => {
    // VAR=value command is not understood by cmd.exe or PowerShell (the start script uses cross-env for this)
    expect(offenders(/^(\w+=\S+\s+)+\w/)).toEqual([])
  })

  bug('no script uses a POSIX-only path', () => {
    expect(offenders(/(^|[\s=])\/tmp\b/)).toEqual([])
  })

})

describe('native prebuilds', () => {

  const prebuild = (target: string) => path.join(root, 'node_modules', 'autolib', 'prebuilds', target, 'autolib.node')
  const present = (target: string) => fs.existsSync(prebuild(target))

  test.runIf(present('linux-x64'))('autolib linux-x64 is an x86-64 ELF', () => {
    expect(elfMachine(prebuild('linux-x64'))).toBe(EM_X86_64)
  })

  bug.runIf(present('linux-arm64'))('autolib linux-arm64 is an aarch64 ELF', () => {
    // the published linux-arm64 prebuild is a copy of the x86-64 binary
    expect(elfMachine(prebuild('linux-arm64'))).toBe(EM_AARCH64)
  })

  test.runIf(present('win32-x64'))('autolib win32-x64 is an x64 PE', () => {
    expect(peMachine(prebuild('win32-x64'))).toBe(PE_AMD64)
  })

  test.runIf(present('win32-arm64'))('autolib win32-arm64 is an arm64 PE', () => {
    expect(peMachine(prebuild('win32-arm64'))).toBe(PE_ARM64)
  })

  test.runIf(present('darwin-x64'))('autolib darwin-x64 is an x86-64 Mach-O', () => {
    expect(machOCpu(prebuild('darwin-x64'))).toBe(MACHO_X86_64)
  })

  test.runIf(present('darwin-arm64'))('autolib darwin-arm64 is an arm64 Mach-O', () => {
    expect(machOCpu(prebuild('darwin-arm64'))).toBe(MACHO_ARM64)
  })

})

describe('forge configuration', () => {

  test('the icon served by the local http server is packaged', () => {
    // http_server.ts reads <resources>/icon.png for /logo.png; only icon.ico is in extraResource
    const usesIconPng = read('src/main/http_server.ts').includes('\'icon.png\'')
    expect(usesIconPng).toBe(true)
    expect(forgeConfig).toMatch(/extraResource:\s*\[[^\]]*'assets\/icon\.png'/)
  })

  bug('the build version is not the text "undefined" when BUILD_NUMBER is not set', () => {
    // a template literal around an undefined environment variable
    expect(forgeConfig).not.toMatch(/buildVersion:\s*`\$\{process\.env\.BUILD_NUMBER\}`/)
  })

  bug('the packaged binary cannot be run as a plain Node.js interpreter or debugged from the command line', () => {
    // ELECTRON_RUN_AS_NODE and --inspect let any local process run code as the signed app (on macOS with its permissions)
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.RunAsNode\]:\s*true/)
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.EnableNodeCliInspectArguments\]:\s*true/)
  })

  bug('asar integrity validation is enabled', () => {
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.EnableEmbeddedAsarIntegrityValidation\]:\s*false/)
  })

  test('the patched MCP SDK CommonJS build still parses', () => {
    // the patch replaces the `shell: false,` property with a bare expression
    const patch = read(fs.readdirSync(path.join(root, 'patches')).map(f => `patches/${f}`).find(f => f.includes('modelcontextprotocol'))!)
    const cjs = patch.split('diff --git').find(section => section.includes('/dist/cjs/client/stdio.js'))!
    const added = cjs.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    expect(added.every(line => /^\+\s*(shell:|\/\/)/.test(line))).toBe(true)
  })

})

describe('CI workflows', () => {

  const dir = '.github/workflows'
  const workflows = fs.readdirSync(path.join(root, dir))
    .filter(file => /\.ya?ml$/.test(file))
    .map(file => ({ file, text: read(`${dir}/${file}`) }))

  // one entry per step: from its "- key:" list item to the next one, comments removed
  const stepsOf = (text: string): string[] => text.replace(/^\s*#.*$/gm, '').split(/^ +- (?=[\w-]+:)/m).slice(1)
  const title = (step: string) => step.split('\n')[0].trim()

  test('no step that writes to GITHUB_ENV receives a secret', () => {
    // a value written to GITHUB_ENV is handed to every later step of the job, third-party actions included
    expect(workflows.some(({ text }) => text.includes('GITHUB_ENV'))).toBe(true)
    const offenders = workflows.flatMap(({ file, text }) => stepsOf(text)
      .filter(step => step.includes('GITHUB_ENV') && /\bsecrets\./.test(step))
      .map(step => `${file}: ${title(step)}`))
    expect(offenders).toEqual([])
  })

  test('every remote action is pinned to a full commit SHA, with its version in a comment', () => {
    // a tag such as @v4 can be moved to other code at any time; workflows of this repository (./) are not concerned
    const remote = workflows.flatMap(({ file, text }) => [...text.matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm)]
      .map(match => ({ file, ref: match[1].trim() })))
      .filter(({ ref }) => !ref.startsWith('./') && !ref.startsWith('docker://'))
    expect(remote.length).toBeGreaterThan(0)
    const unpinned = remote.filter(({ ref }) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(ref))
    expect(unpinned.map(({ file, ref }) => `${file}: ${ref}`)).toEqual([])
  })

  test('the steps that sign for Windows receive the DigiCert variables themselves', () => {
    // smctl and signtool (through the DigiCert key storage provider) read them from their own environment
    const credentials = ['SM_HOST', 'SM_API_KEY', 'SM_CLIENT_CERT_PASSWORD']
    const missing = (step: string, names: string[]) => names
      .filter(name => !new RegExp(`^\\s+${name}: \\$\\{\\{[^}]*\\bsecrets\\.${name}\\b[^}]*\\}\\}\\s*$`, 'm').test(step))
    const signing = workflows.filter(({ text }) => stepsOf(text).some(step => /\bsmctl\b/.test(step)))
    expect(signing.map(({ file }) => file).sort()).toEqual(['build-win32-x64.yml', 'test.yml'])
    for (const { file, text } of signing) {
      const steps = stepsOf(text)
      const certsync = steps.filter(step => /\bsmctl\b/.test(step))
      const build = steps.filter(step => step.includes('build.ps1'))
      expect(build, file).toHaveLength(1)
      expect(certsync.flatMap(step => missing(step, credentials)), file).toEqual([])
      expect(missing(build[0], [...credentials, 'SM_CODE_SIGNING_CERT_SHA1_HASH']), file).toEqual([])
      // the path of the client certificate is not a secret and stays in GITHUB_ENV
      expect(text, file).toMatch(/echo "SM_CLIENT_CERT_FILE=[^"]+" >> "?\$GITHUB_ENV/)
    }
  })

})
