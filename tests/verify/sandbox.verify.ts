//
// sandbox (S-16): Python runs in a sandboxed renderer with no Node.js, no bridge and no network.
// tools/pyodide_sandbox_probe.cjs in a real Electron (the first run downloads Pyodide, about 60 MB).
//

import { expect, test } from 'vitest'
import { record } from './harness'
import { runProbe } from './probes'

const suite = 'sandbox'

test('the Python sandbox probe passes in a real Electron', () => {
  const res = runProbe(suite, 'pyodide_sandbox_probe.cjs', 900000)
  record(suite, { probe: { status: res.status, passed: res.passed, failed: res.failed, skipped: res.skipped, log: res.log } })
  expect(res.failed).toEqual([])
  expect(res.status).toBe(0)
  expect(res.passed).toBeGreaterThan(10)
})
