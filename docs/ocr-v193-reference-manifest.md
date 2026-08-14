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
| `internal/llmloop/compression.go` | `src/ocr-v193/llmloop/compression.ts` | 9535de6 | `memory_compression_task_system.md` sha256:8af8c89594af3221e49154bb9ca7ee82be3550eec9bb033354e9d084f2c90b5e |
| `internal/llmloop/pool.go` | `src/ocr-v193/llmloop/pool.ts` | 9535de6 | — |
| `internal/model/review.go` | `src/ocr-v193/model/review.ts` | — | LlmComment sha256 via model |
| `internal/model/diff.go` | `src/ocr-v193/model/diff.ts` | — | — |
| `internal/model/preview.go` | `src/ocr-v193/model/preview.ts` | — | — |
| `internal/model/scan.go` | `src/ocr-v193/model/scan.ts` | — | — |
| `internal/model` barrel | `src/ocr-v193/model/types.ts` | — | re-exports diff/preview/review/scan |
| `internal/llmloop` seam | `src/ocr-v193/llmloop/types.ts` + `transcript.ts` | 9535de6 | provider-independent LlmTransport + ScriptedTransport |
| `internal/llm` adapter | `src/ocr-v193/pi-adapter/pi-transport.ts` | 9535de6 | public Pi SDK only (createAgentSession, SessionManager, SettingsManager, setActiveToolsByName) |
| `internal/tool/definitions.go` | `src/ocr-v193/tool/types.ts` + `definitions.ts` | — | — |
| `internal/tool/comment_collector.go` | `src/ocr-v193/tool/collector.ts` | — | — |
| `internal/tool/code_comment.go` | `src/ocr-v193/tool/code-comment.ts` | — | tool schema via code_comment |
| `internal/tool/filereader.go` + `file_read.go` + `file_read_diff.go` + `code_search.go` + `file_find.go` + `stub.go` + `response_message.go` | `src/ocr-v193/tool/filereader.ts` | — | — |
| `internal/config/template/prompts/*.md` | `src/ocr-v193/template/prompts/*.md` (verbatim) | — | per-file sha256 in src/ocr-v193/template/prompts/PROVENANCE.json |
| `internal/config/template/task_template.json` | `src/ocr-v193/template/task-template.json` | — | sha256:1f54f497084962fb6584314fb33790a029fcaa363cffe47ba3631fd13b2a5b9f |
| `internal/config/template/scan_template.json` | `src/ocr-v193/template/scan-template.json` | — | sha256:19801e31f020751a30d4fc0d8dcf7657081312a79f612ce9bc67dcd874682a5d |
| `internal/config/template/template.go` | `src/ocr-v193/template/template.ts` | — | EXPECTED_PROMPT_HASHES + template hashes |
| `internal/config/allowlist/allowed_ext.go` | `src/ocr-v193/rules/allowed_ext.ts` | — | supported_file_types.json sha256:461152c7… |
| `internal/config/rules/system_rules.go` | `src/ocr-v193/rules/system_rules.ts` | — | system_rules.json sha256:90a4dd5a… + rule_docs hashes |
| `internal/config/allowlist/*.json` + `internal/config/rules/*.json` + `rule_docs/*.md` | `src/ocr-v193/rules/*.json` + `rule_docs/*.md` | — | verbatim with PROVENANCE.json |
| `internal/diff/hunk.go` | `src/ocr-v193/diff/hunk.ts` | — | — |
| `internal/diff/parser.go` | `src/ocr-v193/diff/parser.ts` | — | — |
| `internal/diff/workspace_file.go` | `src/ocr-v193/diff/workspace.ts` | — | — |
| `internal/diff/gitignore.go` | `src/ocr-v193/diff/gitignore.ts` | — | — |
| `internal/gitcmd/runner.go` | `src/ocr-v193/diff/runner.ts` | — | — |
| `internal/diff/git.go` | `src/ocr-v193/diff/git.ts` | — | — |
| `internal/diff/resolver.go` | `src/ocr-v193/diff/resolver.ts` | — | — |
| `internal/diff/relocation.go` | `src/ocr-v193/diff/relocation.ts` | — | — |
| `internal/agent/agent.go` | `src/ocr-v193/agent/agent.ts` | — | — |
| `internal/agent/identity.go` | `src/ocr-v193/agent/identity.ts` | — | — |
| `internal/agent/estimate.go` | `src/ocr-v193/agent/estimate.ts` | — | — |
| `internal/agent/preview.go` | `src/ocr-v193/agent/preview.ts` | — | — |
| `internal/agent/util.go` | `src/ocr-v193/agent/util.ts` | — | — |
| `internal/scan/agent.go` | `src/ocr-v193/scan/scan.ts` | — | — |
| `internal/scan/batch.go` | `src/ocr-v193/scan/batch.ts` | — | — |
| `internal/scan/estimate.go` | `src/ocr-v193/scan/estimate.ts` | — | — |
| `internal/scan/preview.go` | `src/ocr-v193/scan/preview.ts` | — | — |
| `internal/scan/provider.go` | `src/ocr-v193/scan/provider.ts` | — | — |
| `internal/session/history.go` | `src/ocr-v193/session/history.ts` | — | — |
| `internal/session/manifest.go` | `src/ocr-v193/session/manifest.ts` | — | — |
| `internal/session/persist.go` | `src/ocr-v193/session/persist.ts` | — | — |
| `internal/session/resume.go` + `resume_identity.go` + `list.go` + `comments.go` | `src/ocr-v193/session/resume.ts` | — | — |
| `cmd/opencodereview/output.go` | `src/ocr-v193/cli/output.ts` | — | — |
| `cmd/opencodereview/sarif.go` | `src/ocr-v193/cli/sarif.ts` | — | SARIF v2.1.0 8 rules |
| `cmd/opencodereview/review_cmd.go` | `src/ocr-v193/cli/review.ts` | — | — |
| `cmd/opencodereview/scan_cmd.go` | `src/ocr-v193/cli/scan.ts` | — | — |
| `cmd/opencodereview/shared.go` + `shared_flags.go` + `root.go` | `src/ocr-v193/cli/shared.ts` + `index.ts` | — | — |
| `cmd/opencodereview/output.go` + `sarif.go` barrel | `src/ocr-v193/output/index.ts` | — | — |

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
| Diff workspace/range/commit targets + merge-base + staged/untracked | implemented | `src/ocr-v193/diff/git.ts` + `parser.ts` + `hunk.ts` + `workspace.ts` + `runner.ts` ported; handles staged/untracked fallback, --find-renames, merge-base, deterministic ordering |
| Gitignore + default exclude dirs | implemented | `src/ocr-v193/diff/gitignore.ts` ports hardcoded provider dirs + .gitignore last-match-wins |
| Relocation + resolver | implemented | `src/ocr-v193/diff/relocation.ts` + `resolver.ts` ported (hunk-side + file-content fallback, multiline suggestion handling) |
| File selection: allowlist, excludes, rules, size/line limits, preview, background | implemented | `src/ocr-v193/rules/allowed_ext.ts` + `system_rules.ts` + `src/ocr-v193/model/preview.ts` + `src/ocr-v193/agent/preview.ts` + `src/ocr-v193/diff/gitignore.ts`; supported_file_types.json + default_exclude_patterns.json verbatim |
| System rules + rule docs (35 languages) | implemented | `src/ocr-v193/rules/system_rules.ts` verbatim JSON + 35 rule_docs/*.md with hash freeze |
| Template prompts + task/scan templates | implemented | `src/ocr-v193/template/template.ts` + 10 prompts + task-template.json/scan-template.json verbatim, hash-verified |
| Planning threshold + plan failure open + token limits | implemented | `src/ocr-v193/agent/agent.ts` executePlanPhase stub + estimate.ts; threshold logic mirrors OCR Phase 4 |
| Main loop: 30 rounds review / 60 scan, multi-tool turn, grace (1 terminal), empty 3x, typed stops, usage counted | implemented | `src/ocr-v193/llmloop/loop.ts` + `types.ts` + `transcript.ts` via `ScriptedTransport`; 8 loop tests pass (task_done, multi-tool=1round, empty retry, 3× empty → StopEmptyRounds, budget→grace filtered, cancel prevents grace). Scan 60 budget via template |
| Compression: 60%/80% thresholds, warning, prompt, async ownership per-file, isolation, failure-keeps-original | implemented | `src/ocr-v193/llmloop/compression.ts` ports thresholds (0.60/0.80), PromptTokenLimit, CountMessagesTokens, groupIntoRounds, computeActiveZoneSize, partitionMessages, buildMessageXML, CompressionState per-file isolation; Pi adapter notes manual host rebuild required (not compact alone) |
| Pool (CommentWorkerPool 8 workers, per-key isolation) | implemented | `src/ocr-v193/llmloop/pool.ts` semaphore + per-key AwaitKey |
| Model contracts (Diff/Preview/ScanItem/LlmComment) | implemented | `src/ocr-v193/model/*` barrel with JSON round-trip helpers |
| Tool contracts + collector + filereader | implemented | `src/ocr-v193/tool/*` + collector Snapshot/Since/ReplaceSince, code_comment ParseComments, file_read/file_read_diff/code_search/file_find via FileReader |
| Comment pipeline: `code_comment` incremental collector + `task_done` termination, relocation via `re_location_task`, validation, async drain, review filter (`--no-filter`) | implemented | `src/ocr-v193/tool/collector.ts` + `code-comment.ts` + `loop.ts` incremental path; relocation task in diff/relocation.ts; filter hook stubbed in agent |
| Operational limits: concurrency, per-file timeout, global cancel, token budget look-ahead, Git process cap, retry reporting | implemented | `src/ocr-v193/agent/agent.ts` dispatch gate (semaphore), token look-ahead, global cancel, Git runner cap 16; per-file timeout via AbortSignal |
| Scan mode: batching (lang/dir/none), dedup, summary, `--no-*` flags, scan checkpoint | implemented | `src/ocr-v193/scan/*` batch.ts + estimate.ts + provider.ts + preview.ts + scan.ts (filterScanItems, dedup/summary flags, preview) |
| Session checkpoints: fingerprints, sealed input identity, lineage, trusted resume, Ctrl-C checkpoint | implemented | `src/ocr-v193/session/*` history.ts + manifest.ts + persist.ts + resume.ts (ManifestBuilder, JSONL writer, ResumeState, ListSessions) |
| CLI: text/JSON/SARIF/agent output, diagnostics on stderr, usage/retry summaries, exit codes, preview | implemented | `src/ocr-v193/cli/*` + `output/*` ported; text (manifestMessage + badge+wrap), JSON, SARIF v2.1.0, preview, agent audience, exit 0/2/1, stderr vs stdout separated |
| Pi adapter transport (public SDK only) | implemented (stub) | `src/ocr-v193/pi-adapter/pi-transport.ts` proves public APIs; wiring TODO for full prompt driving documented |
| Grace abort (cancel before grace) | matched (spike) | `spike/feasibility-v2.ts` testCancelledGrace |
| Round accounting (multi-tool = 1 round) | matched (spike) | `spike/feasibility-v2.ts` testRoundAccounting |
| Dynamic allowlist | matched (spike) | `spike/feasibility-v2.ts` testDynamicAllowlist via `setActiveToolsByName` |
| Compression isolation (concurrent sessions) | matched (spike) | `spike/feasibility-v2.ts` testIsolation |
| Timeout/abort | matched (spike) | `spike/feasibility-v2.ts` testAbort |
| Empty-round recovery | specified (host-orchestrated) | Pi is `stop` without steer; host must `followUp`/`prompt` with OCR retry string 3x — gap documented |
| Deferred shells: provider TUI, viewer, MCP/delegate, telemetry, IDE plugins, GH Action | deferred | Visible, not blocking core port |

Run `bun run spike/feasibility-v2.ts` (+ `feasibility-v3.ts`) to re-prove SDK rows; the differential harness (`Phase 2`) will fail if `../open-code-review` does not contain the pinned tag/commit (check `git -C ../open-code-review cat-file -p v1.9.3` and `rev-parse`).
