import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const root = path.join(__dirname, '../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('platform release configuration', () => {
  test('Developer ID signing does not use the expired provisioning profile', () => {
    expect(read('forge.config.ts')).not.toContain('provisioningProfile')
    expect(fs.existsSync(path.join(root, 'build/Witsy_Darwin.provisionprofile'))).toBe(false)
    expect(read('build/SIGNING.md')).toContain('Developer ID Application')
  })

  test('arm64 automation is gated instead of shipping incompatible binaries', () => {
    expect(read('src/main/automations/nut.ts')).toContain("process.arch === 'arm64'")
    expect(read('src/main/native_automation.ts')).toContain("target === 'linux-arm64'")
    expect(read('build/purge_native.ts')).toContain("currentPlatformArch !== 'linux-arm64'")
    expect(read('build/check_native_architecture.mjs')).toContain('Native binary architecture mismatch')
  })

  test('Windows arm64 builds natively with Squirrel and optional signing', () => {
    const workflow = read('.github/workflows/build-win32-arm64.yml')
    expect(workflow).toContain('runs-on: windows-11-arm')
    expect(workflow).toContain('run: ./build/build.ps1')
    expect(workflow).toContain('SM_CODE_SIGNING_CERT_SHA1_HASH')
    expect(read('build/build.ps1')).toContain('electron-forge make')
  })

  test('Linux CLI does not shadow the desktop executable', () => {
    expect(read('src/main/cli_installer.ts')).toContain("'witsy-cli'")
    expect(read('README.md')).toContain('/usr/local/bin/witsy-cli')
  })

  test('Windows build and publish scripts share artifact names', () => {
    expect(read('build/build.ps1')).toContain('Get-WitsyWindowsArtifactNames')
    expect(read('build/publish.ps1')).toContain('Get-WitsyWindowsArtifactPaths')
    expect(read('build/windows_artifacts.ps1')).toContain('.Setup.exe')
  })

  test('unmaintained vulnerable document dependencies are replaced', () => {
    expect(pkg.dependencies.xlsx).toBeUndefined()
    expect(pkg.dependencies['@iktakahiro/markdown-it-katex']).toBeUndefined()
    expect(pkg.dependencies.exceljs).toBeDefined()
    expect(pkg.dependencies['@mdit/plugin-katex']).toBeDefined()
  })

  test('packaging config has safe defaults and Linux metadata', () => {
    const forge = read('forge.config.ts')
    expect(forge).toContain("process.env.BUILD_NUMBER ?? '0'")
    expect(forge).toContain("depends: ['libevdev2']")
    expect(forge).toContain("requires: ['libevdev']")
    expect(forge).toContain("icon: './assets/icon.png'")
  })

  test('packaging does not mutate the working dependency tree and signs the app executable', () => {
    const forge = read('forge.config.ts')
    const afterCopy = forge.match(/afterCopy:\s*\[([\s\S]*?)\n\s*\],/)?.[1]
    expect(read('build/prepackage.js')).not.toMatch(/npm (uninstall|install)/)
    expect(read('build/sign_binaries.ts')).toContain("'Witsy.exe'")
    expect(forge).toMatch(/postPackage:[\s\S]*signWindowsBinaries/)
    expect(afterCopy).not.toContain('signWindowsBinaries')
  })

  test('PR quality workflow covers every supported OS and architecture', () => {
    const workflow = read('.github/workflows/test.yml')
    for (const runner of ['ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-latest', 'windows-11-arm', 'macos-15-intel', 'macos-15']) {
      expect(workflow).toContain(`runner: ${runner}`)
    }
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('run: npm run lint')
    expect(workflow).toContain('npx vitest --run')
  })

  test('release orchestration includes Linux arm64', () => {
    expect(read('Makefile')).toContain('linux: linux-x64 linux-arm64')
    expect(read('Makefile')).toContain('build-linux-arm64.yml')
    expect(read('.github/workflows/build-linux-arm64.yml')).toContain('ubuntu-24.04-arm')
  })

  test('macOS packages and signs on the target architecture', () => {
    expect(read('.github/workflows/build-darwin.yml')).toContain("inputs.arch == 'arm64' && 'macos-15' || 'macos-15-intel'")
    expect(read('build/sign_binaries.ts')).toContain("'../apple-speechanalyzer-cli'")
  })

  test('npm scripts use Windows-portable quoting and paths', () => {
    for (const name of ['lint', 'lint:css', 'test:ci', 'test:e2e']) {
      expect(pkg.scripts[name]).not.toMatch(/'/)
      expect(pkg.scripts[name]).not.toMatch(/(^|\s)\/tmp\b/)
      expect(pkg.scripts[name]).not.toMatch(/^(\w+=\S+\s+)+\w/)
    }
    expect(pkg.scripts['test:e2e']).toContain('cross-env')
  })
})
