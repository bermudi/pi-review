# OCR v1.9.3 reference manifest

Fixed reference for every translated file under
`docs/ocr-v1.9.3-port-plan.md`.

## Pinned reference

- Release: https://github.com/alibaba/open-code-review/releases/tag/v1.9.3
- Tag: `v1.9.3`
- Signed tag object: `4d796ae54cabdcf4e22b69ef502ed8871456a909` (`git cat-file -p v1.9.3`)
- Commit: `c35ddd7223f2b5540ce03aa43c9a25ef643fca27` (`git rev-parse v1.9.3^{commit}`)
- Local checkout: `../open-code-review` (must contain tag+commit; harness fails otherwise)
- Go: `go1.26.6` (per `manifest_hash_test.go` / Go image bump in tag notes)
- Bun: `>=1.3.0` (package.json `engines`)
- Pi SDK: `@earendil-works/pi-coding-agent` `0.84.2` (was `0.82.1`, see `docs/pi-sdk-feasibility-report.md` bump note)

## Verification status (recovery plan v2)

The earlier verifier reports were invalidated because they admitted
fixture-constructed observations and did not prove the installed product path.
They remain in Git history only. Existing implementation is candidate code
until the new black-box gates pass.

| Phase | Status | Verifier | Commit | Report |
|---|---|---|---|---|
| Gate 0 — black-box integrity | `verified` | `bun run verify:blackbox-integrity` | `7ba1659841edc09ac88bbbc677564b88c83fc4a4` | `verification/blackbox` 9 fixtures 13 assertions, pack `9fb755364ff1ce507c174ab1a10626d1f804fa6a88981f06b2b75a1ec7308ad7`, artifacts `/tmp/verify-blackbox-*`; re-verified after packed-install workspace fix (commit `3c5fc57d`)
| Gate 1 — public Pi SDK feasibility | `verified` | `bun run verify:sdk-feasibility` | `a8f97c827a98839d54d5bd70b100bc833e1f166b` | `verification/blackbox` 7 fixtures 17 assertions (7+7 adversarial), pack `a8e518c6`, artifacts `/tmp/verify-sdk-*` — OCR empty-tool-result (file_read ""), separate arrival/delivery (delivered flag, no usage on stalled), per-session usage equality, real concurrent adversarial via capture mutation, no any, hasEmptyResultError required |
| Gate 2 — vertical slice | `verified` | `bun run verify:vertical` | `01b7741b27a2f3fdd51721b0c878d05185b6fcfa` | `verification/blackbox` 2 fixtures 22 assertions, pack `c903869c`, OCR tag object `4d796ae54cabdcf4e22b69ef502ed8871456a909`/commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`; positive fixture `vertical-workspace-one-file-one-comment` (2 provider requests, 1 comment, exit 0, deep message+schema parity); negative fixture `vertical-mismatch-comment-content` (mutated provider response, mismatch correctly detected at `stdout.comments[0].content` via deep `provider_request[1].messages` comparison); forbiddenImports=0; artifacts `/tmp/verify-vertical-mCTxt7` |
|| Gate 3 — core diff review | `verified` | `bun run verify:core-review` | `5a19c8cfd5ee1efc6a841807a3aca46c95238477` | 10 fixtures, 194 assertions, pack `5ecae700e9f73f8d40dd2c2da9f0fff45aa5e8c58b7bd991cf529d385a2e3351`, OCR tag object `4d796ae54cabdcf4e22b69ef502ed8871456a909`/commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`; families: `vertical-workspace-one-file-one-comment`, `vertical-mismatch-comment-content`, `core-preview-selection-exclusion`, `core-relocation-line`, `core-filter-keep`, `core-filter-remove`, `core-range-two-commits`, `core-commit-sha`, `core-multi-file-orchestration` (includes `core-multi-file-planning`), `core-incomplete-partial`; `notObservable`: `planning:not_triggered_below_threshold`; forbiddenImports=0; artifacts `/tmp/core-extended3` |
| Gate 4 — scan/session/output | `verified` | `bun run verify:scan`; `verify:sessions`; `verify:outputs` | `7ba1659841edc09ac88bbbc677564b88c83fc4a4` | `verify:scan` 2 fixtures 11 assertions; `verify:sessions` 3 fixtures 29 assertions (checkpoint creation, kill+resume, mutation); `verify:outputs` 4 fixtures 20 assertions (text, json, json+agent, sarif); pack `9fb755364ff1ce507c174ab1a10626d1f804fa6a88981f06b2b75a1ec7308ad7`; re-verified because commit `200ff83b` renamed the `[ocr]` progress prefix to `[pi-review]` and silently regressed `verify:outputs` (not CI-run); deviation since user-approved and canonicalized to `[engine]` in both comparators; OCR tag object `4d796ae54cabdcf4e22b69ef502ed8871456a909`/commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`; forbiddenImports=0; artifacts `/tmp/verify-scan-*`, `/tmp/verify-sessions-*`, `/tmp/verify-outputs-*` |
| Gate 5 — cutover | `verified` | `bun run verify:cutover` | `7ba1659841edc09ac88bbbc677564b88c83fc4a4` | 8 fixtures 14 assertions (scan/sessions/outputs prerequisites + source-defaults, library-default-identity, default-parity-workspace, incomplete-partial, legacy-marker), pack `9fb755364ff1ce507c174ab1a10626d1f804fa6a88981f06b2b75a1ec7308ad7`; CLI default is parity (ocr-v193), library default `review`/`Reviewer`/`createReviewer` exports parity, legacy retained behind `--engine legacy` and `reviewLegacy`/`ReviewerLegacy`/`createReviewerLegacy`; default `pi-review review` reaches parity tool schemas, legacy constructor marker not emitted; `--engine legacy` emits legacy constructor marker; incomplete fixture exits nonzero; OCR tag object `4d796ae54cabdcf4e22b69ef502ed8871456a909`/commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`; `notObservable`: `runtime provider traffic for the library default review() API`; forbiddenImports=0; artifacts `/tmp/verify-cutover-*` |

