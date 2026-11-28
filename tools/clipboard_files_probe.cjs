#!/usr/bin/env node
//
// Checks, in a real Electron and without building or starting the app, that files copied in a file
// manager survive what an automation does to the clipboard: save, write a text, restore
// (src/main/automations/clipboard_snapshot.ts). Unit tests have no clipboard.
//
//   node tools/clipboard_files_probe.cjs
//
// It works on the real clipboard of the machine. What the clipboard holds is saved first and put
// back at the end, as far as the module under test can (text, HTML, RTF, image, copied files):
// do not copy anything while it runs (a few seconds).
//
// Windows: complete. Files are copied and cut with the verbs of the shell, in a process that stays
//   alive and answers as Explorer does, and they are pasted with the paste verb of the shell.
//   This needs a PowerShell in FullLanguage mode; without it the probe says so and exits with 2.
// macOS and Linux: the round trip of the format only. The list is written in the format the file
//   manager uses, then saved, overwritten and restored. Copying in Finder or in a Linux file
//   manager and pasting there is not driven: the last lines say how to do it by hand.
//   On Linux without a display, run it under xvfb-run.
//
// Exit code 0 when every check passes, 1 when one fails, 2 when the files could not be copied.
//

const fs = require('fs')
const os = require('os')
const path = require('path')

const kWorkDir = path.join(os.tmpdir(), 'witsy-clipboard-files-probe')

