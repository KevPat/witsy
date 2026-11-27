# Bug hunt plan — `bughunt-full/grok`

Base: `cursor/venice-video-6c23` (`477fb34a`). No fixes in this branch. New commits are tests plus this plan. Author: Kevin Patel. No pull request. Do not touch `main` or `cursor/venice-video-6c23`.

Venice video (`venice_video.ts` and its tests) stays out of scope unless a new defect shows up outside the download-url fix already landed.

## Time

Estimates are focused agent time, not calendar days. Parallel rows run together, so wall-clock is the critical path, not the sum.

| | minutes |
| --- | ---: |
| Effort already spent (survey, first-pass reads) | 50 |
| Remaining effort if the rows below were serial | 280 |
| **Wall-clock ETA from this plan** | **about 110 minutes** |
| **Total ETA from the start of the hunt** | **about 2 hours 40 minutes** |

The uncertain part is the full Vitest suite. Each run is budgeted at 12 minutes. If a run is slower, the ETA moves by the same amount.

## Work breakdown

| ID | Work | Estimate | Status | % | Parallel |
| --- | --- | ---: | --- | ---: | --- |
| P0 | Branch `bughunt-full/grok`, scope lock (platforms, x64/arm64, mobile note, no fixes) | 15m | done | 100 | no |
| P1 | LLM manager, model load, chat/streaming, tool loop (`llms/`, `assistant.ts`, `generator.ts`, `llm_utils.ts`) | 40m | done | 100 | yes |
| P2 | Renderer plugins (`filesystem`, `python`, `code_exec_*`, `memory`, `skills`, `mcp`, `search`, `computer`) | 40m | done | 100 | yes |
| P3 | Agents, workflow runner, deep research, prompt substitution, scratchpad | 35m | done | 100 | yes |
| P4 | History, settings migrations, API-key safeStorage, docrepo/RAG, embeddings, memory DB | 40m | done | 100 | yes |
| P5 | Image/video/TTS/STT, commands, prompt anywhere, i18n data | 30m | done | 100 | yes |
| P6 | Platform pass: Windows paths/CRLF/shell quoting/file locks, Linux keyring and paths, macOS AppleScript/keychain/case-insensitive FS/permissions | 35m | done | 100 | yes |
| P7 | Arch pass: x64 and arm64 on Linux, Windows, macOS (Ollama installer URL, onnxruntime purge, Pyodide WASM, libnut/autolib) | 25m | done | 100 | yes |
| P8 | Mobile note: which renderer services/plugins need Node or Electron and would block Android/iOS, with rough effort | 20m | done | 100 | yes |
| P9 | Stress/fuzz/edge tests for the riskiest paths. Network mocked. No secrets | 45m | done | 100 | after P1–P3 findings |
| P10 | `npm run lint`, then full Vitest three times. Separate new failures from the known Linux baseline (25) | 50m | done | 100 | after P9 |
| P11 | Commit tests (and this plan), push `bughunt-full/grok`, no PR. Final bug table with platform+arch | 20m | done | 100 | no |

## Pressure test (filled in)

Lint (`npm run lint`): exit 0. ESLint, vue-tsc, and Stylelint all clean.

Vitest (`npm run test:ai`), three runs, same 25 failures each time (no flakes, no new failures):

| Run | Duration | Files | Tests |
| --- | ---: | --- | --- |
| 1 | 90.83s | 4 failed, 211 passed (215) | 25 failed, 3725 passed, 1 skipped (3751) |
| 2 | 89.48s | 4 failed, 211 passed (215) | 25 failed, 3725 passed, 1 skipped (3751) |
| 3 | 90.23s | 4 failed, 211 passed (215) | 25 failed, 3725 passed, 1 skipped (3751) |

The 25 failures are the known Linux baseline: `keymonitor.test.ts`, `automator.test.ts`, `window.test.ts` “Close command picker window”, and the two `cli_plugin` `lastModified` checks. The new stress tests are in the passing set.

## Addendum (late audit pass)

Confirmed after the first report. Same platform tag: “all” means Linux, Windows, and macOS, x64 and arm64. No production fixes.