Ledger rule: only the recovery plan v2 black-box gates may set `verified`.
Existing source rows describe candidate implementation and historical test
results; their old uses of “verified” are not current gate status.

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
| `test/ocr-v193/llmloop/loop.test.ts` | `TestRunPerFile_TaskDoneImmediately`, `TestRunPerFile_UsesCompletionTokenLimit`, `TestRunPerFile_TaskDoneExplicitDone`, `TestRunPerFile_TaskDoneFailed`, `TestRunPerFile_InvalidTaskDoneStateRetries`, `TestRunPerFile_TagsRequestsWithTaskSessionKey`, `TestRunPerFile_ToolCallThenDone`, `TestRunPerFile_ContextCancelled`, `TestRunPerFile_UnknownTool`, `TestRunPerFile_MaxToolRequestsWithoutTaskDoneDoesNotComplete`, `TestRunPerFile_EmptyToolResultsStopWithEmptyRounds`, `TestRunPerFile_UncompressibleContextStopsWithCompression`, `TestRunner_RecordWarning`, `TestRunner_RecordUsage`, `TestExecuteToolCall_ArgumentsEdgeCases`, `TestRunPerFile_GraceRoundSubmitsComment`, `TestRunPerFile_GraceRoundSkippedWhenContextCancelled`, `TestRunPerFile_GraceRoundNotTriggeredOnEmptyRoundsStop` in pinned `internal/llmloop/loop_test.go` | 18 pinned tests mapped; 3 additional local regressions |
| `test/ocr-v193/llmloop/compression.test.ts` | `TestCountMessagesTokens`, `TestCountMessagesTokens_Empty`, `TestGroupIntoRounds`, `TestGroupIntoRounds_NoAssistant`, `TestPartitionMessages_ShortConversation`, `TestPartitionMessages_EverythingFits`, `TestStripMarkdownFences`, `TestBuildMessageXML`, `TestCopyMessages`, `TestPromptTokenLimit`, `TestPromptTokenLimitMatchesReplacedExpression` in pinned `internal/llmloop/compression_test.go` | 11 pinned tests mapped; 1 additional local regression |
| `test/ocr-v193/llmloop/pool.test.ts` | `TestNewCommentWorkerPool_Default`, `TestNewCommentWorkerPool_Custom`, `TestCommentWorkerPool_SubmitAndAwait`, `TestCommentWorkerPool_ErrorDoesNotBlock`, `TestCommentWorkerPool_Concurrency`, `TestCommentWorkerPool_AwaitEmpty`, `TestCommentWorkerPool_PanicIsIsolated`, `TestCommentWorkerPool_AwaitKeyWaitsForOwnKey`, `TestCommentWorkerPool_AwaitKeyConcurrentSubmitOtherKey`, `TestCommentWorkerPool_AwaitKeyUnknown` in pinned `internal/llmloop/pool_test.go` | 10 pinned tests mapped; 0 additional local regressions |
| `test/ocr-v193/diff/resolver.test.ts` | `TestResolveLineNumbers_SingleLineHunkMatch`, `TestResolveLineNumbers_WhitespaceTolerant`, `TestResolveLineNumbers_MultiLineHunkMatch`, `TestResolveLineNumbers_FallbackToFileContent`, `TestResolveLineNumbers_FallbackToFileContent_BlankLines`, `TestResolveLineNumbers_FallbackToFileContent_MultipleBlankLines`, `TestResolveLineNumbers_FallbackToFileContent_LeadingBlanks`, `TestResolveLineNumbers_FallbackToFileContent_CRLF`, `TestResolveLineNumbers_FallbackToFileContent_FirstMatchWins`, `TestResolveLineNumbers_FallbackToFileContent_AllBlankExistingCode`, `TestResolveLineNumbers_NoMatchKeepsZero`, `TestResolveLineNumbers_NoExistingCode`, `TestResolveLineNumbers_PathNotFound`, `TestResolveLineNumbers_EmptyInputs`, `TestNormalizeLine`, `TestSplitAndNormalize_SkipsEmptyLines`, `TestExtractSideLines_NewSide`, `TestExtractSideLines_OldSide`, `TestExtractSideLines_DivergentStartLines`, `TestExtractSideLines_OnlyAdded`, `TestExtractSideLines_OnlyDeleted`, `TestMatchConsecutive_SingleLine`, `TestMatchConsecutive_MultiLine`, `TestMatchConsecutive_NoMatch`, `TestMatchConsecutive_FirstMatchWins`, `TestMatchConsecutive_TargetLongerThanLines`, `TestMatchConsecutive_EmptySideLines`, `TestMatchConsecutive_MatchAtEnd`, `TestMatchConsecutive_MatchAtStart`, `TestMatchConsecutive_ExactFull`, `TestResolveFromHunk_AddedLines`, `TestResolveFromHunk_OldSideAcrossAddedLines`, `TestResolveFromHunk_ContextLinesOnly`, `TestResolveFromHunk_SingleAddedLine`, `TestResolveFromHunk_NewSidePriority`, `TestResolveFromHunk_MultiHunkMatchInSecond`, `TestResolveFromHunk_AddedWithContext`, `TestResolveFromHunk_NewSideAcrossDeletedLines`, `TestResolveLineNumbers_AlreadyResolved`, `TestResolveLineNumbers_MultipleCommentsOnSameFile`, `TestResolveLineNumbers_OldPathMapping`, `TestResolveLineNumbers_MixedStrategies`, `TestResolveLineNumbers_DiffMarkerInExistingCode` in pinned `internal/diff/resolver_test.go` | implemented (42 test definitions) |
| `test/ocr-v193/diff/relocation.test.ts` | `TestResolveComment_TextMatchSuccess`, `TestResolveComment_AlreadyResolved`, `TestResolveComment_EmptyExistingCode`, `TestReLocateComment_LLMReturnsValidCode`, `TestReLocateComment_LLMReturnsInvalidContent`, `TestReLocateComment_LLMError`, `TestBuildReLocationMessages_Rendering`, `TestBuildReLocationMessages_NilOrEmptyTask`, `TestReLocateComment_CodeBlockStillUnresolvable`, `TestReLocateComment_NoMessages`, `TestExtractCodeBlock` in `internal/diff/relocation_test.go` | implemented (11 pass) |
| `test/ocr-v193/tool/collector.test.ts` | `TestCommentCollector_AddAndComments`, `TestCommentCollector_CommentsReturnsDefensiveCopy`, `TestCommentCollector_CommentsForPath`, `TestCommentCollector_SnapshotAndSince`, `TestCommentCollector_SinceEdgeCases`, `TestCommentCollector_ReplaceSince`, `TestCommentCollector_ReplaceSinceOutOfBounds`, `TestCommentCollector_RemoveByPathAndIndices`, `TestCommentCollector_RemoveByPathAndIndices_NoMatch`, `TestCommentCollector_ReplaceSince_NegativeSnap`, `TestCommentCollector_ReplaceSince_Zero` in pinned `internal/tool/comment_collector_test.go` | 11 pinned tests mapped; 3 additional local regressions |
| `test/ocr-v193/llmloop/loop-phase5.test.ts` | `TestExecuteToolCall_CodeCommentAsyncPool`, `TestExecuteToolCall_CodeCommentDiffResolved`, `TestExecuteToolCall_CodeCommentThinkingBackfill`, `TestExecuteToolCall_CodeCommentNoReasoning`, `TestRunPerFile_BackfillsThinkingFromReasoningContent`, `TestRunPerFile_NoFallbackToContent`, `TestExecuteToolCall_TaskDone`, `TestExecuteToolCall_DynamicNotRegistered`, `TestExecuteToolCall_DynamicExecuteError`, `TestExecuteToolCall_DynamicSuccessRecordsResult`, `TestExecuteToolCall_KnownToolNotRegistered`, `TestExecuteToolCall_DynamicParseError`, `TestCollectPendingComments_AwaitsPool`, `TestExecuteToolCall_CodeCommentOverridesHallucinatedPath` from pinned `internal/llmloop/loop_execute_test.go`, `internal/llmloop/loop_execute_more_test.go`, and `internal/llmloop/loop_test.go` | 14 pinned tests mapped; 7 additional local regressions |
| `test/ocr-v193/agent/filter.test.ts` | `TestExecuteReviewFilter_NoFilterTask`, `TestExecuteReviewFilter_NoComments`, `TestExecuteReviewFilter_RemovesComments`, `TestExecuteReviewFilter_LLMError`, `TestExecuteReviewFilter_SkipFilter` (5 sub-tests), `TestExecuteReviewFilter_WithTimeout`, `TestExecuteReviewFilter_Identity` + malformed, fences, out-of-range, abort, deterministic ordering in `internal/agent/coverage_test.go` + `retry_identity_test.go` | implemented (11 pass) |
| `test/ocr-v193/harness` (6 fixtures) | `workspace` (code_comment+task_done), `workspace-multi-tool` (multi-tool=1 round), `workspace-empty` (3× empty → StopEmptyRounds), `workspace-budget-grace` (budget 1 → grace task_done), `range` (range merge-base → feature.go), `commit` (commit parent → commit.go) derived from `loop_test.go` + `agent_test.go` + `git_test.go` | implemented — `bun run harness --all` 6 fixtures, 4 differential (workspace, multi-tool, range, commit via fake server) + 2 Pi-only (synthetic empty/budget) — Phase 5 unit coverage supplements differential (relocation/filter validated via loop-phase5 + filter unit tests; additional harness fixtures for filter/relocation deferred to Phase 5 follow-up) |
| `test/ocr-v193/diff/parser.test.ts` | `TestParseDiffText_StripsIndexHeadersFromPromptDiff`, `TestParseDiffText_Rename`, `TestParseDiffText_PureRename`, `TestParseDiffText_DeletedFile`, `TestParseDiffText_NewFile`, `TestParseDiffText_BinaryMarkerAnchored`, `TestParseDiffText_CountsContentLinesWithPlusMinusPrefix`, `TestParseDiffText_DevNullStringInsideHunk` in pinned `internal/diff/parser_test.go` | 8 pinned tests mapped; 0 additional local regressions |
| *(expand as tests land; omission needs reason in parity matrix)* | | |

