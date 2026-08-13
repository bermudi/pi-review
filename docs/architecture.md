# Architecture

`pi-reviewer` is a deterministic Git-target pipeline wrapped around isolated Pi tasks. The public library seam is:

```ts
Reviewer.review(input, options): Promise<ReviewResult>
```

Pi sessions, model resolution, prompts, and model-visible tools do not cross that boundary. The same domain seam is used by the implemented `src/cli.ts` adapter.

## End-to-end pipeline

1. **Acquire a review target — `git.ts` and `diff.ts`.** Validate the repository, mode, refs, paths, and symlink boundaries. For a workspace, compare the working tree with `HEAD` when available and synthesize diffs for non-ignored untracked files. For a range, diff `head` against the merge-base of `base` and `head`. For a commit, diff against its first parent or the root tree. Parse the unified diff into `ChangedFile` records and enrich text files with target-side content. Range/commit reads use Git blobs pinned to the target commit; workspace reads use the live working tree.
2. **Select files — `selection.ts` and `reviewer.ts`.** Sort changed files deterministically, then apply unsafe-path, binary, deletion, user-exclude, default extension/path, and changed-line policies. The orchestration default is `2,000` changed lines per file. A selected file is gated before task dispatch if its raw diff is empty, exceeds `100,000` bytes, or has no changed lines. Selection decisions become excluded coverage rather than disappearing, and they are the sole input to the cross-file change map's eligibility policy.
3. **Plan material risk when needed — `phase-tools.ts` and `prompts.ts`.** At the default threshold of `50` changed lines, the file receives a separate planning task. That task has one terminating `submit_plan` tool and returns a schema-checked `change_summary` plus at most four prioritized issues, with one bounded evidence suggestion per issue. It describes evidence calls; it does not perform them. Planner failure fails open for the main review, with a warning. The planner receives the current file's change-map slice (see below) alongside the diff.
4. **Review one selected file — `reviewer.ts`, `prompts.ts`, and `tools.ts`.** Each file gets an independent Pi task with a fixed system policy, a delimited current-file diff, other changed paths for orientation, the current file's change-map slice, optional background/rules, and the optional risk plan. Its custom tool allowlist is exactly the bounded evidence tools plus `submit_review`.
5. **Resolve placement — `resolver.ts`.** Convert submitted candidates into findings by matching `existingCode` against target-side content. A candidate is accepted only if its matched range intersects an added target-side line. Unanchored candidates are rejected with a warning; there is no fallback location.
6. **Verify independently — `tools.ts`, `prompts.ts`, and `reviewer.ts`.** Resolved findings are sent to a separate verification task with bounded read-only evidence tools and `submit_verification`. It classifies every candidate as verified, disproved, or unverified. Verified and disproved decisions require exact citations from host-recorded evidence, and only verified candidates are emitted. Verification failure fails the file rather than publishing unchecked findings.
7. **Assemble coverage — `reviewer.ts`.** File tasks may run concurrently, with a default concurrency of `4`. Findings, coverage, warnings, and token usage are aggregated and sorted deterministically. The result distinguishes `complete`, `partial`, `failed`, and `skipped`; incomplete selected work cannot be presented as complete. `skipped` is returned only when no files were selected.
8. **Render and terminate — `cli.ts`.** Parse and validate argv, load optional UTF-8 background/rules files, install signal cancellation, pass progress events to stderr, render either text or the exact JSON `ReviewResult` to stdout, and return the documented exit code. The CLI is a thin process/stream adapter; it does not duplicate review policy.

### Target acquisition and buffering

The acquisition seam is read-only and uses Git argv arrays rather than a shell. It buffers values before parsing, but host-side ceilings prevent unbounded allocation: Git stdout is capped at 64 MiB, Git stderr at 2 MiB, and workspace/Git-blob files at 16 MiB. The later `100,000`-byte per-file diff gate and evidence-tool output caps are stricter and model-facing. Acquisition remains whole-buffer rather than streaming.

## Phase protocol and isolation

The system uses three structured termination protocols:

- **Planning:** `submit_plan` accepts only `change_summary` and a bounded list of typed issues/tool guidance, then terminates the planner.
- **Main review:** `submit_review` accepts `state: "DONE" | "FAILED"` and the complete candidate list, then terminates the file task.
- **Verification:** `submit_verification` accepts exactly one verdict for every supplied candidate. Positive and negative factual verdicts require exact quotes from known evidence IDs; unknown IDs, invented quotes, duplicate decisions, and incomplete candidate sets are rejected.

Each phase is a separate task/session. The main worker must finish with one successful `submit_review` action; a rejected submission may be corrected within reserved recovery starts. `Reviewer` treats a task outcome without a `DONE` submission as a file failure, even if the Pi session otherwise stopped successfully. A `FAILED` submission cannot contain findings. This keeps phase state explicit and makes failed or incomplete output visible in coverage.

