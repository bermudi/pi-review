# Architecture — pi-reviewer engine

`pi-reviewer` is an independently maintained review engine built on the Pi
SDK. It was derived from Open Code Review v1.9.9; the frozen fork reference is
tag object `c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94`, commit
`4b6874bd23106b5c68bea6d230bb60303b9f0961`. The legacy precision-oriented
engine has been removed; `src/ocr` is the sole engine and `src/cli.ts` is a
thin production adapter. The directory name and historical source map preserve
provenance, not an ongoing obligation to track OCR releases.

The public library seam is:

```ts
import { review, createReviewer, Reviewer } from "pi-reviewer";
// review(input, options): Promise<ReviewResult>
```

Pi sessions, model resolution, prompts, and model-visible tool definitions do
not cross that boundary. `src/index.ts` exports only
`review`/`createReviewer`/`Reviewer`, domain types, and a small retained set of
compatibility utilities (`PiTransport`, `OcrRunner`, `runOcrCli`).

## End-to-end pipeline

1. **Acquire and validate Git target — `src/ocr/diff`, `src/ocr/cli/git.ts`.**
   Validate repository, refs, paths, and symlink boundaries. Workspace
   compares the working tree with `HEAD`; range diffs `head` against the
   merge-base of `base` and `head`; commit diffs against its first parent.
   Diff parsing, relocation, and gitignore handling are OCR ports with
   argv-array Git invocations (no shell interpolation).

2. **Apply OCR-compatible selection, rules, and limits — `src/ocr/rules`, `src/ocr/diff`.**
   Rules resolve from the repository and `--rule` file; file filters apply
   default exclusions, user `--exclude` patterns, path safety, binary/deletion
   policy, and resource ceilings. Include rules never bypass safety.

3. **Optionally plan, then run the per-file model-round loop — `src/ocr/agent`, `src/ocr/llmloop`.**
   Files above the plan threshold receive a `PLAN_TASK` pre-pass. Each
   selected file runs an isolated agent with OCR’s `code_comment` incremental
   collector and `task_done` terminal, plus bounded `file_read`,
   `code_search`, `file_find`, and `file_read_diff` tools.

4. **Collect findings incrementally, relocate, validate, and filter — `src/ocr/tool`, `src/ocr/diff/relocation.ts`, `src/ocr/agent/filter.ts`.**
   Comments are relocated to the current diff, validated against added lines,
   and filtered by the LLM filter task when not disabled via `--no-filter`.

5. **Enforce OCR-compatible round, context, time, token, and recovery behavior — `src/ocr/llmloop`, `src/ocr/session`.**
   One model round is one provider request (including multiple tool calls).
   Context is OCR-controlled compression; time/token ceilings and the single
   restricted grace round match v1.9.9.

6. **Support diff review, full-file scan, checkpoints/resume, and output formats — `src/ocr/scan`, `src/ocr/session`, `src/ocr/cli/output.ts`.**
   `review` handles workspace/range/commit diffs; `scan` handles full-file
   scans with batching. Review checkpoints persist under
   `~/.opencodereview/sessions`; `~/.pi/agent` contains Pi model and
   authentication configuration. `--resume` continues a single interrupted
   session. Output formats are `text`, `json`, and `sarif`; audience is
   `human` or `agent`.

## Module seams

- `src/cli.ts` — thin production adapter over `src/ocr/cli/index.ts` and `src/ocr/cli/factory.ts`; injects real runner/preview factories and the `IO`/`readFile` seam; no engine switch; `runCli` is testable without `process.exit`.
- `src/index.ts` — minimal public facade re-exporting the OCR-backed `review` API and domain types.
- `src/ocr/cli` — OCR-compatible `review`/`scan` commands, flag parsing, runner factories, and output rendering.
- `src/ocr/agent`, `src/ocr/llmloop`, `src/ocr/tool` — per-file orchestration, model loop, and tool definitions.
- `src/ocr/diff`, `src/ocr/rules`, `src/ocr/session`, `src/ocr/scan`, `src/ocr/template` — diff, rules, session persistence, scan batching, and prompt templates.

## Coverage and failure semantics

`ReviewResult.coverage` partitions `selected = completed + reused + failed + waived`.
`complete` means all selected items completed; `partial` means some failed but
not all; `failed` means all selected failed or a terminal error occurred;
`skipped` means no reviewable files were selected. Incomplete work never
becomes a clean review; partial/failed work remains visible.

Exit codes: `0` for `complete`/`skipped`, `2` for `partial`, `1` for `failed` or
invalid usage. Help exits `0`.

Each concurrently reviewed or scanned file owns an isolated Pi
`AgentSession`. Its plan, main, compression, relocation, and filter stages
reuse that file's session; independent files never share mutable Pi history or
route through `followUp`.

Normal releases use `bun run verify:release`, which has no OCR checkout
dependency. The complete frozen-reference audit is preserved at tag `v0.4.0`.

## Security and read-only guarantees

- Git invocations use argv arrays, never shell interpolation.
- Model-visible tools are explicitly allowlisted and bounded; no shell, edit, or write tools are exposed.
- Review operations do not modify the target repository.
- Repository `AGENTS.md`, skills, extensions, and prompts are never loaded into review sessions; repository content is untrusted evidence.
