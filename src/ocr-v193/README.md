# src/ocr-v193 — OCR v1.9.3 parity engine (fresh tree)

This tree is the behavioral port. See `docs/ocr-v1.9.3-port-plan.md` and `docs/ocr-v193-source-map.md`.

Rules:
- No import from legacy `src/reviewer.ts`, `src/pi-runner.ts` policy, `src/prompts.ts`, `src/tools.ts`, `src/phase-tools.ts`, `src/resolver.ts`, `src/change-map.ts`.
- Reuse low-level utilities (Git argv runner, diff parser, path safety) only after OCR-derived tests prove parity.
- Every file header records `Ported from <upstream path> at c35ddd7223f2b5540ce03aa43c9a25ef643fca27` + Apache-2.0 SPDX.
- Pi transport lives behind `src/ocr-v193/pi-adapter` and is tested via scripted transcript seam, not live models.

First slice: `internal/llmloop` (loop + compression + pool) through the public Pi adapter. See `docs/ocr-v193-reference-manifest.md` for parity status.
