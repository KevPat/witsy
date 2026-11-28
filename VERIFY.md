# Verification suites

`npm run verify` builds the app the way it ships (`electron-forge package`) and checks, on the real
packaged binaries, what used to be checked by hand before a release. Every suite has its own script,
`npm run verify:<suite>`, and writes a machine-readable report.

```
npm run verify                 # every suite (builds what is missing)
npm run verify:build           # (re)build the three packaged variants only
npm run verify:<suite>         # one suite
node tools/verify.mjs a b c    # several suites; --rebuild to package again, --no-build to never package
```

- **Builds** go to `verify-builds/<variant>/Witsy-<platform>-<arch>`:
  - `release`: what users get.
  - `release-node`: built with `WITSY_CLI_RUNTIME=node`.
  - `test`: built with `TEST=1`. It only differs by the `--inspect` fuse, so Playwright can drive it.
  - On macOS without `IDENTIFY_DARWIN_CODE`, builds are unsigned and not notarized (`WITSY_UNSIGNED=1`).
- **Reports** go to `verify-report/`:
  - `<suite>.json`: the vitest JSON results.
  - `<suite>.details.json`: what the suite measured.
  - `summary.json`, or `summary-<suites>.json` for a partial run: builds, suites, counts and failures.
  - `artifacts/<suite>/`: screenshots and exported files.
  - The exit code is 0 only when every build and suite passed.
- **Isolation:**
  - Every app run gets a fresh `WITSY_HOME` and `--user-data-dir` in the temporary folder, so your own settings, history and key store are never read or written.
  - Native dialogs are answered by the suite.
  - Only dummy keys are used (`DUMMY_KEYS` in `tests/verify/harness.ts`), and every report is scanned so that none of them leaks.
- **Linux:** the suites re-run themselves under `xvfb-run` when there is no display. Install `xvfb`, `xclip` (clipboard suite), `unzip` and `poppler-utils` (pdf suite).
- **CI:** `.github/workflows/verify.yml` runs every suite on `macos-latest`, with no signing secrets, and uploads `verify-report/`.

| suite | replaces the by-hand check | what it checks |
| --- | --- | --- |
| `package` | S-15 fuses, packaging | **Fuses:** reads the fuses of the release, release-node and test binaries.<br>**On the real binaries:** RunAsNode works (CLI); `NODE_OPTIONS` cannot load code; `--inspect` gives no debugger on release.<br>**Release build:** starts and answers `/api/health`.<br>**app.asar:** holds every runtime dependency and no dev dependency or key file.<br>**officeparser 8:** officeparser 8, its pdfjs-dist 6.5, tesseract.js and the optional native `@napi-rs/canvas` are packaged and load. The packaged app extracts text from docx, pptx, xlsx and pdf.<br>**Size:** packaged size is recorded.<br>**CLI:** the CLI runtime file is right, and `bin/witsy --help` runs. |
| `smoke` | e2e / build and launch | Launch, main window and settings screen; webPreferences (contextIsolation, sandbox, no nodeIntegration); CSP present; no CSP refusal or error at startup. Screenshots are saved. |
| `security` | S-14 CSP and HTML artifacts | **CSP blocks:** inline handlers, inline scripts, `javascript:` links, and remote or local scripts.<br>**witsy-artifact scheme:** returns 200 / 404 / 404 / 405.<br>**HTML artifacts:** they run in a sandboxed frame without allow-same-origin. They cannot read local files, show local images, reach their parent or use storage.<br>**Other:** Copy code works; the `web_security_probe` passes. |
| `pdf` | L-05 PDF export | **Export:** export a chat as PDF from the chat menu.<br>**The file:** `%PDF`; text, list, table and code are present; the PDF is tagged; page 1 has ink.<br>**Safety:** the print window runs no script, and no temporary files are left. |
| `crash` | D-15 renderer crash and reload | **First crash:** the main window reloads after a renderer crash.<br>**Second crash:** a second crash right after closes it instead of looping.<br>**Other windows:** a secondary window whose renderer dies is closed. |
| `watcher` | L-01 Linux watcher | An open file is followed through:<ul><li>an in-place write</li><li>atomic replaces (editors)</li><li>delete and recreate</li><li>a burst of 10 writes</li></ul> |
| `backup` | D-27 backup/restore without keys | **Export:** export on machine A with dummy keys; the zip holds no key.<br>**Restore:** restoring on machine B keeps B's own key store and key.<br>**Old backups:** an old-format backup restores no key. |
| `mcp` | S-12 MCP stdio | stdio MCP servers started through `node` and `npx` (and `cmd /c` with special characters on Windows); the argv the server gets. |
| `clipboard` | D-22 clipboard | **Snapshot:** the clipboard snapshot probe passes.<br>**Linux:** another program (xclip) reads the files, URI list and HTML that Witsy copies. |
| `sandbox` | S-16 Python sandbox | The Pyodide sandbox probe passes. |
| `archiver` | P-06 archiver 7 → 8 | Differential: the same inputs zipped by archiver 7.0.1 and 8 the way `backup.ts` does. Compares entries, sizes, CRC, method, dates, modes, extracted bytes and `unzip -t`. |
| `rfc6902` | P-06 rfc6902 3 → 5 | **Differential:** `recreateTransform` (note editor) with rfc6902 3.1.1 and 5 on 600 seeded markdown edits with the editor schema. Steps and outcomes must be identical.<br>**Prototype pollution:** 5.x cannot reach `Object.prototype`. |
| `cli` | Windows CLI launchers | **Shells:** `witsy.cmd` and `witsy.ps1` under cmd.exe, Windows PowerShell 5.1 and PowerShell 7 (portable copy in the temp folder when pwsh is missing).<br>**Installs:**<ul><li>a zip install behind a path with spaces, `( ) % ! &`</li><li>Squirrel `app-X.Y.Z` selection, numeric: 1.10.0 over 1.9.0</li><li>the node runtime build, with and without Node.js on the PATH</li></ul>**Behavior:** exit codes, and nothing is run from the current folder. |

## What is still checked by hand, and why

- **macOS on a real Mac, with signing and notarization:**
  - The CI job runs the suites on an unsigned build.
  - Developer ID signing, notarization and Gatekeeper on a downloaded DMG need the Apple secrets and a person.
- **D-04 Audio Booth "Insert" into the foreground app:**
  - It types into another app through OS automation and needs microphone permission.
  - A virtual display cannot show that the text landed in the other app.
- **U-06 Linux window focus under a real desktop (GNOME/KDE):** xvfb has no window manager focus rules.
- **Pasting files into a real file manager (Explorer, Finder, Nautilus):** the clipboard suite checks the formats another program reads, not the GUI paste.
- **Windows arm64:** needs an arm64 machine or runner.
