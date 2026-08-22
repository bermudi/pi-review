# Architecture — OCR v1.9.3 Port (sole engine)

`pi-reviewer` is a behavioral port of Open Code Review v1.9.3 onto the Pi
SDK. The legacy precision-oriented engine has been removed by explicit user
approval; `src/ocr-v193` is now the sole engine and `src/cli.ts` is a thin
production adapter over it. The pinned reference is OCR tag `v1.9.3`
(`4d796ae54cabdcf4e22b69ef502ed8871456a909` / `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`)
in `../open-code-review`. The detailed upstream-to-TypeScript file map is in
`docs/ocr-v193-source-map.md`; `docs/ocr-v1.9.3-port-plan.md` defines the
migration gates.

The public library seam is:

```ts
import { review, createReviewer, Reviewer } from "pi-reviewer";
// review(input, options): Promise<ReviewResult>
```

Pi sessions, model resolution, prompts, and model-visible tool definitions do
not cross that boundary. `src/index.ts` exports only the OCR-backed
`review`/`createReviewer`/`Reviewer`, domain types, and a small set of
OCR-backed utilities (`PiTransport`, `OcrRunner`, `runOcrCli`).

## End-to-end pipeline (OCR parity)

1. **Acquire and validate Git target — `src/ocr-v193/diff`, `src/ocr-v193/cli/git.ts`.**
   Validate repository, refs, paths, and symlink boundaries. Workspace
   compares the working tree with `HEAD`; range diffs `head` against the
   merge-base of `base` and `head`; commit diffs against its first parent.
   Diff parsing, relocation, and gitignore handling are OCR ports with
   argv-array Git invocations (no shell interpolation).

2. **Apply OCR-compatible selection, rules, and limits — `src/ocr-v193/rules`, `src/ocr-v193/diff`.**
   Rules resolve from the repository and `--rule` file; file filters apply
   default exclusions, user `--exclude` patterns, path safety, binary/deletion
   policy, and resource ceilings. Include rules never bypass safety.

3. **Optionally plan, then run the per-file model-round loop — `src/ocr-v193/agent`, `src/ocr-v193/llmloop`.**
   Files above the plan threshold receive a `PLAN_TASK` pre-pass. Each
   selected file runs an isolated agent with OCR’s `code_comment` incremental
   collector and `task_done` terminal, plus bounded `file_read`,
   `code_search`, `file_find`, and `file_read_diff` tools.

4. **Collect findings incrementally, relocate, validate, and filter — `src/ocr-v193/tool`, `src/ocr-v193/diff/relocation.ts`, `src/ocr-v193/agent/filter.ts`.**
   Comments are relocated to the current diff, validated against added lines,
   and filtered by the LLM filter task when not disabled via `--no-filter`.

5. **Enforce OCR-compatible round, context, time, token, and recovery behavior — `src/ocr-v193/llmloop`, `src/ocr-v193/session`.**
   One model round is one provider request (including multiple tool calls).
   Context is OCR-controlled compression; time/token ceilings and the single
   restricted grace round match v1.9.3.

6. **Support diff review, full-file scan, checkpoints/resume, and output formats — `src/ocr-v193/scan`, `src/ocr-v193/session`, `src/ocr-v193/cli/output.ts`.**
   `review` handles workspace/range/commit diffs; `scan` handles full-file
   scans with batching. Review checkpoints persist under
   `~/.opencodereview/sessions`; `~/.pi/agent` contains Pi model and
   authentication configuration. `--resume` continues a single interrupted
   session. Output formats are `text`, `json`, and `sarif`; audience is
   `human` or `agent`.

## Module seams

- `src/cli.ts` — thin production adapter over `src/ocr-v193/cli/index.ts` and `src/ocr-v193/cli/factory.ts`; injects real runner/preview factories and the `IO`/`readFile` seam; no engine switch; `runCli` is testable without `process.exit`.
- `src/index.ts` — minimal public facade re-exporting the OCR-backed `review` API and domain types.
- `src/ocr-v193/cli` — OCR-compatible `review`/`scan` commands, flag parsing, runner factories, and output rendering.
- `src/ocr-v193/agent`, `src/ocr-v193/llmloop`, `src/ocr-v193/tool` — per-file orchestration, model loop, and tool definitions.
- `src/ocr-v193/diff`, `src/ocr-v193/rules`, `src/ocr-v193/session`, `src/ocr-v193/scan`, `src/ocr-v193/template` — diff, rules, session persistence, scan batching, and prompt templates.

## Coverage and failure semantics

`ReviewResult.coverage` partitions `selected = completed + reused + failed + waived`.
`complete` means all selected items completed; `partial` means some failed but
not all; `failed` means all selected failed or a terminal error occurred;
`skipped` means no reviewable files were selected. Incomplete work never
becomes a clean review; partial/failed work remains visible.

Exit codes: `0` for `complete`/`skipped`, `2` for `partial`, `1` for `failed` or
invalid usage. Help exits `0`.

## Security and read-only guarantees

- Git invocations use argv arrays, never shell interpolation.
- Model-visible tools are explicitly allowlisted and bounded; no shell, edit, or write tools are exposed.
- Review operations do not modify the target repository.
- Repository `AGENTS.md`, skills, extensions, and prompts are never loaded into review sessions; repository content is untrusted evidence.
