# Architecture

`pi-reviewer` is a deterministic Git-target pipeline wrapped around isolated Pi tasks. The public library seam is:

```ts
Reviewer.review(input, options): Promise<ReviewResult>
```

Pi sessions, model resolution, prompts, and model-visible tools do not cross that boundary. The same domain seam is used by the implemented `src/cli.ts` adapter.

## End-to-end pipeline

1. **Acquire a review target — `git.ts` and `diff.ts`.** Validate the repository, mode, refs, paths, and symlink boundaries. For a workspace, compare the working tree with `HEAD` when available and synthesize diffs for non-ignored untracked files. For a range, diff `head` against the merge-base of `base` and `head`. For a commit, diff against its first parent or the root tree. Parse the unified diff into `ChangedFile` records and enrich text files with target-side content. Range/commit reads use Git blobs pinned to the target commit; workspace reads use the live working tree.
2. **Select files — `selection.ts` and `reviewer.ts`.** Sort changed files deterministically, then apply unsafe-path, binary, deletion, user-exclude, default extension/path, and changed-line policies. The orchestration default is `2,000` changed lines per file. A selected file is gated before task dispatch if its raw diff is empty, exceeds `100,000` bytes, or has no changed lines. Selection decisions become skipped coverage rather than disappearing.
3. **Plan material risk when needed — `phase-tools.ts` and `prompts.ts`.** At the default threshold of `50` changed lines, the file receives a separate planning task. That task has one terminating `submit_plan` tool and returns a schema-checked `change_summary` plus prioritized issues with bounded evidence guidance. It describes evidence calls; it does not perform them. Planner failure fails open for the main review, with a warning.
4. **Review one selected file — `reviewer.ts`, `prompts.ts`, and `tools.ts`.** Each file gets an independent Pi task with a fixed system policy, a delimited current-file diff, other changed paths for orientation, optional background/rules, and the optional risk plan. Its custom tool allowlist is exactly the bounded evidence tools plus `submit_review`.
5. **Resolve placement — `resolver.ts`.** Convert submitted candidates into findings by matching `existingCode` against target-side content. A candidate is accepted only if its matched range intersects an added target-side line. Unanchored candidates are rejected with a warning; there is no fallback location.
6. **Veto conservatively — `phase-tools.ts`, `prompts.ts`, and `reviewer.ts`.** Resolved findings are sent to a separate veto task using `submit_veto`. The veto stage can remove a candidate only when the current diff directly disproves its central claim. Uncertainty keeps the candidate. A non-aborted veto failure fails open for findings and emits a warning.
7. **Assemble coverage — `reviewer.ts`.** File tasks may run concurrently, with a default concurrency of `4`. Findings, coverage, warnings, and token usage are aggregated and sorted deterministically. The result distinguishes `complete`, `partial`, `failed`, and `skipped`; incomplete selected work cannot be presented as complete.
8. **Render and terminate — `cli.ts`.** Parse and validate argv, load optional UTF-8 background/rules files, install signal cancellation, pass progress events to stderr, render either text or the exact JSON `ReviewResult` to stdout, and return the documented exit code. The CLI is a thin process/stream adapter; it does not duplicate review policy.

### Target acquisition and buffering

The acquisition seam is read-only and uses Git argv arrays rather than a shell. It buffers values before parsing, but host-side ceilings prevent unbounded allocation: Git stdout is capped at 64 MiB, Git stderr at 2 MiB, and workspace/Git-blob files at 16 MiB. The later `100,000`-byte per-file diff gate and evidence-tool output caps are stricter and model-facing. Acquisition remains whole-buffer rather than streaming.

## Phase protocol and isolation

The system uses three structured termination protocols:

- **Planning:** `submit_plan` accepts only `change_summary` and a bounded list of typed issues/tool guidance, then terminates the planner.
- **Main review:** `submit_review` accepts `state: "DONE" | "FAILED"` and the complete candidate list, then terminates the file task.
- **Veto:** `submit_veto` accepts only unique IDs from the supplied candidate set, then terminates the veto task.

Each phase is a separate task/session. The main worker must call `submit_review` exactly once as its final action. `Reviewer` treats a task outcome without a `DONE` submission as a file failure, even if the Pi session otherwise stopped successfully. A `FAILED` submission cannot contain findings. This keeps phase state explicit and makes failed or incomplete output visible in coverage.

