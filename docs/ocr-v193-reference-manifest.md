# OCR v1.9.3 reference manifest

Fixed reference for every translated file, per `docs/ocr-v1.9.3-port-plan.md` Phase 2.

## Pinned reference

- Release: https://github.com/alibaba/open-code-review/releases/tag/v1.9.3
- Tag: `v1.9.3`
- Signed tag object: `4d796ae54cabdcf4e22b69ef502ed8871456a909` (`git cat-file -p v1.9.3`)
- Commit: `c35ddd7223f2b5540ce03aa43c9a25ef643fca27` (`git rev-parse v1.9.3^{commit}`)
- Local checkout: `../open-code-review` (must contain tag+commit; harness fails otherwise)
- Go: `go1.26.6` (per `manifest_hash_test.go` / Go image bump in tag notes)
- Bun: `>=1.3.0` (package.json `engines`)
- Pi SDK: `@earendil-works/pi-coding-agent` `0.84.2` (was `0.82.1`, see `docs/pi-sdk-feasibility-report.md` bump note)

## Port vectors (source -> dest, to be filled as files land)

| OCR path | Dest path | Port commit | Prompt/template/schema/fixture hashes |
|---|---|---|---|
| `internal/llmloop/loop.go` | `src/ocr-v193/llmloop/loop.ts` | 9535de6 | — |
| `internal/llmloop/compression.go` | `src/ocr-v193/llmloop/compression.ts` | 9535de6 | `memory_compression_task_system.md` sha256:… (stub; full XML host rebuild in Pi adapter) |
| `internal/llmloop/pool.go` | `src/ocr-v193/llmloop/pool.ts` | 9535de6 | — |
| `internal/model/review.go` | `src/ocr-v193/model/types.ts` | 9535de6 | minimal LlmComment port |
| `internal/llmloop` seam | `src/ocr-v193/llmloop/types.ts` + `transcript.ts` | 9535de6 | provider-independent LlmTransport + ScriptedTransport |
| `internal/llm` adapter | `src/ocr-v193/pi-adapter/pi-transport.ts` | 9535de6 | public Pi SDK only (createAgentSession, SessionManager, SettingsManager, setActiveToolsByName) |
| `internal/tool/code_comment.go` | `src/ocr-v193/tool/code-comment.ts` | — | tool schema sha256:… |
| `internal/tool/comment_collector.go` | `src/ocr-v193/tool/collector.ts` | — | — |
| `internal/config/template/prompts/*.md` | `src/ocr-v193/template/prompts/*.md` (verbatim) | — | per-file sha256 + golden tests |
| `internal/config/template/task_template.json` | `src/ocr-v193/template/task-template.json` | — | sha256:… |
| `internal/config/template/scan_template.json` | `src/ocr-v193/template/scan-template.json` | — | sha256:… |
| *(expand per source-map)* | | | |

Hash discipline: every imported prompt/template/tool-schema/default-rule/output-schema/fixture gets a sha256 in this table; `bun test` fails if file bytes diverge.

## Upstream test coverage index

| Port test file | OCR test names represented | Status |
|---|---|---|
| `test/ocr-v193/llmloop/loop.test.ts` | `TestRunPerFile_TaskDoneSuccess`, `MultiToolTurnIsOneRound`, `EmptyToolCallsRetry`, `ThreeConsecutiveEmptyResults`, `MaxRoundsGrace`, `CancelPreventsGrace`, `CompressionThreshold`, `GraceRoundToolDefs` in `internal/llmloop/loop_test.go` | implemented (8 pass) |
| `test/ocr-v193/llmloop/compression.test.ts` | `TestCompression*` in `compression_test.go` | — (thresholds + partition covered via loop tests; dedicated file TBD) |
| `test/ocr-v193/diff/parser.test.ts` | `TestParser*` in `internal/diff/parser_test.go` | — |
| *(expand as tests land; omission needs reason in parity matrix)* | | |

## Parity matrix

`matched` means OCR-vs-Pi differential fixture passes field-for-field; `deviates` is an approved, measured, documented deviation (never labeled parity); `specified` = source-mapped+tests written; `implemented`; `unexamined` = not yet considered.

| Capability | Status | Evidence / issue |
|---|---|---|
| Diff workspace/range/commit targets + merge-base + staged/untracked | unexamined | |
| File selection: allowlist, excludes, rules, size/line limits, preview, background | unexamined | |
| Planning threshold + plan failure open + token limits | unexamined | |
| Main loop: 30 rounds review / 60 scan, multi-tool turn, grace (1 terminal), empty 3x, typed stops, usage counted | implemented | `src/ocr-v193/llmloop/loop.ts` + `types.ts` + `transcript.ts` via `ScriptedTransport`; 8 loop tests pass (task_done, multi-tool=1round, empty retry, 3× empty → StopEmptyRounds, budget→grace filtered, cancel prevents grace). Still stub: diff re-location + retry identity + full scan budget (60) param |
| Compression: 60%/80% thresholds, warning, prompt, async ownership per-file, isolation, failure-keeps-original | implemented | `src/ocr-v193/llmloop/compression.ts` ports thresholds (0.60/0.80), PromptTokenLimit, CountMessagesTokens, groupIntoRounds, computeActiveZoneSize, partitionMessages, buildMessageXML, CompressionState per-file isolation; Pi adapter notes manual host rebuild required (not compact alone) |
| Comment pipeline: `code_comment` incremental collector + `task_done` termination, relocation via `re_location_task`, validation, async drain, review filter (`--no-filter`) | unexamined | Legacy `submit_review`+verifier not on parity path |
| Operational limits: concurrency, per-file timeout, global cancel, token budget look-ahead, Git process cap, retry reporting | unexamined | `pi-runner.ts` start-budget ≠ OCR round budget; must replace |
| Scan mode: batching (lang/dir/none), dedup, summary, `--no-*` flags, scan checkpoint | unexamined | |
| Session checkpoints: fingerprints, sealed input identity, lineage, trusted resume, Ctrl-C checkpoint | unexamined | |
| CLI: text/JSON/SARIF/agent output, diagnostics on stderr, usage/retry summaries, exit codes, preview | unexamined | |
| Grace abort (cancel before grace) | matched (spike) | `spike/feasibility-v2.ts` testCancelledGrace |
| Round accounting (multi-tool = 1 round) | matched (spike) | `spike/feasibility-v2.ts` testRoundAccounting |
| Dynamic allowlist | matched (spike) | `spike/feasibility-v2.ts` testDynamicAllowlist via `setActiveToolsByName` |
| Compression isolation (concurrent sessions) | matched (spike) | `spike/feasibility-v2.ts` testIsolation |
| Timeout/abort | matched (spike) | `spike/feasibility-v2.ts` testAbort |
| Empty-round recovery | specified (host-orchestrated) | Pi is `stop` without steer; host must `followUp`/`prompt` with OCR retry string 3x — gap documented |
| Deferred shells: provider TUI, viewer, MCP/delegate, telemetry, IDE plugins, GH Action | deferred | Visible, not blocking core port |

Run `bun run spike/feasibility-v2.ts` (+ `feasibility-v3.ts`) to re-prove SDK rows; the differential harness (`Phase 2`) will fail if `../open-code-review` does not contain the pinned tag/commit (check `git -C ../open-code-review cat-file -p v1.9.3` and `rev-parse`).
