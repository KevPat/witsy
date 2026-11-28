
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { purgeOnnxRuntime } from '../../../../build/purge_native'

const allBinaries = ['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/arm64', 'win32/x64']

let buildPath: string

const napiPath = () => path.join(buildPath, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')

const remaining = (): string[] => {
  const found: string[] = []
  for (const platform of fs.readdirSync(napiPath()).sort()) {
    for (const arch of fs.readdirSync(path.join(napiPath(), platform)).sort()) {
      found.push(`${platform}/${arch}`)
    }
  }
  return found
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-purge-'))
  for (const dir of allBinaries) {
    fs.mkdirSync(path.join(napiPath(), dir), { recursive: true })
    fs.writeFileSync(path.join(napiPath(), dir, 'onnxruntime_binding.node'), dir)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(buildPath, { recursive: true, force: true })
})

describe('purgeOnnxRuntime', () => {

  test.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ])('keeps only the %s/%s binaries', (platform, arch) => {
    purgeOnnxRuntime(buildPath, platform, arch)
    expect(remaining()).toEqual([`${platform}/${arch}`])
    expect(fs.readFileSync(path.join(napiPath(), platform, arch, 'onnxruntime_binding.node'), 'utf-8')).toBe(`${platform}/${arch}`)
  })

  test('removes nothing for an unknown target', () => {
    purgeOnnxRuntime(buildPath, 'freebsd', 'x64')
    expect(remaining()).toEqual(allBinaries)
  })

  test('does nothing when onnxruntime-node is not installed', () => {
    fs.rmSync(path.join(buildPath, 'node_modules'), { recursive: true, force: true })
    expect(() => purgeOnnxRuntime(buildPath, 'win32', 'arm64')).not.toThrow()
    expect(fs.existsSync(path.join(buildPath, 'node_modules'))).toBe(false)
  })

})
