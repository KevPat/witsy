
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

  bug('the icon served by the local http server is packaged', () => {
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

  bug('the patched MCP SDK CommonJS build still parses', () => {
    // the patch replaces the `shell: false,` property with a bare expression
    const patch = read(fs.readdirSync(path.join(root, 'patches')).map(f => `patches/${f}`).find(f => f.includes('modelcontextprotocol'))!)
    const cjs = patch.split('diff --git').find(section => section.includes('/dist/cjs/client/stdio.js'))!
    const added = cjs.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    expect(added.every(line => /^\+\s*(shell:|\/\/)/.test(line))).toBe(true)
  })

})