The Pi runner (`pi-runner.ts`) creates in-memory sessions with a minimal resource loader by default; when a session directory is configured it uses Pi's file-backed session manager instead, persisting each task's transcript as `.jsonl`. It resolves the configured provider/model and checks authentication before creating a task session. It forwards only a narrow task outcome/event vocabulary, enforces abort and tool-start limits, sanitizes tool details, and disposes every session. Each task receives an explicit custom-tool allowlist; no default shell, edit, write, or unrelated Pi tool is exposed.

All repository material is placed in delimited user data. Diffs, code, background, rules, paths, plans, and tool results are evidence, not instructions. The resource loader does not discover repository `AGENTS.md` files, skills, extensions, prompts, or settings.

## Cross-file change map

`change-map.ts` is a deterministic, host-side artifact that gives each per-file task bounded orientation about the rest of the change: renames, new/deleted files, and conservative lexical declaration changes. It is built once from the selection decisions — never from raw target files — so the same policy that decides what is reviewable also decides what is eligible as orientation.

Eligibility follows the selection reason:

- `selected` files contribute file facts plus added/removed declarations.
- `deleted` files (never reviewable) contribute their deletion fact and diff-derived removed declarations, which is the strongest cross-file breakage signal.
- Default-policy skips (unsupported extension, default path, size/line limits) contribute rename/new/deleted metadata only — never content-derived declarations.
- Unsafe paths, binary files, explicit user excludes, and size-unknown files are invisible. A deleted file that also matches the caller's `exclude` patterns stays invisible, because its declarations are still excluded-file content.

Declaration extraction is a small, extension-scoped pattern table (TypeScript/JavaScript exports, Python module-level `def`/`class`, Go `func`/`type`, Rust `fn`/`struct`/`enum`/`trait`), anchored and conservative, returning identifiers only. Everything else renders as `LEXICAL` approximation; rename/new/deleted facts render as `FACT` metadata. The artifact is capped at `200` facts total and `20` declarations per file, with exact dropped counts; each rendered per-file slice has its own `4,000`-byte UTF-8 ceiling with an explicit `(truncated: N facts omitted)` notice. Rendering groups the current file's facts under `This file (...)` first, then deletions, renames, other declarations, and new files, in truncation-priority order.

The map is passive, per-file orientation only. It never creates findings, never extends review scope, never changes anchoring or coverage, and is not persisted. It cannot overcome added-line anchoring: a stale caller whose file is unchanged still cannot receive a finding here. If a future Option B (a global model brief) is ever built, it should consume these bounded deterministic facts rather than inventing a second lossy digest pipeline.

## Bounded evidence tools

`tools.ts` constructs the model-visible read-only toolkit:

- `file_read`: repository-relative target-snapshot lines, at most `500` numbered lines and `100,000` output bytes;
- `code_search`: literal text search, at most `100` results and `50,000` output bytes; files over `1,000,000` bytes and binary files are skipped;
- `file_find`: safe target paths, at most `100` results and `50,000` output bytes;
- `file_read_diff`: the capped diff for a known changed file, at most `100,000` bytes;
- `submit_review`: the atomic final submission, with at most `20` candidates.

The nominal main-review toolkit budget is `32` starts, including the terminating call. The reviewer deliberately reserves capacity for recovery and termination: 30 normal evidence calls + up to two rejected/recovery starts + the final `submit_review` means up to `33` actual starts. The runner's hard tool-start cap is one start above the nominal budget (`33` by default); start 34 aborts. `--max-tool-rounds` remains the compatibility name for this nominal per-file budget. Lower values still preserve a submit-only path.

Verification uses the same four evidence tools with a fixed smaller budget: eight normal evidence calls, recovery capacity, and `submit_verification`. Every successful evidence result receives a stable ID in the verifier's private ledger. The terminal tool accepts a quote only when its evidence ID exists and the quote is an exact contiguous substring of the recorded bounded output. Tool parameters are validated at the boundary. Evidence operations are bounded in their returned model-visible output, but their host-side target reads still run with the caller's filesystem permissions.

## Atomic output improvement

The important output improvement is atomic submission rather than incremental comment mutation. The worker does not call a tool once per finding or leave a partially recorded list behind. `submit_review` validates the entire `state` and comments array, stores the complete candidate set in memory, and terminates in one operation. `Reviewer` then resolves all candidates, discards unanchored ones, and submits the remainder for independent verification. A missing or failed terminal submission is a failed file, not a successful review with an ambiguous subset of comments.

The same shape applies to planning and verification: one validated structured value is recorded only by the terminating tool. Planning remains advisory and fails open. Verification is mandatory whenever resolved findings exist: uncertainty drops an individual candidate, while phase failure marks the file incomplete.

