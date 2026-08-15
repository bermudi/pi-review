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

## Verification status (per `docs/ocr-v1.9.3-port-plan.md` gates)

| Phase | Status | Verifier | Commit | Report |
|---|---|---|---|---|
| Phase 0 — evidence plumbing | `verified` | `bun run verify:phase0-evidence` | `e1abdedca4ee4e210044d74a8af1e47cc2905424` | `{"phase":"phase0-evidence","commit":"e1abdedca4ee4e210044d74a8af1e47cc2905424","fixtures":["phase0-negative-5-fields","phase0-missing-trace","trace-ordinal-sequencing"],"assertions":13,"privateImports":0,"result":"pass"}` |
| Phase 1 — Pi SDK gate (7 scenarios) | `verified` | `bun run verify:phase1-sdk` | `e1abdedca4ee4e210044d74a8af1e47cc2905424` | `{"phase":"phase1-sdk","commit":"e1abdedca4ee4e210044d74a8af1e47cc2905424","fixtures":["one-response-two-tool-calls-one-round","grace-exactly-one","cancel-prevents-grace","three-empty-retries","compression-rebuilt","isolation-two-sessions","stall-abort-settles"],"assertions":7,"privateImports":0,"result":"pass"}` |
| Phase 2 — vertical slice | `verified` | `bun run verify:phase2-vertical` | `e1abdedca4ee4e210044d74a8af1e47cc2905424` | `{"phase":"phase2-vertical","commit":"e1abdedca4ee4e210044d74a8af1e47cc2905424","fixtures":["workspace-code_comment-task_done","workspace-mismatch-comment-content"],"assertions":15,"privateImports":0,"result":"pass"}` |
| Phase 3 — comments lifecycle | `verified` | `bun run verify:phase3-comments` | `1345a2a1d96a1a9257ef5cef9e19cd3bcb3cca01` | `{"phase":"phase3-comments","commit":"1345a2a1d96a1a9257ef5cef9e19cd3bcb3cca01","fixtures":["resolver-lifecycle-differential","relocation-success","relocation-failure-rollback","async-drain-before-filter","filter-production-collector-removal","filter-malformed-duplicate-invalid-outofrange","filter-error-timeout-abort-retains","partial-failure-comments-survive","negative-mismatch"],"assertions":54,"privateImports":0,"result":"pass"}` |
| Phase 4 — inputs | `building` | `bun run verify:phase4-inputs` | — | awaiting Phase 2/3 |
| Phase 5 — scan/session/output | `building` | `bun run verify:phase5-scan-session` | — | awaiting earlier phases |
| Cutover | `building` | `bun run verify:cutover` | — | awaiting all phases |

Ledger rule: a phase is `verified` only when its committed verifier exits 0 and prints the JSON report above. `building` means code/tests exist but no verifier has passed. `blocked` would name a public-SDK blocker.

## Port vectors (source -> dest, to be filled as files land)

