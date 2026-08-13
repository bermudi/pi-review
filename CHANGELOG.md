# Changelog

## Unreleased

- Replace the diff-only, fail-open veto with mandatory evidence-backed finding verification. Only positively verified candidates with exact host-validated citations are emitted; verification failure now marks the file incomplete.

## 0.1.0 — 2026-08-12

- Reserve recovery capacity in the per-file tool budget so 30 normal evidence calls can still reach `submit_review`.
- Separate pre-dispatch exclusions from selected-file review coverage and keep cancellation in `skipped`.
- Bound risk plans to four prioritized risks with one evidence suggestion each.