## Module seams

- `src/types.ts` — shared public and internal review-domain contracts.
- `src/git.ts` — Git process seam and workspace/range/commit `ReviewTarget` acquisition.
- `src/diff.ts` — unified-diff parsing, safe diff paths, and diff metadata.
- `src/selection.ts` — pure deterministic file-selection policy.
- `src/change-map.ts` — pure deterministic cross-file change map and per-file slice renderer.
- `src/resolver.ts` — pure deterministic added-line finding placement.
- `src/prompts.ts` — fixed precision-first system prompts and delimited user data.
- `src/tools.ts` — bounded target-snapshot evidence tools and atomic finding collector.
- `src/phase-tools.ts` — schema-checked planning termination tool.
- `src/pi-runner.ts` — Pi `0.82.1` runtime/model/auth/session adapter.
- `src/reviewer.ts` — per-file workflow, planning threshold, concurrency, verification, warnings, and coverage.
- `src/cli.ts` — argv validation, file-option loading, signal handling, progress, output rendering, and exit status; no review policy or Pi objects leak through it.
- `src/index.ts` — deliberate public facade; it exports the review domain and deterministic seams, not Pi internals or model-visible tool definitions.

## Coverage and failure semantics

`ReviewResult.coverage` records excluded paths, selected paths, completed paths, failed paths with reasons, and selected paths skipped because they never ran or were cancelled. `reviewer.ts` sorts these lists and findings independently of task completion order. `selected = completed + failed + skipped` is a real partition. A result is `complete` only when every selected file has a completed main workflow. `skipped` is returned only when no files were selected. Partial and failed selected work remain visible, and warnings explain planner, tool, placement, verification, and provider failures.

The CLI maps statuses exactly as follows:

| Status | Exit code |
| --- | ---: |
| `complete` | `0` |
| `skipped` | `0` |
| `partial` | `2` |
| `failed` | `1` |

CLI usage, option-file, initialization, and pre-result failures also return `1`; help returns `0`.

## Pi dependency and configuration

The implementation reference was the neighboring `../pi-mono` checkout. Runtime does not import that path. `package.json` pins the released dependency `@earendil-works/pi-coding-agent` to exact version `0.82.1`.

By default, the runner uses `~/.pi/agent` and its `auth.json`/`models.json`. `PI_CODING_AGENT_DIR`, `--agent-dir`, and `ReviewOptions.agentDir` can select another agent directory, with an explicit option taking precedence over the environment. There is no interactive login flow; authentication failure becomes a task/review failure.

## Intentional precision and safety choices

- **Strict added-line anchors.** A finding is rejected unless its target-side range intersects an added line; context-only matches do not become comments.
- **Atomic structured output.** Complete review output is submitted through one validated `submit_review` call instead of incremental finding writes.
- **Schema rejection.** Plan, comment, verification, and termination values are validated and rejected when malformed rather than loosely coerced.
- **Evidence-backed verification.** Only positively verified findings survive. Exact cited quotes must exist in host-recorded bounded evidence; uncertainty drops a candidate and verifier failure fails the file.
- **Deterministic ordering.** Git files, selection coverage, findings, and final result lists do not depend on task completion timing.
- **Bounded cross-file orientation.** The change map is deterministic, capped at construction and render time, and injected per file as delimited evidence; it never relaxes added-line anchoring, coverage accounting, or per-file model isolation.
- **Read-only isolation.** Model tasks have no shell/edit/write tools, and repository instruction discovery is disabled. Git and file operations remain host-permission operations, not a sandbox.

These choices favor precision and auditable failure states over maximum recall or feature parity with open-code-review's Go/provider/UI stack. The implementation has no resume workflow, no full-repository scan mode, and no mechanical compile/test/formatter/linter phase. Workspace evidence can change during a long review because workspace reads are live after target acquisition; range and commit evidence are pinned. Target acquisition is bounded but whole-buffered as described above.

## Deferred and preserved decisions

- **Rejected tool calls consume starts.** A schema-invalid `submit_review` still consumes a runner start, and the dispatcher allows recovery before termination. The nominal `32` budget deliberately exposes only 30 normal evidence calls; two recovery starts and the final submission remain protected without relaxing the hard cap.
- **Public `maxToolRounds` rename deferred.** The vocabulary split (`maxToolRounds` / `DEFAULT_MAX_TOOL_CALLS` / `maxToolCalls` / `maxToolStarts`) is real, but renaming the public `ReviewOptions.maxToolRounds` field and the `--max-tool-rounds` CLI flag is a breaking change. The non-breaking parts (CLI help text, internal name alignment) are done; the public rename is deferred to a major version with a deprecated alias.
