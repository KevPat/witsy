//
// backup (D-27): a backup made by the packaged app holds no key material, and a restore never brings
// one in. End to end, with two isolated "computers" (two user data folders) and made-up keys:
// - computer A has keys for two providers, an MCP server with a secret environment variable and an
//   http MCP server with an Authorization header; its backup is extracted and every byte is searched;
// - computer B has a key of its own; A's backup is restored on it: B's key store is byte for byte the
//   same, none of A's keys is anywhere in B's folder, B's key is still loaded after the restart;
// - an older-format backup that does hold keys (a key store and keys in clear text) restores none.
//

import { afterAll, expect, test } from 'vitest'
import { ZipArchive } from 'archiver'
import crypto from 'node:crypto'
import extractZip from 'extract-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artifactsDir, chat, dialogsShown, DUMMY_KEYS, findSecrets, historyWith, launchApp, makeHome, message, record, sleep, stubDialogs, waitFor, walkFiles } from './harness'

const suite = 'backup'
const dir = artifactsDir(suite)
const machineASecrets = [DUMMY_KEYS.openai, DUMMY_KEYS.anthropic, DUMMY_KEYS.mcpEnv, DUMMY_KEYS.mcpHeader]
const toClean: string[] = []

const settingsWithKeys = (openaiKey: string, extra: Record<string, any> = {}) => ({
  engines: {
    openai: { apiKey: openaiKey },
    ...extra.engines,
  },
  mcp: {
    servers: [
      { uuid: 'verify-stdio', registryId: 'verify-stdio', state: 'disabled', type: 'stdio', label: 'Verify stdio', command: 'node', url: 'server.js', env: { VERIFY_API_TOKEN: extra.mcpEnv ?? '' } },
      { uuid: 'verify-http', registryId: 'verify-http', state: 'disabled', type: 'http', label: 'Verify http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: extra.mcpHeader ? `Bearer ${extra.mcpHeader}` : '' } },
    ],
    mcpServersExtra: {},
    smitheryApiKey: '',
  },
})

const sha256 = (file: string) => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null

let backupZip: string
let homeB: string

afterAll(() => {
  for (const d of toClean) fs.rmSync(d, { recursive: true, force: true })
})

test('computer A: the backup made from the app holds none of its keys', async () => {
  const homeA = makeHome('backup-a', {
    settings: settingsWithKeys(DUMMY_KEYS.openai, { engines: { anthropic: { apiKey: DUMMY_KEYS.anthropic } }, mcpEnv: DUMMY_KEYS.mcpEnv, mcpHeader: DUMMY_KEYS.mcpHeader }),
    history: historyWith([chat('Backup verify chat', [message('user', 'remember VERIFY-BACKUP-CHAT'), message('assistant', 'ok')])]),
  })
  toClean.push(homeA)
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-backup-out-'))
  toClean.push(outDir)
  const launched = await launchApp(homeA)
  try {
    // the app moved the keys to its key store at startup: they are loaded from there
    const loaded = await launched.window.evaluate(() => { const c = (window as any).api.config.load(); return { openai: c.engines.openai?.apiKey, anthropic: c.engines.anthropic?.apiKey } })
    const keyStatus = await launched.window.evaluate(() => (window as any).api.config.keyStorageStatus?.())
    record(suite, { machineAKeysLoaded: { openai: loaded.openai === DUMMY_KEYS.openai, anthropic: loaded.anthropic === DUMMY_KEYS.anthropic }, keyStorageStatus: keyStatus })
    expect(loaded.openai).toBe(DUMMY_KEYS.openai)

    await stubDialogs(launched.app, { openPaths: [outDir], messageBoxResponse: 0 })
    const ok = await launched.window.evaluate(() => (window as any).api.backup.export())
    expect(ok).toBe(true)
    const zips = fs.readdirSync(outDir).filter((f) => f.endsWith('.zip'))
    expect(zips.length).toBe(1)
    backupZip = path.join(dir, 'machine-a-backup.zip')
    fs.copyFileSync(path.join(outDir, zips[0]), backupZip)
    const shown = await dialogsShown(launched.app)
    record(suite, { exportDialogs: shown })
    // the person is told, while the keys are at hand, that the backup does not hold them
    expect(shown.some((d: any) => /never written to a backup/.test(d.detail || ''))).toBe(true)
  } finally {
    await launched.close()
  }

  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'witsy-verify-backup-x-'))
  toClean.push(extracted)
  await extractZip(backupZip, { dir: extracted })
  const files = walkFiles(extracted)
  const names = files.map((f) => path.relative(extracted, f).replace(/\\/g, '/'))
  const hits = findSecrets(files, machineASecrets)
  record(suite, { backupEntries: names, secretHitsInBackup: hits.map((h) => ({ file: path.relative(extracted, h.file), secret: h.secret.slice(0, 12) + '…' })) })
  // the data is there
  expect(names).toContain('settings.json')
  expect(names.some((n) => n.endsWith('history.json'))).toBe(true)
  expect(findSecrets(files, ['VERIFY-BACKUP-CHAT']).length).toBe(1)
  // the keys are not
  expect(names.some((n) => /apiKeys/i.test(n))).toBe(false)
  expect(hits).toEqual([])
  // and the names of what must be entered again are kept
  const settings = JSON.parse(fs.readFileSync(path.join(extracted, 'settings.json'), 'utf8'))
  const stdio = settings.mcp.servers.find((s: any) => s.uuid === 'verify-stdio')
  expect(Object.keys(stdio.env)).toEqual(['VERIFY_API_TOKEN'])
})

