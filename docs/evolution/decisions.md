# Decisions — evolution of the review engine

Append-only. Each entry: context → decision → consequences. Superseding a
decision adds a new entry naming the old one. Entries citing eval runs must
name the run ID under `eval/results/`.

- **D1 — 2026-09-10 — OCR demoted from specification to baseline.**
  Context: v0.4.0 fork audit complete; user wants an independent engine.
  Decision: OCR v1.9.9 behavior is the comparison baseline, not the contract;
  intentional behavior changes are allowed when mechanism, value, and tests are
  explicit. Approved by bermudi in session (direction level).
  Consequences: per-stage removals/changes below each need their own evidence;
  nothing changes without it.

- **D2 — 2026-09-10 — Evaluation design.**
  Context: general product, so no personal bug definitions.
  Decision: ground truth from maintainer-fix commits (defect = the issue a real
  fix commit addressed), clean commits for false-alarm rate, planted bugs as
  secondary regression suite. Findings judged blind by a model that is not the
  model under test. All comparisons pin one model resolved through Pi's
  default logged-in provider.
  Consequences: paid runs require explicit spend approval from bermudi before
  each batch (estimates first). Pending: approval, and confirmation of the
  pinned model.

- **D3 — 2026-09-10 — Review levels are four orthogonal knobs.**
  Context: survey of CodeRabbit/Greptile/Qodo/Graphite configuration surfaces
  (screenshots in session, 2026-09-10).
  Decision: profile (reporting strictness), gate (CI failure threshold), focus
  areas (topics, style opt-in), depth (deferred). No single "thoroughness mode".
  Consequences: each level must be scored separately in eval; a dial that
  doesn't move measured precision/recall gets cut.

- **D4 — 2026-09-10 — Style feedback is opt-in.**
  Context: inherited OCR checklists mix defect detection with style policing.
  Decision: default review contract reports consequential defects only;
  style/naming/formatting feedback lives behind a focus toggle.
  Consequences: takes effect with the contract-v2 flag in Phase 2; evidence
  required before it becomes the default.
