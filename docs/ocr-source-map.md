# OCR source translation map — shipped v1.9.3, upgrade target v1.9.9

Shipped reference: tag `v1.9.3`, signed tag object `4d796ae54cabdcf4e22b69ef502ed8871456a909`, commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27` in `../open-code-review`.
Verified: `git -C ../open-code-review rev-parse v1.9.3^{commit}` == `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`, `git -C ../open-code-review tag --verify v1.9.3` is good signature.

Active upgrade target (not shipped): tag `v1.9.9`, signed tag object
`c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94`, commit
`4b6874bd23106b5c68bea6d230bb60303b9f0961`. The machine-checked
`docs/ocr-upstream-test-delta.json` records added, removed, changed-body, and
byte-identical top-level tests; its pending cases are v1.9.9 upgrade work.

### v1.9.9 upgrade translations

- OCR v1.9.5 commit `9a371c9b3610fb4e9892bd50b72941e26201c2c1`:
  `internal/diff/resolver.go` cross-file comment re-filing is ported in
  `src/ocr/diff/resolver.ts` and invoked by the review runner over its selected
  diffs.
- OCR v1.9.5/v1.9.6 language assets: `src/ocr/rules` carries the Swift,
  Jupyter, R, Zig, Elm, Thrift, Cap'n Proto, Jsonnet, and allowlist changes.
  `src/ocr/rules/PROVENANCE.json` records the mixed per-file origins.
- OCR v1.9.9 commit `4b6874bd23106b5c68bea6d230bb60303b9f0961`:
  `src/ocr/cli/background.ts` resolves inline, file, and commit-message
  background through one precedence boundary. The CLI passes its resolved
  value explicitly to the production factory.
- OCR v1.9.5 commit `c8b6a390b8ad447faf46d4764347167edff0ada2`:
  review filtering uses its terminal, stage-only tool definitions and prompt
  payloads. Pi activates that registered supplemental set only after its
  public active-tool API confirms the exact requested names.
  `src/ocr/template/prompts/PROVENANCE.json` records the two mixed-origin
  prompt files.
- OCR v1.9.9 commit `4b6874bd23106b5c68bea6d230bb60303b9f0961`:
  `MainLoopStop` has shared named reasons in `src/ocr/llmloop/types.ts`;
  review and scan carry the same trigger into their failure diagnostics.
- OCR v1.9.4 commit `31db10f` (exercised by v1.9.9 cancellation cases):
  review cancellation records a cancelled run failure before finalization,
  so pending items sweep to cancelled while completed checkpoint records stay
  reusable on a later resume.
  The production review factory owns one `SessionHistory` and passes it to the
  Agent; the Agent alone finalizes its manifest and persisted session.
- OCR v1.9.5 commit `75cb3d0c45cb322495133a688de5620258a30849`:
  scan records aggregate token-budget truncation in `BudgetExceeded()` and
  emits `summary.budget_exceeded` in JSON. v1.9.9 revalidates unreadable
  binary-sniff skips in the scan provider.

This map is the Phase 2 contract from `docs/ocr-port-plan.md`. Each row identifies OCR production and test scope, whether Pi code is reused/wrapped/replaced, and where the TypeScript home lives. It is not a completion ledger. The exhaustive, path-qualified disposition of every pinned upstream test is `docs/ocr-upstream-test-inventory.json`, checked by `test/ocr/manifest-coverage.test.ts`. No parity engine may import `src/{reviewer,pi-runner,prompts,tools,phase-tools,resolver,change-map}` policy — reuse only after OCR-derived tests prove parity.

| OCR v1.9.3 source | Pi port home | Production files (Go) | Upstream test scope | Reuse policy |
|---|---|---|---|---|
| `internal/model` | `src/ocr/model` | `diff.go`, `preview.go`, `review.go`, `scan.go` | `model_test.go` | Replace — port domain contracts (`Diff`, `ReviewItem`, `ScanItem`) |
| `internal/config/template` | `src/ocr/template` | `template.go`, `scan_template.json`, `task_template.json`, `prompts/*.md` | `template_test.go` | Import templates verbatim with provenance + hash freeze; port loader/substitution/validation |
| `internal/config/rules` + `allowlist` | `src/ocr/rules` | `allowlist/allowed_ext.go`, `rules/system_rules.go`, `rules/system_rules.json` | `allowed_ext_test.go`, `system_rules_test.go`, `system_rules_unmarshal_test.go`, `canonical_config_test.go` | Replace — audit `src/selection.ts` only after fixtures match; do not inherit its defaults |
| `internal/diff` + `internal/gitcmd` | `src/ocr/diff` | `diff/git.go`, `gitignore.go`, `hunk.go`, `parser.go`, `relocation.go`, `resolver.go`, `workspace_file.go`, `gitcmd/runner.go` | `git_test.go`, `git_resolve_test.go`, `parser_test.go`, `hunk_test.go`, `relocation_test.go`, `resolver_test.go`, `gitignore_test.go`, `workspace_file_test.go`, `runner_test.go` | Candidate for later extraction — reuse Git runner/diff parser only after parity tests (path safety, argv arrays already match) |
| `internal/tool` | `src/ocr/tool` | `code_comment.go`, `code_search.go`, `file_find.go`, `file_read.go`, `file_read_diff.go`, `comment_collector.go`, `definitions.go`, `filereader.go`, `response_message.go`, `stub.go` | `code_comment_test.go`, `code_search_test.go`, `file_find_test.go`, `file_read_test.go`, `file_read_diff_test.go`, `comment_collector_test.go`, `definitions_test.go`, `filereader_test.go`, `response_message_test.go`, `stub_test.go` | Replace — do not reuse `src/tools.ts` verifier/collector; new collector is incremental `code_comment` |
| `internal/llmloop` | `src/ocr/llmloop` | `loop.go`, `compression.go`, `pool.go` | `loop_test.go`, `loop_execute_test.go`, `loop_execute_more_test.go`, `compression_test.go`, `pool_test.go`, `retry_background_test.go`, `retry_identity_test.go`, `runner_test.go` | Fresh — first engine slice after manifest (Phase 3). No import from `src/pi-runner.ts` loop policy. |
| `internal/agent` | `src/ocr/agent` | `agent.go`, `identity.go`, `estimate.go`, `preview.go`, `util.go` | `agent_test.go`, `coverage_test.go`, `budget_test.go`, `identity_test.go`, `estimate_test.go`, `preview_test.go`, `manifest_hash_test.go`, `manifest_integration_test.go`, `sealed_input_test.go`, `retry_identity_test.go` | Fresh — port diff-review orchestration, file selection, preview, budgets |
| `internal/scan` | `src/ocr/scan` | `agent.go`, `batch.go`, `estimate.go`, `preview.go`, `provider.go` | `agent_test.go`, `batch_test.go`, `budget_test.go`, `coverage_test.go`, `dedup_test.go`, `estimate_test.go`, `provider_test.go`, `retry_identity_test.go` | Fresh — separate from diff review, not a fake diff |
| `internal/session` | `src/ocr/session` | `history.go`, `manifest.go`, `persist.go`, `resume.go`, `resume_identity.go`, `list.go`, `comments.go` | `history_test.go`, `manifest_test.go`, `persist_test.go`, `resume_test.go`, `resume_identity_test.go`, `list_test.go`, `comments_test.go`, `final_manifest_test.go` | Fresh — port checkpoint lineage/fingerprints/sealed identity; Pi raw transcript stays internal but checkpoint guarantees must match OCR |
| `internal/suggestdiff` | `src/ocr/cli/output.ts` | `suggestdiff/diff.go` (inlined as `computeLineDiff`/`ComputeLineDiff`/`buildDiffLines`) | `diff_test.go` | Port — exact LCS with `EqualFold(TrimSpace)` preserved; used by `cmd/opencodereview/output.go` rendering |
| `cmd/opencodereview` output/SARIF | `src/ocr/cli` + `src/ocr/output` | `output.go`, `sarif.go`, `emit_run_result_test.go`, `budget_output_test.go`, `retry_report_*`, `review_cmd.go`, `scan_cmd.go`, `session_cmd.go`, `shared*.go` | `output_test.go`, `sarif_test.go`, `retry_report_*_test.go`, `review_cmd_test.go`, `scan_cmd_test.go` | Thin adapter over domain result — no duplication of legacy `src/cli.ts` policy |
| `internal/llm` | `src/ocr/pi-adapter` | `client.go`, `providers.go`, `resolver.go`, `retry_*.go`, `sessionkey.go`, `usage_resolver.go`, `responses_client.go` | `client_test.go`, `resolver_test.go`, `retry_*_test.go`, `sessionkey_test.go` | Replaced by narrow Pi SDK adapter (public `createAgentSession`/`SessionManager`/`SettingsManager` only) |

### Out-of-scope shells (deferred, not silent)

Tracked in parity matrix as `deferred`:

- provider configuration TUI + provider catalog (`internal/llm` TUI, `cmd/opencodereview/provider_tui*.go`)
- browser session viewer (`internal/viewer`)
- IDE / agent plugins, GitHub Action packaging, MCP + delegate commands (`internal/mcp`, `internal/delegate`, `cmd/opencodereview/delegate*`)
- OpenTelemetry export (`internal/telemetry`)

These require separate plans; they do not block core review parity.

### Rules for new engine

- No import from legacy `src/reviewer.ts`, `src/pi-runner.ts` policy, `src/prompts.ts`, `src/tools.ts` collector/verifier, `src/phase-tools.ts`, `src/resolver.ts` strict policy, `src/change-map.ts`.
- Candidate low-level reuse (after parity proof): Git argv runner, unified-diff parsing, path/symlink safety, bounded read-only filesystem helpers, model discovery/auth (excluding loop policy), result coverage/usage primitives, CLI stream/signal seams. Prefer duplication over coupling.
- Provenance header per file + hash of imported prompts/templates/schemas/fixtures; `THIRD_PARTY_NOTICES.md` retains Apache-2.0 attribution.
