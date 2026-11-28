# Bug hunt + pressure test plan — `bughunt-full/fable`

Scope: Electron main process and its security surface (`src/main/**`, `src/preload.ts`, `forge.config.ts`),
plus any real bug found elsewhere. Platforms: Linux, Windows, macOS, each on x64 and arm64.
Deliverables: bug list (no fixes), new stress/fuzz/edge-case tests, mobile-port blockers section.

Estimates are agent wall-clock minutes, measured from the start of the run (23:32 UTC, 2026-11-27).
They are rough: the test suite duration and the number of findings that need verification are the two unknowns.
Items marked `sub-agent` run in parallel with the items owned by `lead`.

Started: 23:32 UTC. Estimated finish: about 02:30 UTC (about 180 minutes total). Revised at 00:10 UTC: about 01:00 UTC (the suite runs in 90 s, not the 10 min assumed, and the audits finished early).

## Work breakdown

| # | Item | Owner | Parallel group | Estimate (min) | Status | % |
|---|------|-------|----------------|----------------|--------|---|
| 0 | Environment: branch, `npm ci` (needs `libevdev-dev`, CUDA download skipped) | lead | A | 15 | done | 100 |
| 1 | Baseline: lint + full vitest suite, 3 runs, record failures and flakes | lead | B (after 0) | 30 | done | 100 |
| 2 | Audit: IPC, preload, windows/webPreferences, fuses, `file.ts`, `shell.ts`, `cli_plugin.ts`, `mcp.ts`, `mcp_auth.ts`, `config.ts` (secret storage), `network.ts`, `main.ts` | lead | A | 45 | done | 100 |
| 3 | Audit: persistence modules (history, agents, workspace, scratchpad, experts, commands, backup, imports, skills, memory, migrations) | sub-agent S1 | A | 25 | done | 100 |
| 4 | Audit: network-facing main (HTTP server/API/triggers/webhook, assistant API, scheduler, pyodide, ollama, search, google, youtube, text, pdf, autoupdate) and `src/cli/**`, `cli_installer.ts` | sub-agent S2 | A | 25 | done | 100 |
| 5 | Audit: RAG (`src/main/rag/**`) | sub-agent S3 | A | 20 | done | 100 |
| 6 | Audit: OS integration per platform (automations, keymonitor, shortcuts, tray, menu, `windows/*`, permissions, computer use) | sub-agent S4 | A | 25 | done | 100 |
| 7 | Audit: packaging and platform x arch matrix (forge makers, `build/**`, Makefile, workflows, npm scripts, native modules/prebuilds, entitlements, signing/notarization) | sub-agent S5 | A | 25 | done | 100 |
| 8 | Audit: renderer to main trust boundary (HTML/markdown sanitisation, link handling, webview, renderer plugins that call `window.api`) | sub-agent S6 | A | 25 | done | 100 |
| 9 | Mobile port (Android/iOS) blockers inventory | sub-agent S7 | A | 20 | done | 100 |
| 10 | Verify every sub-agent finding against the code, dedupe, assign severity and platform+arch tags | lead | C (after 3-9) | 25 | in-progress | 60 |
| 11a | Tests, lead: cli plugin, shell, mcp, config/keys, file, network inspector, local http server + OAuth callback, IPC harness, Ollama downloader, file monitor, packaging static checks | lead | D (after 1) | 40 | done | 100 |
| 11b | Tests, persistence (`persist_*`) | sub-agent S1 | D | 20 | in-progress | 10 |
| 11c | Tests, HTTP API / triggers / webhook / scheduler / CLI (`http_*`, `cli_*`) | sub-agent S2 | D | 20 | in-progress | 10 |
| 11d | Tests, RAG (`rag_*`) | sub-agent S3 | D | 20 | in-progress | 50 |
| 11e | Tests, OS integration (`os_*`) | sub-agent S4 | D | 20 | in-progress | 30 |
| 11f | Tests, renderer trust boundary (`trust_*`) | sub-agent S6 | D | 20 | in-progress | 50 |
| 12 | Post-change runs: lint + full vitest suite, 3 runs with the new tests; separate new failures from baseline | lead | E (after 11) | 25 | todo | 0 |
| 13 | Commit tests (author Kevin Patel), push branch, final report | lead | F | 10 | in-progress | 40 |

Critical path: 0 -> 1 -> 11 -> 12 -> 13 (about 120 min) with 2-10 running alongside; total about 180 min including verification.

## Rules for this run

- Only new tests and this plan are committed. No fixes. No history rewrite. `main` and `cursor/venice-video-6c23` untouched.
- No network calls to paid APIs, no OS-destructive actions in tests; everything is mocked or runs in a temp directory.
- Sub-agents audit read-only while the baseline runs, so the baseline is not polluted by half-written test files.
- Venice video code is skipped unless something new shows up.

## Status log

- 23:32 branch created; `npm ci` failed twice on this VM (missing `libevdev-dev`; onnxruntime CUDA download blocked), third attempt running.
- 23:40 plan written; sub-agents S1-S7 launched.
- 23:50 baseline done: lint clean; 3 vitest runs, each 25 failed / 3704 passed / 1 skipped (3730), same 25 failures every run, all in the known Linux list; no flakes.
- 23:55 audits S3, S4, S6, S7 reported; lead tests for cli plugin, shell, mcp, config, file committed.
- 00:02 audits S1, S2, S5 reported; S1-S4 and S6 resumed in parallel to write tests for their own areas (one file prefix each).
- 00:10 lead tests for network inspector, http server/OAuth, IPC harness, Ollama, monitor, packaging committed.
