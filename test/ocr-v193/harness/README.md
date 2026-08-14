# Differential harness (OCR v1.9.3 vs Pi parity)

Pinned reference: tag `v1.9.3`, object `4d796ae54cabdcf4e22b69ef502ed8871456a909`, commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`.

## What it does

- Verifies the pinned tag/commit in `../open-code-review` (fails fast if not present — never tests against `main`).
- Builds fixtures as temp Git repos with fixed clocks and argv-array git (deterministic).
- Provides a Bun.serve OpenAI-compatible fake server (records requests, supports stream and delay) — no network beyond localhost.
- Runs the Pi parity engine via the provider-agnostic `ScriptedTransport` seam (no Pi SDK, no credentials) — diff acquisition, file selection, loop, `code_comment` incremental collection, `task_done`.
- Optionally builds the OCR v1.9.3 binary from a `git archive` of the tag and runs `ocr review --preview` against the same temp repo (argv arrays, no shell).
- Compares field-by-field: selected/excluded/completed/failed, tool definitions per phase, model-request count, tool calls/args/results, comments before/after, stop reason, coverage, usage, text/json/sarif output, checkpoint transitions. Writes mismatch artifacts.

## Layout

- `pinned.ts` — tag/commit guard
- `types.ts` — shared contracts
- `fixture.ts` — temp repo builder (workspace/range/commit)
- `fake-server.ts` — Bun.serve scripted server (provenance: spike/feasibility-v2.ts)
- `pi-runner.ts` — Pi engine runner (ScriptedTransport + Agent/Runner)
- `ocr-runner.ts` — OCR binary builder & spawner (git archive)
- `comparer.ts` — field-level comparer + artifact writer
- `fixtures/workspace-code-comment-task-done.ts` — minimal vertical slice (one workspace diff through code_comment + task_done)
- `index.ts` — CLI entry point

## Usage

```bash
# Pi-only smoke of the vertical slice (no OCR binary needed, no network)
bun run test/ocr-v193/harness/index.ts --no-ocr

# Full run with OCR preview comparison (builds OCR binary via git archive, needs Go)
bun run test/ocr-v193/harness/index.ts --artifacts /tmp/harness-artifacts

# Entry via package script
bun run harness -- --no-ocr
```

## Determinism

- Fixed clock (`2026-01-01T00:00:00Z`), `<TMP>` path normalization, `<PORT>` normalization, deterministic SHAs via `GIT_AUTHOR_DATE`.
- No paid model, no external network. Fake server is localhost with port 0.

## Provenance

Copied logic (fake server) retains Apache-2.0 header; modifications under GPL-3.0-or-later per `LICENSES/Apache-2.0.txt`.
