# Changelog

## Unreleased

- Cut review crawl cost: exact-duplicate `file_read` calls now get a short
  reminder instead of another full dump, and 8 duplicate-only rounds with
  no new evidence stop the file early instead of running to the round cap.
- Failed review items now keep the findings they already emitted (grace-round
  notes included), run the review filter over them, and persist them on the
  failure record — what the CLI shows and what the session stores agree.
- A missing `file_read` path now points the model at `file_find` first
  instead of guessing nearby paths.
- Live per-file status lines on stderr: file start, file done with note
  count and a run-level done counter, plus a quiet warning at half the
  per-file idle timeout. Agent-audience runs stay silent.
- The per-file timeout is now idle-based: each model response resets the
  window, so a slow-but-working file is never killed; a quiet file is
  aborted and classified as a timeout. Streaming progress keeps both the
  compression job timer and the per-file watchdog alive.

- Failed tool uses now show up in results with details instead of
  vanishing: output carries how many failed, which tool, and the arguments
  that were passed. Adopted surgically from OCR v1.11.4 (`0524d21`) and
  v1.11.3 (`b3704b8`).
- Mangled review notes from the model are now repaired instead of dropping
  the whole batch, with a warning left behind. Batches that can't be
  repaired safely keep the original error so the model retries. Adopted
  surgically from OCR v1.11.4 (`41917e2`).
- Git failures now surface git's own message instead of empty results, and
  untracked-file listing errors stop the review instead of reviewing
  half-blind. Adopted surgically from OCR v1.10.0 (`0c44f10`) and v1.11.3
  (`4cecf1e`).
- Project rule files are now confined to the repository: a symlinked or
  escaping `rule.json`, or a rule file reference pointing outside the repo,
  is rejected with a warning. Adopted surgically from OCR v1.11.1
  (`124bfc3`).
- JavaScript module files (`.mjs`/`.cjs`) get JavaScript review rules and
  `.cxx`/`.hxx` files get C++ rules instead of generic ones. Adopted
  surgically from OCR v1.11.2 (`b1ad13a`, `14fab72`).
- All warnings now go through one channel: rule-loader warnings accept an
  injectable sink (default stderr), repaired batches always warn, and tool
  persistence delivery failures warn instead of vanishing.
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
