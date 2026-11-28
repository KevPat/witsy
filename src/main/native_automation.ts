import { createRequire } from 'node:module'
import type * as Autolib from 'autolib'

const target = `${process.platform}-${process.arch}`
const unsupported = target === 'linux-arm64'
let implementation: typeof Autolib | null = null

if (!unsupported) {
  try {
    const require = createRequire(__filename)
    implementation = require('autolib') as typeof Autolib
  } catch (error) {
    console.warn(`[autolib] Native automation is unavailable on ${target}`, error)
  }
} else {
  console.warn(`[autolib] Native automation is disabled on ${target}: the published prebuild is not arm64.`)
}

const unavailable = (method: PropertyKey) => {
  throw new Error(`[autolib] ${String(method)} is unavailable on ${target}`)
}

const autolib = new Proxy({} as typeof Autolib, {
  get: (_target, method: keyof typeof Autolib) => {
    const value = implementation?.[method]
    if (typeof value === 'function') {
      return value.bind(implementation)
    }
    return value ?? (() => unavailable(method))
  }
})

export default autolib
