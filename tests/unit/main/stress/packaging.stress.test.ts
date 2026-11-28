
import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { runAsNodeFuse } from '@root/build/cli_runtime'
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

  test('the packaged binary is a Node.js interpreter only when the CLI runs on the app binary', () => {
    // ELECTRON_RUN_AS_NODE lets any local process run code as the signed app (on macOS with its permissions).
    // The fuse follows build/cli_runtime.ts: on by default on every platform, off for a build made with
    // WITSY_CLI_RUNTIME=node, whose CLI runs on the Node.js of the user (tests/unit/main/build/cli_runtime.test.ts).
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.RunAsNode\]:\s*true/)
    expect(forgeConfig).toMatch(/\[FuseV1Options\.RunAsNode\]:\s*runAsNodeFuse\(targetPlatform\)/)
    expect(runAsNodeFuse('win32', {})).toBe(true)
    expect(runAsNodeFuse('darwin', {})).toBe(true)
    expect(runAsNodeFuse('linux', {})).toBe(true)
    expect(runAsNodeFuse('win32', { WITSY_CLI_RUNTIME: 'node' })).toBe(false)
    expect(runAsNodeFuse('darwin', { WITSY_CLI_RUNTIME: 'node' })).toBe(false)
    expect(runAsNodeFuse('linux', { WITSY_CLI_RUNTIME: 'node' })).toBe(false)
  })

  test('release builds cannot be debugged from the command line', () => {
    // --inspect is only accepted by the e2e build (TEST=1), which Playwright drives through it
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.EnableNodeCliInspectArguments\]:\s*true/)
    expect(forgeConfig).toMatch(/\[FuseV1Options\.EnableNodeCliInspectArguments\]:\s*!!process\.env\.TEST\b/)
  })

  test('asar integrity validation is enabled for macOS builds', () => {
    // a modified app.asar would run with the permissions granted to the signed app.
    // Windows is still off (7ab83b00: the check failed there) and Linux has no such check.
    expect(forgeConfig).not.toMatch(/\[FuseV1Options\.EnableEmbeddedAsarIntegrityValidation\]:\s*false/)
    expect(forgeConfig).toMatch(/\[FuseV1Options\.EnableEmbeddedAsarIntegrityValidation\]:\s*isDarwinTarget\b/)
    expect(forgeConfig).toMatch(/const isDarwinTarget = \['darwin', 'mas'\]\.includes\(targetPlatform\)/)
    // it only means something when the app cannot be loaded from anywhere else
    expect(forgeConfig).toMatch(/\[FuseV1Options\.OnlyLoadAppFromAsar\]:\s*true/)
  })

  test('the platform being packaged is the one given to forge, or the host', () => {
    // the fuses are chosen when the configuration is loaded: `make all` builds every platform from one host
    const source = forgeConfig.match(/const targetPlatform = (\(\(\): string => \{[\s\S]*?\}\)\(\));/)?.[1]
    expect(source).toBeDefined()
    const targetPlatform = (argv: string[], platform: string): string => {
      return new Function('process', `return ${source!.replace('(): string =>', '() =>')}`)({ argv, platform })
    }
    expect(targetPlatform(['node', 'electron-forge', 'make', '-p', 'darwin', '-a', 'arm64'], 'linux')).toBe('darwin')
    expect(targetPlatform(['node', 'electron-forge', 'make', '-p', 'win32', '-a', 'x64'], 'darwin')).toBe('win32')
    expect(targetPlatform(['node', 'electron-forge', 'make', '--platform', 'linux'], 'darwin')).toBe('linux')
    expect(targetPlatform(['node', 'electron-forge', 'make', '--platform=win32'], 'darwin')).toBe('win32')
    expect(targetPlatform(['node', 'electron-forge', 'package'], 'darwin')).toBe('darwin')
    expect(targetPlatform(['node', 'electron-forge', 'make', '-p'], 'win32')).toBe('win32')
  })

  bug('the patched MCP SDK CommonJS build still parses', () => {
    // the patch replaces the `shell: false,` property with a bare expression
    const patch = read(fs.readdirSync(path.join(root, 'patches')).map(f => `patches/${f}`).find(f => f.includes('modelcontextprotocol'))!)
    const cjs = patch.split('diff --git').find(section => section.includes('/dist/cjs/client/stdio.js'))!
    const added = cjs.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    expect(added.every(line => /^\+\s*(shell:|\/\/)/.test(line))).toBe(true)
  })

})
