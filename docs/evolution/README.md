# Evolution — from OCR fork to independent review engine

Status: **proposed** (direction user-approved 2026-09-10; phase sequencing still
open to revision). This file is the roadmap. Decisions and their evidence live
in `decisions.md`. Neither file is OCR parity documentation; the frozen fork
audit stays at tag `v0.4.0`.

## Goal

Re-architect the review engine around the change (not the single file), with a
small investigation loop and explicit review levels, keeping the existing
reliability machinery. Every behavioral replacement must be justified by an
eval run, not by taste.

## Non-goals

- No second engine tree, no versioned runtimes, no resurrection of removed
  legacy policy (project red lines).
- No execution/verification depth tier in v1 (TREX-style). Deferred until its
  own security design exists.
- No wholesale rewrite; migration is staged replacements behind flags.
- No personal bug definitions — this is a general product.

## Review levels (the four knobs)

Orthogonal by design; see D3 in `decisions.md`.

| Knob | CLI shape (working name) | Controls |
|---|---|---|
| Profile | `--profile quiet\|balanced\|assertive` | How much gets reported (precision/recall dial) |
| Gate | `--gate off\|all\|warning\|critical` | What fails CI / exit codes / SARIF |
| Focus areas | `--focus security,perf,bugs,style,tests,docs` | Which topics are in scope (style is opt-in, never default) |
| Depth | deferred | Optional paid verification pass |

## Phases

Each phase flips to `done` only when its evidence exists under `eval/results/`
and is cited in `decisions.md`. `blocked-user` means waiting on bermudi.

| # | Phase | Done when | Status |
|---|---|---|---|
| 0 | Stage-cost instrumentation + eval harness skeleton | Cost report per stage exists; scoring pipeline produces a summary from a scripted (unpaid) mock run | **done** 2026-09-11: `test/ocr/cost`, `test/ocr/agent/cost-instrumentation.test.ts`, `test/eval/mock-run.test.ts`; commits `9644f9a7`, `d35b3fad`; full suite 1695 pass |
| 1 | Public ground-truth corpus | ≥40 maintainer-fix cases + ≥20 clean cases + planted-bug suite, all hash-pinned in a corpus manifest | **in progress**: 40 candidates (30 defect + 10 clean) mined and API-verified in `eval/corpus/candidates.json` (`e9b0203f`); typed manifest + workspace provider pending |
| 2 | Review contract v2 behind flag (defect-focused brief, style→focus area) | A/B eval vs baseline on corpus; decision recorded with run ID | blocked-user (spend approval for first paid batch) |
| 3 | Loop simplification experiments (no-plan, no-filter, independently) | Each removal/keep decided by eval run | blocked-user (same approval) |
| 4 | Change-centered grouping + integration pass for large diffs | Multi-file bug cases in corpus improve without single-file regression | not started |
| 5 | Review-levels UX (`--profile`, `--gate`, `--focus`) | Each level scored separately; dial demonstrably moves precision/recall | not started |
| 6 | Cleanup: remove superseded paths, rewrite docs, version bump | `verify:release` green on the exact release commit | not started |

## Maintenance rules

- Roadmap status changes require a cited run ID (or user decision for
  `blocked-user`/sequencing changes).
- `decisions.md` is append-only; superseding a decision adds a new entry that
  names the old one.
- Raw eval artifacts that are large (transcripts, session JSONL) stay
  gitignored; summaries and manifests are committed.