The Pi runner (`pi-runner.ts`) creates in-memory sessions with a minimal resource loader. It resolves the configured provider/model and checks authentication before creating a task session. It forwards only a narrow task outcome/event vocabulary, enforces abort and tool-start limits, sanitizes tool details, and disposes every session. Each task receives an explicit custom-tool allowlist; no default shell, edit, write, or unrelated Pi tool is exposed.

All repository material is placed in delimited user data. Diffs, code, background, rules, paths, plans, and tool results are evidence, not instructions. The resource loader does not discover repository `AGENTS.md` files, skills, extensions, prompts, or settings.

## Bounded evidence tools

`tools.ts` constructs the model-visible read-only toolkit:

- `file_read`: repository-relative target-snapshot lines, at most `500` numbered lines and `100,000` output bytes;
- `code_search`: literal text search, at most `100` results and `50,000` output bytes; files over `1,000,000` bytes and binary files are skipped;
- `file_find`: safe target paths, at most `100` results and `50,000` output bytes;
- `file_read_diff`: the capped diff for a known changed file, at most `100,000` bytes;
- `submit_review`: the atomic final submission, with at most `20` candidates.

The default toolkit budget is `32` tool starts per task, including the terminating call. Tool parameters are validated at the boundary. Evidence operations are bounded in their returned model-visible output, but their host-side target reads still run with the caller's filesystem permissions.

## Atomic output improvement

The important output improvement is atomic submission rather than incremental comment mutation. The worker does not call a tool once per finding or leave a partially recorded list behind. `submit_review` validates the entire `state` and comments array, stores the complete candidate set in memory, and terminates in one operation. `Reviewer` then resolves all candidates, discards unanchored ones, and applies the veto pass as a separate deterministic stage. A missing or failed terminal submission is a failed file, not a successful review with an ambiguous subset of comments.

The same shape applies to planning and veto: one validated structured value is recorded only by the terminating tool. This gives the orchestration layer an auditable phase boundary while retaining fail-open behavior where intended: planner failure still permits the main review, and non-aborted veto failure keeps resolved findings.

## Module seams

- `src/types.ts` — shared public and internal review-domain contracts.
- `src/git.ts` — Git process seam and workspace/range/commit `ReviewTarget` acquisition.
- `src/diff.ts` — unified-diff parsing, safe diff paths, and diff metadata.
- `src/selection.ts` — pure deterministic file-selection policy.
- `src/resolver.ts` — pure deterministic added-line finding placement.
- `src/prompts.ts` — fixed precision-first system prompts and delimited user data.
- `src/tools.ts` — bounded target-snapshot evidence tools and atomic finding collector.
- `src/phase-tools.ts` — schema-checked plan and veto termination tools.
- `src/pi-runner.ts` — Pi `0.82.1` runtime/model/auth/session adapter.
- `src/reviewer.ts` — per-file workflow, planning threshold, concurrency, veto, warnings, and coverage.
- `src/cli.ts` — argv validation, file-option loading, signal handling, progress, output rendering, and exit status; no review policy or Pi objects leak through it.
- `src/index.ts` — deliberate public facade; it exports the review domain and deterministic seams, not Pi internals or model-visible tool definitions.

## Coverage and failure semantics

`ReviewResult.coverage` records the selected paths, completed paths, failed paths with reasons, and skipped paths with reasons. `reviewer.ts` sorts these lists and findings independently of task completion order. A result is `complete` only when every selected file has a completed main workflow. A result can be complete while non-selected files are listed as skipped; those files were never part of the selected work set. Partial and failed selected work remain visible, and warnings explain planner, tool, placement, veto, and provider failures.

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
- **Schema rejection.** Plan, comment, veto, and termination values are validated and rejected when malformed rather than loosely coerced.
- **Conservative veto.** The veto pass removes comments only on direct counter-evidence in the current diff; uncertainty preserves them.
- **Deterministic ordering.** Git files, selection coverage, findings, and final result lists do not depend on task completion timing.
- **Read-only isolation.** Model tasks have no shell/edit/write tools, and repository instruction discovery is disabled. Git and file operations remain host-permission operations, not a sandbox.

These choices favor precision and auditable failure states over maximum recall or feature parity with open-code-review's Go/provider/UI stack. The implementation has no resume workflow, no full-repository scan mode, and no mechanical compile/test/formatter/linter phase. Workspace evidence can change during a long review because workspace reads are live after target acquisition; range and commit evidence are pinned. Target acquisition is bounded but whole-buffered as described above.
