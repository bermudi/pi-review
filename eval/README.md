# eval/ — evaluation harness and evidence

Ground truth and design: `docs/evolution/decisions.md` (D2). Roadmap:
`docs/evolution/README.md`.

Layout:

- `corpus/` — case definitions (repo URL, pinned ref, target commit/parent,
  expected defect reference or `clean`). Manifest pins content hashes.
- `harness/` — typed code: corpus builder, runner (invokes pi-reviewer
  configs), blind scorer, report generator. Tested like product code; no paid
  calls in unit tests.
- `results/<run-id>/` — one directory per run: config, corpus manifest hash,
  pinned model, per-case outcomes, summary. Committed; never overwritten.

Rules:

- A run is reproducible: same corpus manifest + same config + same model must
  be re-runnable and comparable.
- No paid model batch without bermudi's explicit approval of the estimate.
- Large raw artifacts (transcripts, session JSONL) are gitignored; summaries
  are committed and citable by run ID.

Status: scaffolded 2026-09-10, no code yet — Phase 0.
