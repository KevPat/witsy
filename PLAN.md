# Witsy whole-repository bug hunt plan

Calendar-time estimates are intentionally omitted. Effort is expressed as relative size and concrete completion gates.

| Work item | Scope / completion gate | Effort | Status | Complete |
|---|---|---:|---|---:|
| Repository setup and baseline capture | Create `bughunt-full/gpt`; preserve source; install locked dependencies; capture initial lint result | S | done | 100% |
| UI/state/accessibility/i18n audit | Vue screens, settings, composables, store, shortcuts, listeners/timers, keyboard and accessibility; verified findings only | L | done | 100% |
| Rendering security audit | Markdown, `v-html`, HTML artifacts, Mermaid, KaTeX, link handling, Electron renderer boundaries | L | done | 100% |
| Dependency audit | `npm audit`, outdated direct dependencies, reachability and upgrade guidance | M | done | 100% |
| Linux x64/arm64 review | Tests, scripts, native dependencies, package targets, DEB/RPM/ZIP coverage | M | done | 100% |
| Windows x64/arm64 review | `cmd.exe` npm-script compatibility, PowerShell build, native/cross packaging, Squirrel/ZIP and signing | M | done | 100% |
| macOS x64/arm64 review | Shortcuts/menus, universal/native assets, signing, entitlements, notarization, DMG/ZIP workflows | M | done | 100% |
| Test-infrastructure diagnosis | Explain Linux 25-failure baseline and Windows 67–69 failures; separate infrastructure errors, real failures and flakes | M | done | 100% |
| Three full Linux Vitest passes | Three unchanged-baseline runs with counts and flake comparison | L | done | 100% |
| Focused edge/stress tests | Add tests only for highest-risk rendering, path-boundary, regex and cross-platform behavior; no product fixes | M | done | 100% |
| Final verification | Required lint, focused tests and full-suite verification after test additions; inspect test-only/doc diff | M | done | 100% |
| CI matrix and mobile assessment | Six platform/architecture targets, native versus cross strategy, makers/signing; Capacitor feasibility and blockers | M | done | 100% |
| Delivery | Update this status table; commit with requested author; push branch; no pull request; concise final report | S | done | 100% |

Overall completion: **100%**

## Parallel ownership

- UI/state/accessibility review worker
- Rendering security/i18n review worker
- Build/test-infrastructure review worker
- Linux x64/arm64 packaging review worker
- Windows x64/arm64 packaging and test-portability review worker
- macOS x64/arm64 signing, notarization, shortcut and menu review worker

## Completion

The audit, three unchanged baseline runs, test-only regression additions, final
verification, six-target CI proposal, and mobile feasibility assessment are complete.