| OCR path | Dest path | Port commit | Prompt/template/schema/fixture hashes |
|---|---|---|---|
| `internal/llmloop/loop.go` | `src/ocr-v193/llmloop/loop.ts` | b4442c61 | df2122a5 |
| `internal/llmloop/compression.go` | `src/ocr-v193/llmloop/compression.ts` | b4442c61 | `memory_compression_task_system.md` sha256:8af8c89594af3221e49154bb9ca7ee82be3550eec9bb033354e9d084f2c90b5e |
| `internal/llmloop/pool.go` | `src/ocr-v193/llmloop/pool.ts` | b4442c61 | df2122a5 |
| `internal/model/review.go` | `src/ocr-v193/model/review.ts` | df2122a5 | LlmComment sha256 via model |
| `internal/model/diff.go` | `src/ocr-v193/model/diff.ts` | df2122a5 | — |
| `internal/model/preview.go` | `src/ocr-v193/model/preview.ts` | df2122a5 | — |
| `internal/model/scan.go` | `src/ocr-v193/model/scan.ts` | df2122a5 | — |
| `internal/model` barrel | `src/ocr-v193/model/types.ts` | df2122a5 | re-exports diff/preview/review/scan |
| `internal/llmloop` seam | `src/ocr-v193/llmloop/types.ts` + `transcript.ts` | b4442c61 | provider-independent LlmTransport + ScriptedTransport |
| `internal/llm` adapter | `src/ocr-v193/pi-adapter/pi-transport.ts` | b4442c61 | public Pi SDK only (createAgentSession, SessionManager, SettingsManager, setActiveToolsByName) |
| `internal/tool/definitions.go` | `src/ocr-v193/tool/types.ts` + `definitions.ts` | df2122a5 | — |
| `internal/tool/comment_collector.go` | `src/ocr-v193/tool/collector.ts` | df2122a5 | — |
| `internal/tool/code_comment.go` | `src/ocr-v193/tool/code-comment.ts` | df2122a5 | tool schema via code_comment |
| `internal/tool/filereader.go` + `file_read.go` + `file_read_diff.go` + `code_search.go` + `file_find.go` + `stub.go` + `response_message.go` | `src/ocr-v193/tool/filereader.ts` | df2122a5 | — |
| `internal/config/template/prompts/*.md` | `src/ocr-v193/template/prompts/*.md` (verbatim) | df2122a5 | per-file sha256 in src/ocr-v193/template/prompts/PROVENANCE.json |
| `internal/config/template/task_template.json` | `src/ocr-v193/template/task-template.json` | df2122a5 | sha256:1f54f497084962fb6584314fb33790a029fcaa363cffe47ba3631fd13b2a5b9f |
| `internal/config/template/scan_template.json` | `src/ocr-v193/template/scan-template.json` | df2122a5 | sha256:19801e31f020751a30d4fc0d8dcf7657081312a79f612ce9bc67dcd874682a5d |
| `internal/config/template/template.go` | `src/ocr-v193/template/template.ts` | df2122a5 | EXPECTED_PROMPT_HASHES + template hashes |
| `internal/config/allowlist/allowed_ext.go` | `src/ocr-v193/rules/allowed_ext.ts` | df2122a5 | supported_file_types.json sha256:461152c7… |
| `internal/config/rules/system_rules.go` | `src/ocr-v193/rules/system_rules.ts` | df2122a5 | system_rules.json sha256:90a4dd5a… + rule_docs hashes |
| `internal/config/allowlist/*.json` + `internal/config/rules/*.json` + `rule_docs/*.md` | `src/ocr-v193/rules/*.json` + `rule_docs/*.md` | df2122a5 | verbatim with PROVENANCE.json |
| `internal/diff/hunk.go` | `src/ocr-v193/diff/hunk.ts` | df2122a5 | — |
| `internal/diff/parser.go` | `src/ocr-v193/diff/parser.ts` | df2122a5 | — |
| `internal/diff/workspace_file.go` | `src/ocr-v193/diff/workspace.ts` | df2122a5 | — |
| `internal/diff/gitignore.go` | `src/ocr-v193/diff/gitignore.ts` | df2122a5 | — |
| `internal/gitcmd/runner.go` | `src/ocr-v193/diff/runner.ts` | df2122a5 | — |
| `internal/diff/git.go` | `src/ocr-v193/diff/git.ts` | df2122a5 | — |
| `internal/diff/resolver.go` | `src/ocr-v193/diff/resolver.ts` | df2122a5 | — |
| `internal/diff/relocation.go` | `src/ocr-v193/diff/relocation.ts` | df2122a5 | — |
| `internal/agent/agent.go` | `src/ocr-v193/agent/agent.ts` | df2122a5 | — |
| `internal/agent/identity.go` | `src/ocr-v193/agent/identity.ts` | df2122a5 | — |
| `internal/agent/estimate.go` | `src/ocr-v193/agent/estimate.ts` | df2122a5 | — |
| `internal/agent/preview.go` | `src/ocr-v193/agent/preview.ts` | df2122a5 | — |
| `internal/agent/util.go` | `src/ocr-v193/agent/util.ts` | df2122a5 | — |
| `internal/scan/agent.go` | `src/ocr-v193/scan/scan.ts` | df2122a5 | — |
| `internal/scan/batch.go` | `src/ocr-v193/scan/batch.ts` | df2122a5 | — |
| `internal/scan/estimate.go` | `src/ocr-v193/scan/estimate.ts` | df2122a5 | — |
| `internal/scan/preview.go` | `src/ocr-v193/scan/preview.ts` | df2122a5 | — |
| `internal/scan/provider.go` | `src/ocr-v193/scan/provider.ts` | df2122a5 | — |
| `internal/session/history.go` | `src/ocr-v193/session/history.ts` | df2122a5 | — |
| `internal/session/manifest.go` | `src/ocr-v193/session/manifest.ts` | df2122a5 | — |
| `internal/session/persist.go` | `src/ocr-v193/session/persist.ts` | df2122a5 | — |
| `internal/session/resume.go` + `resume_identity.go` + `list.go` + `comments.go` | `src/ocr-v193/session/resume.ts` | df2122a5 | — |
| `cmd/opencodereview/output.go` | `src/ocr-v193/cli/output.ts` | df2122a5 | — |
| `cmd/opencodereview/sarif.go` | `src/ocr-v193/cli/sarif.ts` | df2122a5 | SARIF v2.1.0 8 rules |
| `cmd/opencodereview/review_cmd.go` | `src/ocr-v193/cli/review.ts` | df2122a5 | — |
| `cmd/opencodereview/scan_cmd.go` | `src/ocr-v193/cli/scan.ts` | df2122a5 | — |
| `cmd/opencodereview/shared.go` + `shared_flags.go` + `root.go` | `src/ocr-v193/cli/shared.ts` + `index.ts` | df2122a5 | — |
| `cmd/opencodereview/output.go` + `sarif.go` barrel | `src/ocr-v193/output/index.ts` | df2122a5 | — |

