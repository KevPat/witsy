import fs from 'node:fs'
import path from 'node:path'

const valueFor = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const platform = valueFor('platform') ?? process.platform
const arch = valueFor('arch') ?? process.arch
const expected = {
  linux: { x64: 0x3e, arm64: 0xb7 },
  win32: { x64: 0x8664, arm64: 0xaa64 },
  darwin: { x64: 0x01000007, arm64: 0x0100000c },
}[platform]?.[arch]

if (!expected) {
  throw new Error(`Unsupported native binary target: ${platform}-${arch}`)
}

const machinesFor = (file) => {
  const binary = fs.readFileSync(file)
  if (platform === 'linux') return [binary.readUInt16LE(18)]
  if (platform === 'win32') return [binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4)]

  const magic = binary.readUInt32BE(0)
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = binary.readUInt32BE(4)
    const entrySize = magic === 0xcafebabe ? 20 : 32
    return Array.from({ length: count }, (_, index) => binary.readUInt32BE(8 + index * entrySize))
  }
  return [binary.readUInt32LE(4)]
}

const candidates = [
  `node_modules/autolib/prebuilds/${platform}-${arch}/autolib.node`,
  `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
  `node_modules/@nut-tree-fork/libnut-${platform}/build/Release/libnut.node`,
]

const gatedAutomation = arch === 'arm64' && (platform === 'linux' || platform === 'win32')
const nativeGate = fs.readFileSync('src/main/automations/nut.ts', 'utf8')
const autolibGate = fs.readFileSync('src/main/native_automation.ts', 'utf8')
const purge = fs.readFileSync('build/purge_native.ts', 'utf8')
const failures = []

for (const candidate of candidates) {
  const file = path.resolve(candidate)
  if (!fs.existsSync(file)) continue

  const machines = machinesFor(file)
  if (machines.includes(expected)) {
    console.log(`✓ ${candidate} matches ${platform}-${arch}`)
    continue
  }

  const isLibnut = candidate.includes('@nut-tree-fork')
  const isKnownGatedAutolib = platform === 'linux' && arch === 'arm64' && candidate.includes('/autolib/')
  const hasGate = isLibnut
    ? gatedAutomation && nativeGate.includes("process.arch === 'arm64'") && purge.includes('Removing unsupported arm64 libnut package')
    : isKnownGatedAutolib && autolibGate.includes("target === 'linux-arm64'") && purge.includes("currentPlatformArch !== 'linux-arm64'")

  if (hasGate) {
    console.log(`✓ ${candidate} is incompatible and explicitly gated out of packaged ${platform}-${arch} builds`)
  } else {
    failures.push(`${candidate}: machines ${machines.map(machine => `0x${machine.toString(16)}`).join(', ')}, expected 0x${expected.toString(16)}`)
  }
}

if (failures.length) {
  throw new Error(`Native binary architecture mismatch:\n${failures.join('\n')}`)
}
