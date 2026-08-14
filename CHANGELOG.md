# Changelog

## Unreleased

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