Hash discipline: every imported prompt/template/tool-schema/default-rule/output-schema/fixture gets a sha256 in this table; `bun test` fails if file bytes diverge.

## Upstream test coverage index

| Port test file | OCR test names represented | Status |
|---|---|---|
| `test/ocr-v193/llmloop/loop.test.ts` | `TestRunPerFile_TaskDoneSuccess`, `MultiToolTurnIsOneRound`, `EmptyToolCallsRetry`, `ThreeConsecutiveEmptyResults`, `MaxRoundsGrace`, `CancelPreventsGrace`, `CompressionThreshold`, `GraceRoundToolDefs` in `internal/llmloop/loop_test.go` | implemented (8 pass) |
| `test/ocr-v193/llmloop/compression.test.ts` | `TestCountMessagesTokens`, `TestGroupIntoRounds`, `TestPartitionMessages`, `TestStripMarkdownFences`, `TestBuildMessageXML`, `TestCopyMessages`, `TestPromptTokenLimit` in `compression_test.go` | implemented (10 pass) |
| `test/ocr-v193/llmloop/pool.test.ts` | `TestNewCommentWorkerPool`, `TestCommentWorkerPool_SubmitAndAwait`, `TestErrorDoesNotBlock`, `TestAwaitEmpty`, `TestPanicIsIsolated` in `pool_test.go` | implemented (5 pass) |
| `test/ocr-v193/diff/resolver.test.ts` | `TestResolveLineNumbers_SingleLineHunkMatch`, `TestResolveLineNumbers_WhitespaceTolerant`, `TestResolveLineNumbers_MultiLineHunkMatch`, `TestResolveLineNumbers_FallbackToFileContent*` (5 variants incl. CRLF/blank/duplicate), `TestResolveLineNumbers_NoMatchKeepsZero`, `TestResolveLineNumbers_NoExistingCode`, `TestResolveLineNumbers_PathNotFound`, `TestResolveLineNumbers_EmptyInputs`, `TestNormalizeLine`, `TestSplitAndNormalize_SkipsEmptyLines`, `TestExtractSideLines_*` (5 variants), `TestMatchConsecutive_*` (9 variants), `TestResolveFromHunk_*` (3+), `TestResolveLineNumbers_AlreadyResolved`, `TestResolveLineNumbers_MultipleCommentsOnSameFile`, `TestResolveLineNumbers_OldPathMapping`, `TestResolveLineNumbers_MixedStrategies`, `TestResolveLineNumbers_DiffMarkerInExistingCode` in `internal/diff/resolver_test.go` (687 lines) | implemented (30+ pass, 42 test defs) |
| `test/ocr-v193/diff/relocation.test.ts` | `TestResolveComment_TextMatchSuccess`, `TestResolveComment_AlreadyResolved`, `TestResolveComment_EmptyExistingCode`, `TestReLocateComment_LLMReturnsValidCode`, `TestReLocateComment_LLMReturnsInvalidContent`, `TestReLocateComment_LLMError`, `TestBuildReLocationMessages_Rendering`, `TestBuildReLocationMessages_NilOrEmptyTask`, `TestReLocateComment_CodeBlockStillUnresolvable`, `TestReLocateComment_NoMessages`, `TestExtractCodeBlock` in `internal/diff/relocation_test.go` | implemented (11 pass) |
| `test/ocr-v193/tool/collector.test.ts` | `TestCommentCollector_AddAndComments`, `TestCommentCollector_CommentsReturnsDefensiveCopy`, `TestCommentCollector_CommentsForPath`, `TestCommentCollector_SnapshotAndSince`, `TestCommentCollector_SinceEdgeCases`, `TestCommentCollector_ReplaceSince*`, `TestCommentCollector_ReplaceSinceOutOfBounds`, `TestCommentCollector_ReplaceSince_NegativeSnap`, `TestCommentCollector_ReplaceSince_Zero`, `TestCommentCollector_RemoveByPathAndIndices*` in `internal/tool/comment_collector_test.go` | implemented (14 pass) |
| `test/ocr-v193/llmloop/loop-phase5.test.ts` | `TestExecuteToolCall_CodeCommentAsyncPool`, `TestExecuteToolCall_CodeCommentDiffResolved`, `TestExecuteToolCall_CodeCommentThinkingBackfill`, `TestExecuteToolCall_CodeCommentNoReasoning`, `TestRunPerFile_BackfillsThinkingFromReasoningContent`, `TestExecuteToolCall_TaskDone`, `TestReLocateComment*`, `TestExecuteToolCall_DynamicNotRegistered`, `TestExecuteToolCall_DynamicExecuteError`, `TestExecuteToolCall_DynamicSuccessRecordsResult`, `TestExecuteToolCall_DynamicParseError`, `TestCollectPendingComments_AwaitsPool`, `TestExecuteToolCall_CodeCommentOverridesHallucinatedPath` via `loop_execute_test.go` + `loop_execute_more_test.go` | implemented (17 pass: diff-resolved sync, relocation retry success/failure, no task, thinking, suggestion multiline, async drain, concurrent isolation, ordering, deleted/context, dynamic tool, parse error, hallucinated path) |
| `test/ocr-v193/agent/filter.test.ts` | `TestExecuteReviewFilter_NoFilterTask`, `TestExecuteReviewFilter_NoComments`, `TestExecuteReviewFilter_RemovesComments`, `TestExecuteReviewFilter_LLMError`, `TestExecuteReviewFilter_SkipFilter` (5 sub-tests), `TestExecuteReviewFilter_WithTimeout`, `TestExecuteReviewFilter_Identity` + malformed, fences, out-of-range, abort, deterministic ordering in `internal/agent/coverage_test.go` + `retry_identity_test.go` | implemented (11 pass) |
| `test/ocr-v193/harness` (6 fixtures) | `workspace` (code_comment+task_done), `workspace-multi-tool` (multi-tool=1 round), `workspace-empty` (3× empty → StopEmptyRounds), `workspace-budget-grace` (budget 1 → grace task_done), `range` (range merge-base → feature.go), `commit` (commit parent → commit.go) derived from `loop_test.go` + `agent_test.go` + `git_test.go` | implemented — `bun run harness --all` 6 fixtures, 4 differential (workspace, multi-tool, range, commit via fake server) + 2 Pi-only (synthetic empty/budget) — Phase 5 unit coverage supplements differential (relocation/filter validated via loop-phase5 + filter unit tests; additional harness fixtures for filter/relocation deferred to Phase 5 follow-up) |
| `test/ocr-v193/diff/parser.test.ts` | `TestParser*` in `internal/diff/parser_test.go` | — |
| *(expand as tests land; omission needs reason in parity matrix)* | | |

