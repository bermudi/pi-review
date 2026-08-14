## The core problem: your drop funnel is invisible

pi-review has three sequential drop stages, each biased toward silence: the prompt ("Prefer silence over a weak or hypothetical finding"), added-line anchoring, and citation-based verification. Unanchored candidates at least emit a warning, but verification drops are **completely silent**:

[reviewer.ts:1244-1253](file:///home/daniel/.herdr/worktrees/pi-reviewer/worktree-silver-stone-6537/src/reviewer.ts)

The run printed `Warnings: (none)` and 2 findings. You cannot tell whether the 4 CodeRabbit findings were never raised, raised and unanchored, or raised and dropped as `unverified`. For a tool whose entire thesis is a precision/recall tradeoff, the tradeoff is unmeasurable. Everything below is guesswork until this exists.

Concretely: carry per-file counters (`submitted → anchored → verified/disproved/unverified`) into `ReviewResult`, emit them as an event, print one summary line, and expose dropped candidates with their verdict + citations behind a flag. Cheap, and it turns the next four items into measurements instead of opinions.

## Verification is structurally biased against absence and platform claims

`VERIFICATION_SYSTEM_PROMPT` requires byte-exact quotes that *positively* support the claim, and "Uncertainty is never verified":

[prompts.ts:91-93](file:///home/daniel/.herdr/worktrees/pi-reviewer/worktree-silver-stone-6537/src/prompts.ts)

Both CodeRabbit majors are unquotable in that frame: "`/proc/self/fd` doesn't exist on macOS" rests on platform semantics that appear nowhere in the repo, and "no code removes `leaseRoot` after the catch block" is a proof of absence. Meanwhile the one pi-review finding that survived (`cp` missing `timeout`) had a quotable positive anchor — consistent with this hypothesis, and testable once instrumentation lands.

Your tools already emit quotable negatives — `code_search` returns `"No literal matches found."` [tools.ts:775-776](file:///home/daniel/.herdr/worktrees/pi-reviewer/worktree-silver-stone-6537/src/tools.ts) — but nothing tells the verifier that an exhaustively-scoped no-match result is *positive* support for an absence claim. Teaching that pattern explicitly, and allowing a claim to be verified from cited code plus a stated stable-platform premise, closes a whole bug class without weakening byte-exact citation.

## Finding presentation

`content` is a single free-form field up to 10,000 chars with no schema description at all:

[tools.ts:122-131](file:///home/daniel/.herdr/worktrees/pi-reviewer/worktree-silver-stone-6537/src/tools.ts)

Hence the wall of text, and worse, process narration: "I confirmed this state is reachable in production", "confirmed by search". That is reviewer chain-of-thought leaking into output, which your own AGENTS.md forbids. CodeRabbit's shape is a one-line headline, 2-3 short paragraphs, then a diff.

- Add `title` (short, imperative) to the candidate schema; cap the body far below 10k and ban investigation narration in the prompt.
- Render `suggestionCode` as a real unified diff against `existingCode`, not `Existing:`/`Suggestion:` prefixes [cli.ts:589-596](file:///home/daniel/.herdr/worktrees/pi-reviewer/worktree-silver-stone-6537/src/cli.ts)
- Group by severity with counts, and lead with a compact summary instead of five full coverage lists.

## No time or cost feedback on a 20-minute run

`renderText` never prints `result.usage` or `result.elapsedMs`, though both are already in the result. Progress lines carry no elapsed time, no `n/total`, and interleave four workers' evidence calls into noise. Add a final `elapsed + tokens` line, prefix progress with `[3/14 · 4m12s]`, make it TTY-aware (one rewriting status line when interactive, plain lines when piped), and demote per-evidence lines to `--verbose` with a per-file rollup by default.

## Speed: planning doubles task count for unmeasured value

At `DEFAULT_PLAN_CHANGED_LINE_THRESHOLD = 50`, nearly every real file runs plan-then-review sequentially, so ~26 model tasks ran for 14 files at concurrency 4. Planning is advisory and fails open — its contribution to *verified* findings has never been measured. Once the funnel counters exist, A/B it on a fixed corpus and delete it if it doesn't move the number. Also: add an explicit `--no-plan` (today you disable it by passing an absurd `--plan-threshold`), and raise the default concurrency since tasks are provider-bound.

## CI gating is missing

`exitCodeForResult` keys only on status, so a review with four criticals exits `0`. There's no `--fail-on <severity>`, no SARIF, and no GitHub annotation format. For a tool meant to run in CI, that's the biggest functional gap after the funnel.

## Deliberate non-goal worth naming

"This whole module is Linux-only" has nowhere to live: per-file isolation plus added-line anchoring structurally forbids cross-cutting findings. If you ever want them, the honest version is a bounded synthesis pass over completed per-file results that still must anchor to one added line and still must pass verification — not a relaxation of anchoring.

One thing worth keeping in view: pi-review found the silent-`return`-in-tests issue that CodeRabbit missed entirely, and that's a higher-value finding than two of CodeRabbit's four. The goal is to stop paying recall for precision you can't measure — not to become CodeRabbit.Here's the full plan. Ordering principle: **make it measurable → make what it already finds land well → then change what it finds → then make it cheaper → then let it block CI.** Prompt changes come after instrumentation on purpose, because they're the only changes that need paid model runs to validate and the only ones that can silently trade away precision.

---

# Phase 1 — Make the drop funnel visible

**Goal:** every candidate that dies is counted and attributable. This is the prerequisite for Phases 4 and 5 and it fixes an honesty gap: today `no findings` and `5 candidates dropped by the verifier` render identically.

**Changes**

- `src/types.ts`: add a `FindingFunnel` contract (`submitted`, `anchorRejected`, `verified`, `disproved`, `unverified`) and optional `funnel` on `ReviewResult` plus per-path detail. Extend the `file_completed` event with the same counts (additive, so existing consumers keep working).
- `src/reviewer.ts`: `WorkflowResult`/`IndexedWorkflowResult` carry counts; `reviewFile` records `toolkit.candidates.length`, anchor rejections in the resolve loop, and the verdict tally from `verification.value.decisions` where drops are currently silent. Aggregate deterministically in `buildResult` alongside coverage.
- `src/cli.ts`: one summary line (`14 files · 12 candidates → 9 anchored → 2 verified`), and a `--show-dropped` flag that prints dropped candidates with verdict and citations to **stderr**, clearly labeled unverified. Off by default — printing unverified model output by default would undercut the whole trust thesis.

**Tests:** `test/reviewer.test.ts` with the existing stub executor — fabricate candidates that (a) anchor and verify, (b) fail anchoring, (c) come back `unverified`/`disproved`, and assert counts and determinism under concurrency. CLI rendering tests for the summary and `--show-dropped`. No model calls.

**Done when:** a review that emits zero findings still tells you exactly where the candidates went.

---

# Phase 2 — Finding shape and result rendering

**Goal:** the output stops being a wall of text and stops leaking the reviewer's investigation narrative.

**Changes**

- `src/tools.ts`: add `title` to `candidateFindingParameters` (required in the schema, short bounded string), and cut `MAX_COMMENT_CONTENT_LENGTH` from 10,000 to something like 1,500. Add `description` metadata to both fields — right now the model gets no shape guidance at all.
- `src/types.ts`: `title` optional on `CandidateFinding` so external constructors and `resolveFinding` callers don't break; renderer falls back to the first sentence of `content`. Ship as a minor version.
- `src/prompts.ts`: state the comment shape explicitly — defect, impact, fix — and forbid narrating the investigation (`I confirmed…`, `confirmed by search`). That narration is chain-of-thought leakage against your own red line, and it's the single biggest reason the findings read worse than CodeRabbit's despite being just as valid.
- `src/cli.ts`: severity-grouped findings with counts; `title` as the headline; `suggestionCode` rendered as a unified diff against `existingCode` instead of `Existing:`/`Suggestion:` prefixes; coverage lists truncated (`… and 6 more`) with the full lists still in `--json`; final line with `elapsedMs` and `usage`, both of which are already in the result and never printed.

**Tests:** `test/tools.test.ts` schema acceptance/rejection for `title` and the new body cap; `test/cli.test.ts` golden renders for grouping, diff rendering, truncation, summary. `test/prompts.test.ts` for the new instruction lines.

**Done when:** a finding fits on a screen and the fix is a copyable diff.

---

# Phase 3 — Progress for long runs

**Goal:** a 20-minute run stops looking hung.

**Changes**

- `src/cli.ts`: `[n/total · 4m12s]` prefixes; TTY-aware output (one rewriting status line interactively, plain append-only lines when piped, since stderr is already the diagnostic stream); per-evidence lines demoted behind `--verbose` with a per-file rollup by default (`delegate.ts · 5 evidence calls · 2m03s`). Optional colour gated on TTY plus `NO_COLOR`; `renderText` stays ANSI-free so the golden tests and JSON path are untouched.
- No changes outside `cli.ts` — the event vocabulary from Phase 1 is already sufficient.

**Tests:** existing CLI IO seam with a fake non-TTY and fake TTY; assert the piped output stays deterministic and ANSI-free.

---

# Phase 4 — Verification recall (the substantive fix)

**Goal:** stop silently dropping absence and platform-portability claims, without weakening byte-exact citation. Phase 1's counters tell you whether this is even the bottleneck before you touch a prompt.

**Changes**

- `src/tools.ts`: make negative results *quotably exhaustive*. `"No literal matches found."` doesn't state what was searched, so it can't support an absence claim. Emit scope and totals (`No literal matches for "test.skipIf" in 41 files / 182,431 bytes scanned (scan not capped).`) and keep the existing cap notices, so a verifier quoting it is citing a real exhaustiveness claim.
- `src/prompts.ts` (verification): add the negative-evidence pattern explicitly — an exhaustively scoped no-match result plus the diff line that requires the thing is positive support for an absence claim. Add a narrow rule for claims resting on stable platform semantics: the candidate must state the general premise, cite the code that depends on it, and stay `unverified` if the premise is niche or version-dependent. Keep "uncertainty is never verified" intact.
- Optionally add a bounded enum `reason` (`insufficient_evidence` / `contradicted` / `out_of_scope`) to verification decisions for `--show-dropped`. Enum, not prose, to avoid re-importing chain-of-thought.

**Validation:** a dev script (not a test — no paid calls in the suite) that runs a fixed corpus, the `pi-delegate` diff being the obvious first benchmark, writes to `--session-dir`, and prints the Phase 1 funnel. Accept the change only if verified findings go up while dropped-candidate spot checks stay clean. The two CodeRabbit majors are the concrete target: `/proc/self/fd` portability and the leaked `0o500` lease directory.

**Risk:** this is the one phase that can degrade precision. It's gated behind measurement for exactly that reason.

---

# Phase 5 — Cost and latency

**Goal:** cut wall clock without cutting verified findings.

**Changes**

- Measure the planner. At a 50-line threshold it roughly doubles task count and it has never been shown to move *verified* findings. Use the Phase 4 harness: run the corpus with planning on and off, compare funnels. Three possible outcomes: keep it, raise the default threshold, or fold risk-planning into the review task's first turn (halves task count, costs you the current isolation property where plan output is re-injected as untrusted data — evaluate, don't presume).
- Add explicit `--no-plan`; disabling planning today requires passing an absurd `--plan-threshold`.
- Revisit `DEFAULT_CONCURRENCY = 4`. Tasks are provider-bound, not CPU-bound; raise the default and document the rate-limit tradeoff.
- Consider a per-run deadline (`--timeout`) so a stalled provider can't hold a review open indefinitely — it would surface as `partial` coverage, which your semantics already handle honestly.

**Done when:** the corpus review is materially faster at equal or better verified-finding count, with the decision backed by recorded numbers.

---

# Phase 6 — CI gating and integrations

**Goal:** findings can block a pipeline. Last, because it's the phase that most depends on the earlier ones being trustworthy — gating on noisy findings is worse than not gating.

**Changes**

- `--fail-on <severity>`: opt-in, since a review with four criticals currently exits `0` and the documented exit table treats `complete` as success. Keep the existing mapping as the default and document the new precedence (coverage failures still win over finding severity).
- SARIF output for GitHub code scanning; `ruleId` from `category` plus a stable finding kind, with `partial` coverage represented rather than hidden.
- GitHub Actions annotation format (`::warning file=…,line=…`) for inline PR comments without a server.
- Optional `--patch` output emitting `suggestionCode` as an applicable unified diff — the anchoring guarantees already give you exact target line ranges, so this is nearly free once Phase 2 lands.
- README/architecture updates for the new exit semantics and formats.

---

## Cross-cutting

- Every phase: `bun run check`, narrowest affected test file first, then `bun test`, then `bun run build` when package behavior changes. No paid or network model calls in the suite.
- `docs/architecture.md` and README updated in the same commit as the behavior, not batched at the end.
- Public-surface additions stay additive (`ReviewResult.funnel`, optional `Finding.title`, new event fields) so nothing forces a major bump before the deferred `maxToolRounds` rename.

## Deliberately not in this plan

- **Cross-file synthesis pass.** "This whole module is Linux-only" has no home under per-file isolation plus added-line anchoring. If you ever want it, the honest form is a bounded pass over completed per-file results that still anchors to one added line and still verifies — a separate design, not a phase.
- **Markdown/docs review.** Already reachable via `--include '*.md'`; the default extension allowlist is a deliberate precision choice.
- **Chasing CodeRabbit's recall.** pi-review found the silently-passing test guard that CodeRabbit missed entirely, and that's worth more than two of CodeRabbit's four. The plan buys back recall you can *see* you're losing, not recall in general.
