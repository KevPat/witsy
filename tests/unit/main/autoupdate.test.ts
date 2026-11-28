
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { app, autoUpdater } from 'electron'
import AutoUpdater, { getUpdateRepository } from '@main/autoupdate'
import mainConfig from '@root/vite.main.config'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getLocale: vi.fn(() => 'en-US'),
    getVersion: vi.fn(() => '1.2.3'),
  },
  autoUpdater: {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
  },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(),
  },
}))

// the build configuration is only evaluated, never run: vite itself is not needed for that
vi.mock('vite', () => ({
  defineConfig: (config: unknown) => config,
  mergeConfig: (base: object, config: object) => ({ ...base, ...config }),
}))

vi.mock('vite-tsconfig-paths', () => ({
  default: () => ({ name: 'tsconfig-paths' }),
}))

vi.mock('@main/i18n', () => ({
  useI18n: vi.fn(() => (key: string) => key)
}))

const kDefault = 'Kochava-Studios/witsy'

// what vite.main.config.ts injects in the main process bundle
const setBuildRepository = (value: unknown) => vi.stubGlobal('__WITSY_UPDATE_REPOSITORY__', value)

const feedUrl = (): string => {
  new AutoUpdater(app, { onUpdateAvailable: () => {}, preInstall: () => {} })
  expect(autoUpdater.setFeedURL).toHaveBeenCalledTimes(1)
  return vi.mocked(autoUpdater.setFeedURL).mock.calls[0][0].url
}

beforeEach(() => {
  vi.clearAllMocks()
  // the updater re-checks every hour
  vi.useFakeTimers()
  vi.stubEnv('DEBUG', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('update repository', () => {

  test('is the official repository when the build did not set one', () => {
    expect(getUpdateRepository()).toBe(kDefault)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('is the official repository when the build set an empty one', () => {
    setBuildRepository('')
    expect(getUpdateRepository()).toBe(kDefault)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test.each([
    'KevPat/witsy',
    'some-org/witsy.next',
    'user_1/My-Repo_2',
    'a/b',
  ])('is the repository set by the build: %s', (repository) => {
    setBuildRepository(repository)
    expect(getUpdateRepository()).toBe(repository)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test.each([
    'witsy',
    'owner/',
    '/witsy',
    'owner/witsy/extra',
    'owner//witsy',
    ' owner/witsy',
    'owner/witsy\n',
    'owner/wit sy',
    'https://github.com/owner/witsy',
    'owner/witsy?x=1',
    'owner/witsy#x',
    'owner\\witsy',
  ])('falls back to the official repository and logs when the value is not owner/name: %j', (repository) => {
    setBuildRepository(repository)
    expect(getUpdateRepository()).toBe(kDefault)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  test.each([42, null, { owner: 'owner', name: 'witsy' }])('falls back to the official repository when the value is not a string: %j', (repository) => {
    setBuildRepository(repository)
    expect(getUpdateRepository()).toBe(kDefault)
  })

})

describe('update feed', () => {

  test('points at the official repository by default', () => {
    expect(feedUrl()).toBe(`https://update.electronjs.org/${kDefault}/${process.platform}-${process.arch}/1.2.3`)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  test('points at the repository set by the build', () => {
    setBuildRepository('KevPat/witsy')
    expect(feedUrl()).toBe(`https://update.electronjs.org/KevPat/witsy/${process.platform}-${process.arch}/1.2.3`)
  })

  test('points at the official repository when the build value is malformed', () => {
    setBuildRepository('https://example.com/evil')
    expect(feedUrl()).toBe(`https://update.electronjs.org/${kDefault}/${process.platform}-${process.arch}/1.2.3`)
  })

})

describe('build-time define of the main process', () => {

  // the value is a JavaScript expression: a JSON string literal
  const define = (): string => {
    const config: any = (mainConfig as any)({
      command: 'build',
      mode: 'production',
      root: process.cwd(),
      forgeConfig: { renderer: [{ name: 'main_window' }] },
      forgeConfigSelf: { entry: 'src/main.ts' },
    })
    return JSON.parse(config.define.__WITSY_UPDATE_REPOSITORY__)
  }

  test('is empty outside of CI, which selects the official repository', () => {
    vi.stubEnv('WITSY_UPDATE_REPOSITORY', '')
    vi.stubEnv('GITHUB_REPOSITORY', '')
    expect(define()).toBe('')
    setBuildRepository(define())
    expect(getUpdateRepository()).toBe(kDefault)
  })

  test('is the repository of the GitHub Actions run, so the build of a fork follows the fork', () => {
    vi.stubEnv('WITSY_UPDATE_REPOSITORY', '')
    vi.stubEnv('GITHUB_REPOSITORY', 'KevPat/witsy')
    expect(define()).toBe('KevPat/witsy')
  })

  test('WITSY_UPDATE_REPOSITORY wins over GITHUB_REPOSITORY', () => {
    vi.stubEnv('WITSY_UPDATE_REPOSITORY', 'some-org/witsy')
    vi.stubEnv('GITHUB_REPOSITORY', 'KevPat/witsy')
    expect(define()).toBe('some-org/witsy')
  })

  test('keeps the other defines of the main process', () => {
    const config: any = (mainConfig as any)({
      command: 'build',
      mode: 'production',
      root: process.cwd(),
      forgeConfig: { renderer: [{ name: 'main_window' }] },
      forgeConfigSelf: { entry: 'src/main.ts' },
    })
    expect(config.define.MAIN_WINDOW_VITE_NAME).toBe('"main_window"')
  })

})