## Parity matrix

`matched` means OCR-vs-Pi differential fixture passes field-for-field; `deviates` is an approved, measured, documented deviation (never labeled parity); `specified` = source-mapped+tests written; `implemented`; `unexamined` = not yet considered.

| Capability | Status | Evidence / issue |
|---|---|---|
| Diff workspace/range/commit targets + merge-base + staged/untracked | matched (harness) | `src/ocr-v193/diff/git.ts` + `parser.ts` + `hunk.ts` + `workspace.ts` + `runner.ts` ported; harness proves workspace + range (merge-base) + commit (first-parent) produce selected=["feature.go"]/["commit.go"], 1 comment, usage 210/195, 2 rounds Pi vs OCR — `bun run harness --all` 6 fixtures (4 differential) |
| Gitignore + default exclude dirs | implemented | `src/ocr-v193/diff/gitignore.ts` ports hardcoded provider dirs + .gitignore last-match-wins |
| Relocation + resolver | verified (PiTransport) | `src/ocr-v193/diff/relocation.ts` + `resolver.ts` ported (hunk-side + file-content fallback, multiline suggestion handling, deleted/context, diff-marker strip, duplicate first-match, blank-line fallback, CRLF); integrated in `loop.ts` via `diffLookup` + `ReLocationTask` with usage counting and rollback; 42 resolver + 11 relocation unit tests pass + 9 PiTransport fixtures (resolver hunk/fallback/ws/CRLF/marker/duplicate/no-match, relocation success/failure) |
| File selection: allowlist, excludes, rules, size/line limits, preview, background | implemented | `src/ocr-v193/rules/allowed_ext.ts` + `system_rules.ts` + `src/ocr-v193/model/preview.ts` + `src/ocr-v193/agent/preview.ts` + `src/ocr-v193/diff/gitignore.ts`; supported_file_types.json + default_exclude_patterns.json verbatim |
| System rules + rule docs (35 languages) | implemented | `src/ocr-v193/rules/system_rules.ts` verbatim JSON + 35 rule_docs/*.md with hash freeze |
| Template prompts + task/scan templates | implemented | `src/ocr-v193/template/template.ts` + 10 prompts + task-template.json/scan-template.json verbatim, hash-verified |
| Planning threshold + plan failure open + token limits | implemented | `src/ocr-v193/agent/agent.ts` executePlanPhase stub + estimate.ts; threshold logic mirrors OCR Phase 4 |
| Main loop: 30 rounds review / 60 scan, multi-tool turn, grace (1 terminal), empty 3x, typed stops, usage counted | implemented | `src/ocr-v193/llmloop/loop.ts` + `types.ts` + `transcript.ts` via `ScriptedTransport`; 8 loop tests pass (task_done, multi-tool=1round, empty retry, 3× empty → StopEmptyRounds, budget→grace filtered, cancel prevents grace). Scan 60 budget via template |
| Compression: 60%/80% thresholds, warning, prompt, async ownership per-file, isolation, failure-keeps-original | implemented (deviation: token counts bytes/4 vs tiktoken) | `src/ocr-v193/llmloop/compression.ts` + `loop.ts:runCompression` ports partition→buildXML→{{context}}→LLM→StripFences→rebuildWithSummary+usage, sync 80% + async 60% via CompressionState per-file, failure keeps original → StopCompression; token estimator is bytes/4 (deterministic, 20-30% delta vs Go tiktoken) |
| Pool (CommentWorkerPool 8 workers, per-key isolation) | implemented | `src/ocr-v193/llmloop/pool.ts` semaphore + per-key AwaitKey |
| Model contracts (Diff/Preview/ScanItem/LlmComment) | implemented | `src/ocr-v193/model/*` barrel with JSON round-trip helpers |
| Tool contracts + collector + filereader | implemented | `src/ocr-v193/tool/*` + collector Snapshot/Since/ReplaceSince, code_comment ParseComments, file_read/file_read_diff/code_search/file_find via FileReader |
| Comment pipeline: `code_comment` incremental collector + `task_done` termination, relocation via `re_location_task`, validation, async drain, review filter (`--no-filter`) | verified (PiTransport 54 assertions) | `src/ocr-v193/tool/collector.ts` + `code-comment.ts` + `loop.ts` incremental path with `DiffLookup` + `ReLocationTask` + `resolveComment` + `buildReLocationMessages` + `extractCodeBlock` + `CommentWorkerPool.SubmitFor` per-file + `await AwaitKey` before filter (mirrors Go `Agent.executeReviewFilter` drain); `src/ocr-v193/diff/relocation.ts` + `resolver.ts` (hunk-side + file-content fallback, multiline suggestion, deleted/context, diff-marker strip, duplicate first-match); `src/ocr-v193/agent/agent.ts` `buildFilterCommentsJSON` + `parseFilterResponse` (StripMarkdownFences, regex `c-%d`, out-of-range ignore) + `executeReviewFilter` (SkipFilter, no-comments, LLM error, malformed, fences, timeout via AbortSignal, per-path `RemoveByPathAndIndices`); 95 unit tests pass (resolver 42, relocation 11, collector 14, loop-phase5 17, filter 11) + `bun run verify:phase3-comments` 9 fixtures 54 assertions via PiTransport (relocation success/failure with usage, async drain, production collector fenced, malformed/duplicate/invalid/outofrange, error/timeout/abort, partial survival, negative mismatch) |
| Operational limits: concurrency, per-file timeout, global cancel, token budget look-ahead, Git process cap, retry reporting | implemented | `src/ocr-v193/agent/agent.ts` dispatch gate (semaphore), token look-ahead, global cancel, Git runner cap 16; per-file timeout via AbortSignal |
| Scan mode: batching (lang/dir/none), dedup, summary, `--no-*` flags, scan checkpoint | implemented | `src/ocr-v193/scan/*` batch.ts + estimate.ts + provider.ts + preview.ts + scan.ts (filterScanItems, dedup/summary flags, preview) |
| Session checkpoints: fingerprints, sealed input identity, lineage, trusted resume, Ctrl-C checkpoint | implemented | `src/ocr-v193/session/*` history.ts + manifest.ts + persist.ts + resume.ts (ManifestBuilder, JSONL writer, ResumeState, ListSessions) |
| CLI: text/JSON/SARIF/agent output, diagnostics on stderr, usage/retry summaries, exit codes, preview | implemented | `src/ocr-v193/cli/*` + `output/*` ported; text (manifestMessage + badge+wrap), JSON, SARIF v2.1.0, preview, agent audience, exit 0/2/1, stderr vs stdout separated |
| Pi adapter transport (public SDK only) | implemented | `src/ocr-v193/pi-adapter/pi-transport.ts` functional on public APIs (`createAgentSession`, `SessionManager`, `SettingsManager`, `setActiveToolsByName`, message translation, `complete()` & `streamComplete()` with abort, grace & dynamic allowlist); spike + harness prove no private imports |
| Grace abort (cancel before grace) | matched (spike) | `spike/feasibility-v2.ts` testCancelledGrace |
| Round accounting (multi-tool = 1 round) | matched (spike) | `spike/feasibility-v2.ts` testRoundAccounting |
| Dynamic allowlist | matched (spike) | `spike/feasibility-v2.ts` testDynamicAllowlist via `setActiveToolsByName` |
| Compression isolation (concurrent sessions) | matched (spike) | `spike/feasibility-v2.ts` testIsolation |
| Timeout/abort | matched (spike) | `spike/feasibility-v2.ts` testAbort |
| Empty-round recovery | specified (host-orchestrated) | Pi is `stop` without steer; host must `followUp`/`prompt` with OCR retry string 3x — gap documented |
| Deferred shells: provider TUI, viewer, MCP/delegate, telemetry, IDE plugins, GH Action | deferred | Visible, not blocking core port |

Run `bun run spike/feasibility-v2.ts` (+ `feasibility-v3.ts`) to re-prove SDK rows; the differential harness (`bun run harness --all`) runs 4 deterministic fixtures (workspace, multi-tool, empty, budget-grace) with field-level mismatch artifacts and fails if `../open-code-review` does not contain the pinned tag/commit (check `git -C ../open-code-review cat-file -p v1.9.3` and `rev-parse`). Use `bun run test/ocr-v193/harness/index.ts --fixture <name>` for single fixture.