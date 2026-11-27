
import { test, expect, vi } from 'vitest'
import { app, Menu } from 'electron'
import { installMenu } from '@main/menu'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
    getLocale: vi.fn(() => 'en-US'),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null)
  },
  Menu: {
    buildFromTemplate: vi.fn(() => { return {}}),
    setApplicationMenu: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((data) => `encrypted-${data}`),
    decryptString: vi.fn((data) => data.toString('latin1'))
  },
}))

test('installMenu', () => {
  installMenu(app, {
    quit: vi.fn(),
    checkForUpdates: vi.fn(),
    quickPrompt: vi.fn(),
    openMain: vi.fn(),
    scratchpad: vi.fn(),
    settings: vi.fn(),
    studio: vi.fn(),
    forge: vi.fn(),
    backupExport: vi.fn(),
    backupImport: vi.fn(),
    importOpenAI: vi.fn(),
  }, null)
  expect(Menu.buildFromTemplate).toHaveBeenCalled()
  expect(Menu.setApplicationMenu).toHaveBeenLastCalledWith({})
})

if (process.platform !== 'darwin') {
  // Regression guard for macOS-only Command accelerators on Windows and Linux.
  test.fails('Edit menu uses Control shortcuts outside macOS', () => {
    installMenu(app, {
      quit: vi.fn(),
      checkForUpdates: vi.fn(),
      quickPrompt: vi.fn(),
      openMain: vi.fn(),
      scratchpad: vi.fn(),
      settings: vi.fn(),
      studio: vi.fn(),
      forge: vi.fn(),
      backupExport: vi.fn(),
      backupImport: vi.fn(),
      importMarkdown: vi.fn(),
      importOpenAI: vi.fn(),
    }, null)

    const calls = vi.mocked(Menu.buildFromTemplate).mock.calls
    const template = calls[calls.length - 1][0] as any[]
    const editMenu = template[1]
    const accelerators = editMenu.submenu
      .map((item: any) => item.accelerator)
      .filter(Boolean)

    expect(accelerators).toContain('Control+F')
    expect(accelerators).toContain('Control+Shift+F')
    expect(accelerators.some((accelerator: string) => accelerator.includes('Command'))).toBe(false)
  })
}
