// runs one of the tools/*_probe.cjs checks (a real Electron, outside the app) and keeps its output
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { artifactsDir, repoRoot } from './harness'

export const runProbe = (suite: string, probe: string, timeout = 600000) => {
  const res = spawnSync(process.execPath, [path.join(repoRoot, 'tools', probe)], { cwd: repoRoot, encoding: 'utf8', timeout, env: { ...process.env } })
  const output = `${res.stdout || ''}${res.stderr || ''}`
  const file = path.join(artifactsDir(suite), `${path.basename(probe, '.cjs')}.log`)
  fs.writeFileSync(file, output)
  const lines = output.split(/\r?\n/)
  const passed = lines.filter((l) => /^\s*(PASS|ok)\b/.test(l)).length
  const failed = lines.filter((l) => /^\s*(FAIL|not ok)\b/.test(l))
  const skipped = lines.filter((l) => /^\s*SKIP\b/.test(l))
  return { status: res.status, passed, failed, skipped, log: file, output }
}
