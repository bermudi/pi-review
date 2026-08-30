# Changelog

## Unreleased

- `--model` and the no-flag fallback now see providers registered by
  user-level pi extensions (proxies, aggregators such as kilo). Only
  user-scope extensions under the agent directory run, solely to collect
  provider registrations, in a neutral working directory and offline; a
  broken extension costs its provider only and produces a warning.
  Repository extensions are still never loaded or executed.
- `file_find` now supports subpath and cross-platform queries: queries
  containing `/` or `\\` fall back to full repository-relative path matching
  when basename matching finds nothing, and backslash separators are
  normalized. Tool schema descriptions updated to match. Adopted surgically
  from OCR commit `47192a2` (v1.11.0, PR #1075).
- The other-changed-files prompt context now includes per-file churn stats —
  `STATUS   path (+N/-M)` — so the model can gauge each sibling file's diff
  size before requesting it. Mechanism adopted from OCR commit `43ef414`
  (v1.11.0, PRs #1078/#1082).
- Relicense the project from GPL-2.0-only to GPL-3.0-or-later, add Apache-2.0
  attribution for the Open Code Review v1.9.3 source port, and pin that release
  as the behavioral compatibility target.
- Replace the diff-only, fail-open veto with mandatory evidence-backed finding verification. Only positively verified candidates with exact host-validated citations are emitted; verification failure now marks the file incomplete.

## [0.2.0](https://github.com/bermudi/pi-reviewer/compare/v0.1.0...v0.2.0) (2026-08-13)


### Features

* resume interrupted review sessions ([016ee97](https://github.com/bermudi/pi-reviewer/commit/016ee979eb09ce2259f39137e6efd1eca1fc7ac7))
* verify findings against cited evidence ([16cf39f](https://github.com/bermudi/pi-reviewer/commit/16cf39f3a4c083a88901c2134c6001d2830c1f3b))

## 0.1.0 — 2026-08-12

- Reserve recovery capacity in the per-file tool budget so 30 normal evidence calls can still reach `submit_review`.
- Separate pre-dispatch exclusions from selected-file review coverage and keep cancellation in `skipped`.
- Bound risk plans to four prioritized risks with one evidence suggestion each.