| Severity | Platforms | Location | What goes wrong | Fix | Easy |
| --- | --- | --- | --- | --- | --- |
| High | All | `src/renderer/services/assistant.ts:237` | Streaming fallback sets `chat.disableStreaming` but retries `_prompt` with the same `opts.streaming === true`, so the non-streaming path never runs. The workflow executor does set `opts.streaming = false`. | Set `opts.streaming = false` before the second `_prompt`. | Yes |
| High | All | `src/main/file.ts:439` | `path.join(defaultPath, filename)` does not keep the result under `defaultPath`. A save name such as `../../outside` writes outside the intended directory. Callers pass attachment titles and agent names. | `path.basename`, then resolve and reject anything outside `defaultPath`. | Yes |
| High | All | `src/renderer/services/deepresearch_al.ts:152` | `getChatModel(...).id` throws when the favorite or catalog row is missing, before the research run can report an error. | Optional-chain and fail the run as invalid model. | Yes |
| Medium | All | `src/renderer/services/message_block_parser.ts:93` and `src/renderer/components/MessageItemBodyBlock.vue:89` | In-chat search compiles the raw query as a `RegExp`. A pattern like `(` throws and breaks that message’s render. | Escape metacharacters, or catch and search literally. | Yes |
| Medium | All | `src/main/automations/commander.ts:102`, `Prompt.vue:636`, `AudioBooth.vue:690` | `replace('{input}', text)` replaces only the first placeholder, and `$&` / `$$` in the selection are treated as replacement patterns. | `replaceAll` with a function replacer. | Yes |
| Medium | All | `src/renderer/services/generator.ts:380` | If the provider says streaming is required while streaming is already on, `generate` calls itself with the same options. | Retry only when `opts.streaming === false`, and cap at one retry. | Yes |
| Medium | All | `src/renderer/services/video.ts:81` | `cancel()` only aborts `activeAbort`, and only `venice()` assigns it. OpenAI, Google, Replicate, and Fal polls keep running. | One abort controller checked by every provider loop. | No |
| Medium | All | `src/renderer/services/plugins/browse.ts:89` | `fetch` ignores `context.abortSignal`, so a canceled chat still downloads the URL. | Pass `{ signal: context.abortSignal }`. | Yes |

Rejected from that pass: the title-strip regex in `llm_utils.ts:197` is a matched `<think>…</think>` pair, not a mismatched tag. Corrupt `history.json` does not crash the renderer; `store.ts:348` catches the throw and leaves the empty history set just above. `POST /api/conversations` hits the route’s `try/catch` and returns 500.

## Already confirmed, still being cross-checked

These are in the report unless a later read disproves them. Severity and platforms are filled in the final table.

- Filesystem and CLI working-dir checks use `startsWith` without a path boundary (sibling directory escape). Symlinks are not resolved on the filesystem plugin or skills reader.
- `Generator` writes `model.capabilities.tools = true` on the stored model object.
- Agent workflow rebuilds `opts` with a spread that lets the previous step’s `structuredOutput` overwrite the next step.
- `replacePromptInputs` builds a `RegExp` from the variable name and uses `String.replace`, so `$&` in a value is rewritten and a name like `a(b` throws.
- `saveApiKeys` deletes stored keys first and still returns success if a later encrypt fails; `saveSettings` then strips those keys from `settings.json`. Decrypt failure deletes that key.
- Local Whisper `transcribe` never settles the promise when decode or the model call throws.
- Linux arm64 Ollama download URL is hard-coded to `ollama-linux-amd64`.
- macOS `getForemostApp` AppleScript requires a window and is not caught by Prompt Anywhere, so the palette does not open. Window titles are escaped with `\"`, which is not AppleScript’s quote escape.
- `purgeOnnxRuntime` has no `win32` + `arm64` branch.
- Memory retrieval uses the default relevance cutoff, not the user’s RAG setting.

## Baseline the pressure test must not mix in

Known pre-existing Linux failures (25): `keymonitor.test.ts`, `automator.test.ts`, `window.test.ts` “Close command picker window”, two `cli_plugin` `lastModified` checks. Anything else is new or flaky.

## Rules for the rest of the pass

- Mock network. Do not call paid APIs. Do not commit secrets.
- Tests may lock current safe behavior and stress edges. Do not commit production fixes.
- Tag every bug with Linux / Windows / macOS and x64 / arm64 (or “all”).
- Update this status column when a row finishes.
