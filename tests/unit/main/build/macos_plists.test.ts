
import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import plist from 'plist'

// Static checks of the macOS property lists used when packaging and signing. Nothing is signed here.

const root = path.join(__dirname, '../../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf-8')
const parse = (file: string) => plist.parse(read(file)) as Record<string, unknown>

const sources = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
  const file = `${dir}/${entry.name}`
  if (entry.isDirectory()) return file === 'src/vendor' ? [] : sources(file)
  return /\.(ts|vue|js)$/.test(entry.name) ? [file] : []
})

describe('build/Info.plist', () => {

  const info = parse('build/Info.plist')

  test('is the file given to the packager', () => {
    expect(read('forge.config.ts')).toMatch(/extendInfo:.*build\/Info\.plist/)
  })

  test.each([
    'NSAppleEventsUsageDescription',
    'NSLocalNetworkUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSSpeechRecognitionUsageDescription',
  ])('%s is a sentence about Witsy', (key) => {
    expect(info[key]).toEqual(expect.stringMatching(/^Witsy \S.{20,}$/))
  })

  test('speech recognition is explained because the app ships the Apple speech helper', () => {
    expect(read('src/main/stt_apple.ts')).toContain('apple-speechanalyzer-cli')
    expect(read('forge.config.ts')).toContain('assets/apple-speechanalyzer-cli')
    expect(info.NSSpeechRecognitionUsageDescription).toMatch(/speech recognition/i)
  })

})

describe('build/Entitlements.darwin.plist', () => {

  const entitlements = parse('build/Entitlements.darwin.plist')

  test('is the file given to the signing step', () => {
    expect(read('forge.config.ts')).toMatch(/entitlements:.*build\/Entitlements\.darwin\.plist/)
  })

  test('every entitlement is a boolean set to true', () => {
    expect(Object.keys(entitlements).length).toBeGreaterThan(0)
    expect(Object.values(entitlements).every(value => value === true)).toBe(true)
  })

  test('keeps what the app needs', () => {
    // V8, the audio recorder and the AppleScript automation
    expect(entitlements['com.apple.security.cs.allow-jit']).toBe(true)
    expect(read('src/renderer/audio/audio_recorder.ts')).toContain('getUserMedia({ audio: true })')
    expect(entitlements['com.apple.security.device.audio-input']).toBe(true)
    expect(read('src/main/automations/macos.ts')).toContain('tell application "System Events"')
    expect(entitlements['com.apple.security.automation.apple-events']).toBe(true)
  })

  test('does not ask for Bluetooth or USB', () => {
    expect(entitlements).not.toHaveProperty('com.apple.security.device.bluetooth')
    expect(entitlements).not.toHaveProperty('com.apple.security.device.usb')
  })

  test('nothing in the app can select a Bluetooth or USB device', () => {
    // Electron cancels every navigator.bluetooth / navigator.usb request when these events have no listener.
    // If one is added, the matching entitlement has to come back.
    const users = sources('src').filter(file => /select-bluetooth-device|select-usb-device|navigator\.(bluetooth|usb)\b/.test(read(file)))
    expect(users).toEqual([])
    const pkg = JSON.parse(read('package.json'))
    const packages = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
    expect(packages.filter(name => /(^|[-/@])(usb|node-hid|serialport|noble|bluetooth|ble)($|[-/])/.test(name))).toEqual([])
  })

})