test('computer B: restoring A\'s backup keeps B\'s key store and brings none of A\'s keys', async () => {
  expect(backupZip).toBeTruthy()
  homeB = makeHome('backup-b', { settings: settingsWithKeys(DUMMY_KEYS.otherMachine) })
  toClean.push(homeB)
  // first launch: B's key goes to its key store
  let launched = await launchApp(homeB)
  await sleep(1500)
  await launched.close()
  const keyStore = ['apiKeys.json'].map((f) => path.join(homeB, f)).find((f) => fs.existsSync(f))
  const keyStoreBefore = keyStore ? sha256(keyStore) : null
  record(suite, { machineBKeyStore: keyStore ? path.basename(keyStore) : 'none (keys kept in settings: no OS key storage here)' })

  launched = await launchApp(homeB)
  await stubDialogs(launched.app, { openPaths: [backupZip], messageBoxResponse: 1 })
  await launched.app.evaluate(({ app }) => { app.relaunch = (() => { (globalThis as any).__verifyRelaunch = true }) as any })
  const exited = new Promise<void>((resolve) => launched.app.process().once('exit', () => resolve()))
  // the restore ends by quitting the app: do not wait on the answer of the call
  await launched.window.evaluate(() => { setTimeout(() => (window as any).api.backup.import(), 0) })
  await Promise.race([exited, sleep(30000)])
  await launched.close()

  // B's key store is untouched
  if (keyStore) expect(sha256(keyStore)).toBe(keyStoreBefore)
  // none of A's keys anywhere in B's folder
  const hits = findSecrets(walkFiles(homeB), machineASecrets)
  record(suite, { secretHitsInMachineB: hits.map((h) => path.relative(homeB, h.file)) })
  expect(hits).toEqual([])
  // A's data arrived
  expect(findSecrets(walkFiles(path.join(homeB, 'workspaces')), ['VERIFY-BACKUP-CHAT']).length).toBeGreaterThan(0)

  // after the restart, B still has its own key
  launched = await launchApp(homeB)
  try {
    const key = await launched.window.evaluate(() => (window as any).api.config.load().engines.openai?.apiKey)
    expect(key).toBe(DUMMY_KEYS.otherMachine)
  } finally {
    await launched.close()
  }
})

test('an older-format backup that holds keys restores none of them', async () => {
  // what a backup of an older version, or one made by hand, could hold: a key store and clear keys
  const oldZip = path.join(dir, 'old-format-backup.zip')
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(oldZip)
    const archive = new ZipArchive()
    output.on('close', () => resolve())
    archive.on('error', reject)
    archive.pipe(output)
    archive.append(JSON.stringify(settingsWithKeys(DUMMY_KEYS.oldBackup, { mcpEnv: DUMMY_KEYS.oldBackup, mcpHeader: DUMMY_KEYS.oldBackup }), null, 2), { name: 'settings.json' })
    archive.append(JSON.stringify({ openai: DUMMY_KEYS.oldBackup }), { name: 'apiKeys.json' })
    archive.append('[]', { name: 'commands.json' })
    archive.finalize()
  })
  const home = makeHome('backup-old', { settings: settingsWithKeys(DUMMY_KEYS.otherMachine) })
  toClean.push(home)
  const launched = await launchApp(home)
  await stubDialogs(launched.app, { openPaths: [oldZip], messageBoxResponse: 1 })
  await launched.app.evaluate(({ app }) => { app.relaunch = (() => {}) as any })
  const exited = new Promise<void>((resolve) => launched.app.process().once('exit', () => resolve()))
  await launched.window.evaluate(() => { setTimeout(() => (window as any).api.backup.import(), 0) })
  await Promise.race([exited, sleep(30000)])
  await launched.close()
  const restored = await waitFor(() => fs.existsSync(path.join(home, 'commands.json')), 5000).catch(() => false)
  const hits = findSecrets(walkFiles(home), [DUMMY_KEYS.oldBackup])
  record(suite, { oldBackupRestored: restored, secretHitsFromOldBackup: hits.map((h) => path.relative(home, h.file)) })
  expect(hits).toEqual([])
})