// started by node: bundle the module under test, then run this same file as an Electron main script
const launch = () => {
  const { spawnSync } = require('child_process')
  const esbuild = require('esbuild')
  const bundle = path.join(kWorkDir, 'clipboard_snapshot.bundle.cjs')
  fs.mkdirSync(kWorkDir, { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'automations', 'clipboard_snapshot.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: bundle,
    logLevel: 'error',
  })
  const result = spawnSync(require('electron'), [__filename, bundle], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

// started by electron
const probe = async () => {

  const { app, clipboard } = require('electron')
  const { spawn, spawnSync } = require('child_process')
  app.setPath('userData', path.join(kWorkDir, 'userData'))
  await app.whenReady()

  const { saveClipboard, restoreClipboard } = require(process.argv[2])

  let failures = 0
  let incomplete = false
  const check = (name, actual, ok) => {
    const passed = ok(actual)
    if (!passed) failures++
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : `\n      got: ${JSON.stringify(actual)}`}`)
  }
  const info = (name, value) => console.log(`INFO  ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  const is = (expected) => (actual) => JSON.stringify(actual) === JSON.stringify(expected)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (condition, timeout = 5000) => {
    for (const start = Date.now(); Date.now() - start < timeout;) {
      if (condition()) return true
      await wait(50)
    }
    return condition()
  }

  console.log(`Electron ${process.versions.electron} on ${process.platform} ${os.release()}\n`)

  // what the machine has on its clipboard now
  const initial = saveClipboard()

  const root = fs.mkdtempSync(path.join(kWorkDir, 'run-'))
  const kFiles = { 'one.txt': Buffer.from('one'), 'two é.txt': Buffer.from('two'), 'three.bin': Buffer.from([0, 1, 2, 3, 255]) }
  const makeSource = (name) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir)
    for (const [file, content] of Object.entries(kFiles)) fs.writeFileSync(path.join(dir, file), content)
    return dir
  }
  const contentOf = (dir) => {
    const result = {}
    for (const file of fs.readdirSync(dir).sort()) result[file] = fs.readFileSync(path.join(dir, file)).toString('hex')
    return result
  }
  const kExpected = Object.fromEntries(Object.keys(kFiles).sort().map((file) => [file, kFiles[file].toString('hex')]))

  // what an automation does around a paste
  const kAutomationText = 'text written by the automation'
  const borrow = () => {
    const saved = saveClipboard()
    clipboard.writeText(kAutomationText)
    return saved
  }

  try {

    // the formats every platform has
    clipboard.writeText('text of the user')
    restoreClipboard(borrow())
    check('a text comes back', clipboard.readText(), is('text of the user'))
    clipboard.write({ text: 'plain', html: '<b>bold</b>' })
    restoreClipboard(borrow())
    check('a text with its HTML comes back', [clipboard.readText(), clipboard.readHTML().includes('<b>bold</b>')], is(['plain', true]))

    if (process.platform === 'win32') {

      const kIdList = 'Shell IDList Array'
      const kDropEffect = 'Preferred DropEffect'
      const quote = (text) => `'${text.replace(/'/g, "''")}'`
      const ps = (script) => {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { encoding: 'utf8' })
        return { status: result.status, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
      }

      // the verb of the shell on every item of a folder, in a process that has OLE started and keeps
      // answering the requests for its formats until the stop file exists: this is what Explorer is
      const shellVerb = (folder, verb, stopFile) => new Promise((resolve, reject) => {
        const script = `
          Add-Type -AssemblyName System.Windows.Forms
          [void][System.Windows.Forms.Application]::OleRequired()
          $shell = New-Object -ComObject Shell.Application
          $shell.NameSpace(${quote(folder)}).Items().InvokeVerbEx(${quote(verb)})
          [Console]::Out.WriteLine('ready')
          $n = 0
          while ($n -lt 1200 -and -not (Test-Path -LiteralPath ${quote(stopFile)})) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 25; $n++ }
        `
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script])
        let out = ''
        let err = ''
        child.stdout.on('data', (data) => { out += data; if (out.includes('ready')) resolve(child) })
        child.stderr.on('data', (data) => { err += data })
        child.on('error', reject)
        child.on('exit', (code) => { if (!out.includes('ready')) reject(new Error(`the ${verb} verb could not be run (exit code ${code}): ${err.trim().split('\n')[0]}`)) })
      })

      // paste in a folder with the verb of the shell, and wait for the files
      const shellPaste = (folder, count) => ps(`
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.Application]::OleRequired()
        $shell = New-Object -ComObject Shell.Application
        $shell.NameSpace(${quote(folder)}).Self.InvokeVerb('paste')
        $n = 0
        while ($n -lt 200 -and @(Get-ChildItem -LiteralPath ${quote(folder)}).Count -lt ${count}) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50; $n++ }
      `)

      const fileDropList = () => {
        const result = ps(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-Clipboard -Format FileDropList | ForEach-Object { $_.Name }) -join '|'`)
        return result.out.length ? result.out.split('|').sort() : []
      }

      const scenario = async (verb) => {

        console.log(`\nFiles ${verb === 'cut' ? 'cut' : 'copied'} in the shell`)
        const source = makeSource(`${verb}-source`)
        const target = path.join(root, `${verb}-target`)
        fs.mkdirSync(target)
        const stop = path.join(root, `${verb}-stop`)

        let owner
        try {
          owner = await shellVerb(source, verb, stop)
        } catch (error) {
          incomplete = true
          console.log(`SKIP  ${error.message}`)
          info('PowerShell language mode', ps('$ExecutionContext.SessionState.LanguageMode').out)
          return
        }

        try {
          check('the files are on the clipboard', [await until(() => clipboard.has(kIdList)), clipboard.availableFormats()], is([true, ['text/uri-list']]))
          const idList = clipboard.readBuffer(kIdList)
          info('formats Electron can name', [kIdList, 'FileNameW', 'FileName', kDropEffect, 'FileGroupDescriptorW'].filter((format) => clipboard.has(format)))
          info(kDropEffect, clipboard.readBuffer(kDropEffect).toString('hex'))
          check('another program sees the files as CF_HDROP', fileDropList(), is(Object.keys(kFiles).sort()))
          const single = clipboard.readBuffer('FileNameW').toString('ucs2').split(String.fromCharCode(0)).filter((name) => name.length)
          check('FileNameW holds one file, not the list (why it is not what is restored)', [single.length, Object.keys(kFiles).includes(path.basename(single[0] ?? ''))], is([1, true]))

          // the automation
          const saved = borrow()
          check('the snapshot holds the list of files', [saved.files?.format, saved.files?.data?.equals(idList), saved.text, saved.image], is([kIdList, true, '', null]))
          check('the automation replaced everything', [clipboard.availableFormats(), clipboard.readText(), clipboard.has(kIdList)], is([['text/plain'], kAutomationText, false]))

          // Explorer is still there when the clipboard is restored, but it does not own it any more
          fs.writeFileSync(stop, '')
          await new Promise((resolve) => owner.once('exit', resolve))
          owner = null

          restoreClipboard(saved)
          check('the list of files is back, and nothing else', [clipboard.has(kIdList), clipboard.readBuffer(kIdList).equals(idList), clipboard.readText(), clipboard.has(kDropEffect)], is([true, true, '', false]))
          check('a program that reads CF_HDROP sees no file (known limit)', fileDropList(), is([]))

          const pasted = shellPaste(target, Object.keys(kFiles).length)
          check('the shell pastes every file', contentOf(target), is(kExpected))
          if (pasted.err) info('paste', pasted.err.split('\n')[0])
          if (verb === 'cut') {
            check('files that were cut are pasted as a copy: the originals stay (known limit)', contentOf(source), is(kExpected))
          }
        } finally {
          if (owner) {
            fs.writeFileSync(stop, '')
            await new Promise((resolve) => owner.once('exit', resolve))
          }
        }

      }

      await scenario('copy')
      await scenario('cut')

      // why one format: every write empties the clipboard first
      console.log('\nOne platform format at a time')
      clipboard.writeBuffer(kIdList, Buffer.from([1, 2, 3, 4]))
      clipboard.writeBuffer(kDropEffect, Buffer.from([2, 0, 0, 0]))
      check('a second writeBuffer removes what the first one wrote', [clipboard.has(kIdList), clipboard.has(kDropEffect)], is([false, true]))
      clipboard.writeBuffer(kIdList, Buffer.from([1, 2, 3, 4]))
      clipboard.write({ text: 'text' })
      check('so does a write of the portable formats', [clipboard.has(kIdList), clipboard.readText()], is([false, 'text']))

    } else {

      // the list as the file manager writes it
      const source = makeSource('source')
      const paths = Object.keys(kFiles).map((file) => path.join(source, file))
      const urls = paths.map((file) => require('url').pathToFileURL(file).href)
      const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const lists = process.platform === 'darwin' ? [
        ['NSFilenamesPboardType', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n${paths.map((file) => `\t<string>${xml(file)}</string>`).join('\n')}\n</array>\n</plist>\n`)],
      ] : [
        ['x-special/gnome-copied-files', Buffer.from(`copy\n${urls.join('\n')}`)],
        ['text/uri-list', Buffer.from(`${urls.join('\r\n')}\r\n`)],
      ]

      for (const [format, data] of lists) {
        console.log(`\nA list of files as ${format}`)
        clipboard.writeBuffer(format, data)
        check('the list is on the clipboard', [clipboard.has(format), clipboard.readBuffer(format).equals(data)], is([true, true]))
        const saved = borrow()
        check('the snapshot holds the list of files', [saved.files?.format, saved.files?.data?.equals(data)], is([format, true]))
        check('the automation replaced everything', [clipboard.readText(), clipboard.has(format)], is([kAutomationText, false]))
        restoreClipboard(saved)
        check('the list of files is back', [clipboard.has(format), clipboard.readBuffer(format).equals(data)], is([true, true]))
        info('formats after the restore', clipboard.availableFormats())
        if (process.platform === 'darwin') {
          info('public.file-url after the restore', clipboard.read('public.file-url'))
        }
      }

      console.log('\nNot driven by this probe, to do by hand in the app:')
      console.log(process.platform === 'darwin'
        ? '  copy two files in Finder, run an AI command or Prompt Anywhere with insert, then paste in another Finder window: both files must arrive'
        : '  copy two files in the file manager, run an AI command or Prompt Anywhere with insert, then paste in another folder: both files must arrive')

    }

  } finally {
    restoreClipboard(initial)
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* empty */ }
  }

  console.log(failures ? `\n${failures} check(s) failed` : incomplete ? '\nIncomplete: the files could not be copied with the shell' : '\nAll checks passed')
  app.exit(failures ? 1 : incomplete ? 2 : 0)

}

if (process.versions.electron) {
  probe().catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  launch()
}
