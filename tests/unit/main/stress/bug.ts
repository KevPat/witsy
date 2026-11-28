
import { test } from 'vitest'

// A `bug(...)` test asserts the CORRECT behaviour for a defect that was confirmed during the
// bug hunt. It is registered with `test.fails`, so the suite stays green while the defect is
// open and turns red as soon as the defect is fixed: at that point replace `bug` with `test`.
//
// BUGHUNT_STRICT=1 npx vitest --run tests/unit/main/stress
// registers them as plain tests, so every open defect fails with its real assertion message.

export const strict = !!process.env.BUGHUNT_STRICT

export const bug = strict ? test : test.fails

// behaviour that depends on the host OS was only verified on Linux
export const isLinux = process.platform === 'linux'
export const isPosix = process.platform !== 'win32'
