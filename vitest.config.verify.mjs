// Configuration of the verification suites (npm run verify, see VERIFY.md).
// They drive the packaged app and real tools: one file at a time, no mocks, long timeouts.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/verify/**/*.verify.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    testTimeout: 240000,
    hookTimeout: 300000,
    retry: 0,
  },
})