## Parity matrix

`matched` means OCR-vs-Pi differential fixture passes field-for-field; `deviates` is an approved, measured, documented deviation (never labeled parity); `specified` = source-mapped+tests written; `implemented`; `unexamined` = not yet considered.

| Capability | Status | Evidence / issue |
|---|---|---|
| Diff workspace/range/commit targets + merge-base + staged/untracked | matched (harness) | `src/ocr-v193/diff/git.ts` + `parser.ts` + `hunk.ts` + `workspace.ts` + `runner.ts` ported; harness proves workspace + range (merge-base) + commit (first-parent) produce selected=["feature.go"]/["commit.go"], 1 comment, usage 210/195, 2 rounds Pi vs OCR — `bun run harness --all` 6 fixtures (4 differential) |
| Gitignore + default exclude dirs | implemented | `src/ocr-v193/diff/gitignore.ts` ports hardcoded provider dirs + .gitignore last-match-wins |
| Relocation + resolver | candidate (old PiTransport evidence invalidated) | `src/ocr-v193/diff/relocation.ts` + `resolver.ts` ported (hunk-side + file-content fallback, multiline suggestion handling, deleted/context, diff-marker strip, duplicate first-match, blank-line fallback, CRLF); integrated in `loop.ts` via `diffLookup` + `ReLocationTask` with usage counting and rollback; 42 resolver + 11 relocation unit tests pass + 9 historical PiTransport fixtures (resolver hunk/fallback/ws/CRLF/marker/duplicate/no-match, relocation success/failure) |
| File selection: allowlist, excludes, rules, size/line limits, preview, background | implemented | `src/ocr-v193/rules/allowed_ext.ts` + `system_rules.ts` + `src/ocr-v193/model/preview.ts` + `src/ocr-v193/agent/preview.ts` + `src/ocr-v193/diff/gitignore.ts`; supported_file_types.json + default_exclude_patterns.json verbatim |
| System rules + rule docs (35 languages) | implemented | `src/ocr-v193/rules/system_rules.ts` verbatim JSON + 35 rule_docs/*.md with hash freeze |
| Template prompts + task/scan templates | implemented | `src/ocr-v193/template/template.ts` + 10 prompts + task-template.json/scan-template.json verbatim, hash-verified |
| Planning threshold + plan failure open + token limits | implemented | `src/ocr-v193/agent/agent.ts` executePlanPhase stub + estimate.ts; threshold logic mirrors OCR Phase 4 |
| Main loop: 30 rounds review / 60 scan, multi-tool turn, grace (1 terminal), empty 3x, typed stops, usage counted | implemented | `src/ocr-v193/llmloop/loop.ts` + `types.ts` + `transcript.ts` via `ScriptedTransport`; 8 loop tests pass (task_done, multi-tool=1round, empty retry, 3× empty → StopEmptyRounds, budget→grace filtered, cancel prevents grace). Scan 60 budget via template |
| Compression: 60%/80% thresholds, warning, prompt, async ownership per-file, isolation, failure-keeps-original | implemented (deviation: token counts bytes/4 vs tiktoken) | `src/ocr-v193/llmloop/compression.ts` + `loop.ts:runCompression` ports partition→buildXML→{{context}}→LLM→StripFences→rebuildWithSummary+usage, sync 80% + async 60% via CompressionState per-file, failure keeps original → StopCompression; token estimator is bytes/4 (deterministic, 20-30% delta vs Go tiktoken) |
| Pool (CommentWorkerPool 8 workers, per-key isolation) | implemented | `src/ocr-v193/llmloop/pool.ts` semaphore + per-key AwaitKey |
| Model contracts (Diff/Preview/ScanItem/LlmComment) | implemented | `src/ocr-v193/model/*` barrel with JSON round-trip helpers |
| Tool contracts + collector + filereader | implemented | `src/ocr-v193/tool/*` + collector Snapshot/Since/ReplaceSince, code_comment ParseComments, file_read/file_read_diff/code_search/file_find via FileReader |
| Comment pipeline: `code_comment` incremental collector + `task_done` termination, relocation via `re_location_task`, validation, async drain, review filter (`--no-filter`) | candidate (old evidence invalidated) | `src/ocr-v193/tool/collector.ts` + `code-comment.ts` + `loop.ts` incremental path with `DiffLookup` + `ReLocationTask` + `resolveComment` + `buildReLocationMessages` + `extractCodeBlock` + `CommentWorkerPool.SubmitFor` per-file + `await AwaitKey` before filter (mirrors Go `Agent.executeReviewFilter` drain); `src/ocr-v193/diff/relocation.ts` + `resolver.ts` (hunk-side + file-content fallback, multiline suggestion, deleted/context, diff-marker strip, duplicate first-match); `src/ocr-v193/agent/agent.ts` `buildFilterCommentsJSON` + `parseFilterResponse` (StripMarkdownFences, regex `c-%d`, out-of-range ignore) + `executeReviewFilter` (SkipFilter, no-comments, LLM error, malformed, fences, timeout via AbortSignal, per-path `RemoveByPathAndIndices`); 95 unit tests pass (resolver 42, relocation 11, collector 14, loop-phase5 17, filter 11) + historical `bun run verify:phase3-comments` results, which do not satisfy recovery plan v2 |
| Operational limits: concurrency, per-file timeout, global cancel, token budget look-ahead, Git process cap, retry reporting | implemented | `src/ocr-v193/agent/agent.ts` dispatch gate (semaphore), token look-ahead, global cancel, Git runner cap 16; per-file timeout via AbortSignal |
| Scan mode: batching (lang/dir/none), dedup, summary, `--no-*` flags, scan checkpoint | `matched` (Gate 4) | `src/ocr-v193/scan/*` batch.ts + estimate.ts + provider.ts + preview.ts + scan.ts; `bun run verify:scan` @ `7ba16598` 2 fixtures 11 assertions (scan-one-file-one-comment positive, scan-mismatch-comment negative), pack `9fb755364ff1ce507c174ab1a10626d1f804fa6a88981f06b2b75a1ec7308ad7`, forbiddenImports=0 |
| Session checkpoints: fingerprints, sealed input identity, lineage, trusted resume, Ctrl-C checkpoint | `matched` (Gate 4) | `src/ocr-v193/session/*` history.ts + manifest.ts + persist.ts + resume.ts; `bun run verify:sessions` @ `7ba16598` 3 fixtures 29 assertions (sessions-complete, sessions-resume kill+restart subprocess, sessions-complete-mutation negative), pack `9fb755364ff1ce507c174ab1a10626d1f804fa6a88981f06b2b75a1ec7308ad7`, forbiddenImports=0 |
| CLI: text/JSON/SARIF/agent output, diagnostics on stderr, usage/retry summaries, exit codes, preview | `matched` (Gate 4; deviation: tool-name prefix `[ocr]` → `[pi-review]`) | `src/ocr-v193/cli/*` + `output/*` ported; `bun run verify:outputs` @ `7ba16598` 4 fixtures 20 assertions — scan subcommand text/json/json+agent/sarif stdout + exit codes from the packed install, pack `9fb755364ff1ce507c174ab1a10626d1f804fa6a88981f06b2b75a1ec7308ad7`; stderr diagnostics compared via capture comparers in the scan/sessions gates; user-approved 2026-08-19 branding deviation: progress prefix `[pi-review]` where OCR v1.9.3 hardcodes `[ocr]` (stdout trace summary + stderr diagnostics), verifiers canonicalize both to `[engine]` (`verify-outputs.ts` `normalizeTextOutput`, `comparer.ts` `normalizeStderr`); SARIF driver name remains `OpenCodeReview` verbatim |
| Pi adapter transport (public SDK only) | implemented | `src/ocr-v193/pi-adapter/pi-transport.ts` functional on public APIs (`createAgentSession`, `SessionManager`, `SettingsManager`, `setActiveToolsByName`, message translation, `complete()` & `streamComplete()` with abort, grace & dynamic allowlist); spike + harness prove no private imports |
| Grace abort (cancel before grace) | matched (spike) | `spike/feasibility-v2.ts` testCancelledGrace |
| Round accounting (multi-tool = 1 round) | matched (spike) | `spike/feasibility-v2.ts` testRoundAccounting |
| Dynamic allowlist | matched (spike) | `spike/feasibility-v2.ts` testDynamicAllowlist via `setActiveToolsByName` |
| Compression isolation (concurrent sessions) | matched (spike) | `spike/feasibility-v2.ts` testIsolation |
| Timeout/abort | matched (spike) | `spike/feasibility-v2.ts` testAbort |
| Empty-round recovery | specified (host-orchestrated) | Pi is `stop` without steer; host must `followUp`/`prompt` with OCR retry string 3x — gap documented |
| Deferred shells: provider TUI, viewer, MCP/delegate, telemetry, IDE plugins, GH Action | deferred | Visible, not blocking core port |

Run `bun run spike/feasibility-v2.ts` (+ `feasibility-v3.ts`) to re-prove SDK rows; the differential harness (`bun run harness --all`) runs 4 deterministic fixtures (workspace, multi-tool, empty, budget-grace) with field-level mismatch artifacts and fails if `../open-code-review` does not contain the pinned tag/commit (check `git -C ../open-code-review cat-file -p v1.9.3` and `rev-parse`). Use `bun run test/ocr-v193/harness/index.ts --fixture <name>` for single fixture.
