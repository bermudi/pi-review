# Fix Plan

Derived from a code review pass over the `src` tree. Every claim below was
verified against the current code at the time of writing; file:line anchors are
approximate and may drift as code changes. Items are grouped into
commit-sized units that are independently mergeable, ordered by
impact × confidence ÷ risk.

## Verified findings

- **Budget baked in** — `prompts.ts` interpolates `${DEFAULT_MAX_TOOL_CALLS}`
  at module load; `PerFileReviewPromptInput` has no budget field. With
  `--max-tool-rounds N` the model steers off 32 and learns N only from an error.
- **Dispatcher error off-by-one** — `tools.ts` throws at
  `calls >= maxToolCalls - 1` (i.e. when 31 are used) but reports `(32)`.
- **Dead `invokeTask` cap** — `reviewer.ts` passes `maxToolStarts: maxToolRounds`
  (N), `makeTask` sets `N+1` on the task, and `pi-runner.ts` precedence is
  `normalized.maxToolStarts ?? runOptions.maxToolStarts` — task always wins, so
  the run-option is inert. `budget-composition.test.ts` builds its task directly
  with `RUNNER_CAP` and would not notice a `makeTask` regression.
- **Plan/veto inherit review budget** — all three phases go through `makeTask`;
  plan/veto toolkits have no call counter (only `ensurePending`), so the runner
  cap is the sole bound. `--max-tool-rounds 1000` hands those phases ~1001 starts.
- **`code_search` O(snapshot) git spawns** — calls `listTargetFiles` then
  `readTargetFile` per file; in snapshot mode each read is a whole-tree `ls-tree`
  + `cat-file -s` + `cat-file blob`, with no caching anywhere.
- **`reviewFile` triplication** — three near-identical build→invoke→check
  blocks; fail-closed (review) vs fail-open (plan/veto) is duplicated control
  flow rather than a policy argument. Usage is dropped on the throw path.
- **Alias sprawl / `PiTask.tools` overload** — `index.ts` exports none of the
  ~20 internal aliases; `PiTask.tools` means *definitions* or *allowlist* by
  element type.
- **Smaller notes** — `code_search` lacks the `\0` guard `file_find` has;
  prompt calls reads "target snapshot" even in workspace mode (live reads);
  `statusForCoverage` returns `"complete"` when abort lands post-completion;
  public `types.ts` arrays are mutable while internal options are readonly;
  `DEFAULT_MAX_CHANGED_LINES`/`MAX_REVIEW_DIFF_BYTES` are hardcoded, not options.

---

## Group A — Budget correctness (one commit, land first)

The model currently steers off a wrong number and learns the real one only from
an error. All four sub-fixes are the *same* defect (budget knowledge duplicated,
not derived), so they belong together.

### A1. Parameterize the review prompt budget
Add `readonly maxToolCalls: number` to `PerFileReviewPromptInput`. Make
`FILE_REVIEW_SYSTEM_PROMPT` a function `fileReviewSystemPrompt(maxToolCalls)` and
have `buildFileReviewPrompt` inject it. `reviewer.ts` already computes
`options.maxToolRounds ?? DEFAULT_MAX_TOOL_CALLS` for the toolkit — pass that
same value into `buildFileReviewPrompt`. One source of truth: the dispatcher
budget N.

### A2. Fix the dispatcher error wording
`tools.ts` → `Exploration budget exhausted (${state.calls} of
${state.maxToolCalls} used); only submit_review remains.` Removes the off-by-one
and tells the model exactly what to do next, at the moment it decides whether to
submit.

### A3. Delete the dead run-option cap
Remove the `maxToolRounds` parameter from `invokeTask` and the `maxToolStarts`
field it sets — `makeTask` already owns the cap. Then make
`budget-composition.test.ts` route through `Reviewer.makeTask` (or a shared
`buildTask` function) instead of hand-constructing `maxToolStarts: RUNNER_CAP`,
so a future regression in `makeTask` actually trips the test.

### A4. Give plan/veto their own start limit
`makeTask` takes a phase argument (or a `maxToolStarts` override). Plan/veto get
a small constant instead of `N+1`.

> **Judgment call:** the review suggests 2. Prefer **3** — these phases have
> only their terminal tool, so every start is a submission attempt; 2 allows
> exactly one recovery, 3 allows one bad + one recovered + a buffer. Still a
> rounding error vs the current 33.

**Verification:** `prompts.test.ts` cases for configured-vs-default budget
strings; extend `budget-composition` with a case that builds the task via the
production path; assert plan/veto tasks carry the small constant.
`bun test test/prompts.test.ts test/budget-composition.test.ts` then
`bun run check`.

---

## Group B — `code_search` resource ceiling + caching (independent commit)

Ranked above the budget issue in practice — real cost and a genuine gap against
the AGENTS.md "resource ceilings" line. Independent of A, so it can land in
either order.

### B1. Resolve the file list once per target
In `git.ts makeTarget`, memoize `listFiles` (workspace: one `ls-files`;
snapshot: one `snapshotEntries` whole-tree `ls-tree`). `code_search`/`file_find`
currently trigger an `ls-tree` per read via `listTargetFiles`.

### B2. Memoize the snapshot entry map
`readSnapshotBytes` calls `treeEntry` (whole-tree walk) per file. Build a
`Map<path, TreeEntry>` once from the memoized `snapshotEntries` result and look
it up, so `cat-file -s`/`cat-file blob` are the only per-read spawns.

### B3. Bounded blob cache
Add an LRU-ish cache (capped by count and bytes) keyed by `commit:path` for
snapshot reads, so a search touching the same file twice (or two tasks sharing a
target) doesn't re-spawn. Keep the cap modest and the eviction honest.

### B4. Explicit scanned-files/scanned-bytes ceiling with a visible notice
The current caps bound *output*, not *host work*. Add a max-files-scanned and
max-bytes-read budget; when hit, stop and append a
`[scan capped: N files / M bytes]` notice so the model sees the search was
incomplete rather than just slow. This is the actual "resource ceiling" AGENTS.md
asks for.

> **Scope guard:** B1/B2 change `ReviewTarget` behavior. Keep the memoization
> internal to the git target factory (not on the `ReviewTarget` interface) so the
> public seam stays live-read semantics in workspace mode.

**Verification:** a test with a fake target counting `listFiles`/`readFile`
invocations — assert one `listFiles` call across many searches, and that the scan
ceiling short-circuits with a notice. `bun test test/tools.test.ts`.

---

## Group C — `reviewFile` consolidation + usage honesty (after A)

Touches the same region A just changed, so sequence it after A. Medium
behavioral risk — do it as a pure refactor first, then layer the bug fix.

### C1. Extract `runPhase`
A private method `runPhase(prompt, tools, terminalTool, { failOpen })` returning
`{ value?, outcome, usage }` collapses the three blocks in `reviewFile`. The
fail-closed (review) vs fail-open (plan continues, veto keeps findings)
asymmetry becomes a policy argument instead of duplicated control flow — which
is how the dead-cap bug in A3 slipped in. Keep the asymmetry; encode it once.

### C2. Capture usage on throw
In C1's structure, accumulate `usage` from `outcome.usage` even on the
non-fatal (fail-open) paths, and track best-effort usage for the throw path.
Have `invokeTask`/`runPhase` return the usage it observed rather than dropping
it when the outcome is rejected. Fixes `ReviewUsage` understatement on
planner/veto failure.

**Verification:** `bun test test/reviewer.test.ts` — add a case where the
planner phase "fails" (non-complete outcome or throw) and assert its usage is
still counted. Re-run the full suite; the refactor must be behavior-preserving.

---

## Group D — Seam and alias cleanup (lowest urgency)

Internal-only clutter; safe to defer.

### D1. Fix `PiTask.tools` overload (the real defect)
`pi-runner.ts` — `tools` means *definitions* or *allowlist* depending on whether
every element is a string. At a capability-bounding boundary that is the wrong
kind of clever (empty array silently = "no tools and no allowlist"; a
heterogeneous array falls into the definitions branch then fails the name
check). Production already sets `customTools` + `allowedTools` explicitly and
never uses `tools`, so drop the `tools` field entirely (or make it mean one
thing). One field, one meaning.

### D2. Remove dead internal aliases
`buildPlanPrompt`/`buildReviewPrompt`/`buildVetoPrompt` (`prompts.ts`),
`createReviewTools`/`maxCalls`/`completionState`/`completed` (`tools.ts`),
`createPlanTools`/`createRiskPlanToolkit`/`createVetoFilterToolkit`
(`phase-tools.ts`), and the runner aliases (`TaskRunner`, `PiRunnerOptions`,
`runTask`, `toolAllowlist`, etc.) are exported but not re-exported by `index.ts`
and barely used internally. Grep-verify callers first; remove only the truly
unreferenced ones. `FileReviewResult` in `types.ts` appears unused — confirm and
drop.

**Verification:** `bun run check` (typecheck catches orphaned references);
`bun test`.

---

## Group E — Small honesty fixes (batch, low risk, independent)

Each is a few lines; bundle into one "honesty" commit or fold individually.

- **E1.** `code_search` `\0` rejection — add `params.pattern.includes("\0")` to
  the guard (mirror `file_find`). Low impact (a `\0` pattern just won't match)
  but closes the inconsistency.
- **E2.** Prompt snapshot wording — the review system prompt and the `file_read`
  description say "target snapshot" even in workspace mode where reads are live.
  Parameterize the wording by mode, or soften to "target tree (live in workspace
  mode)". `docs/architecture.md` is already honest; the prompt should match.
- **E3.** `statusForCoverage` post-completion abort — when all selected files
  completed, the `aborted` flag is ignored and status is `"complete"` with no
  warning. Narrow window, but "complete" is the one word this project promises
  not to overstate. Either downgrade to `"partial"`, or at minimum emit a
  warning. Lean toward a warning rather than downgrading — the work did finish;
  the abort is informational.
- **E4.** Readonly discipline inversion — public `types.ts` arrays are mutable
  while the internal `NormalizedReviewOptions` is readonly. Tighten the public
  contracts to `readonly` since that is what callers can actually corrupt.
- **E5.** Config surface — either expose `DEFAULT_MAX_CHANGED_LINES` and
  `MAX_REVIEW_DIFF_BYTES` as `ReviewOptions` fields, or document in `types.ts`
  that they are fixed policy. Prefer documenting rather than exposing — these
  are guardrails, not tuning knobs.

**Verification:** `bun test` + `bun run check` after the batch.

---

## Decisions to make (not fixes)

- **"Rejected calls consume budget."** The review flags a schema-invalid
  `submit_review` burning a slot at the budget edge. Keep the current behavior:
  counting all calls (success or failure) is a defensible DoS bound on total
  model-driven work, and the runner's hard start cap is the real floor
  regardless. Making the dispatcher not count failures widens the loop a model
  can drive. If the edge case bites in practice, the cheaper fix is reserving
  *two* slots (A2 already moves the model to submit earlier). Want evidence
  before changing this.
- **Public `maxToolRounds` → "tool calls" rename.** The vocabulary sprawl
  (`maxToolRounds` / `DEFAULT_MAX_TOOL_CALLS` / `maxToolCalls` / `maxToolStarts`)
  is real, but renaming the public `ReviewOptions.maxToolRounds` and the
  `--max-tool-rounds` CLI flag is a **breaking change**. Do the cheap
  non-breaking parts now (fix the CLI help text from "rounds" to "tool calls";
  align internal names) and defer the public rename to a major version with a
  deprecated alias.

---

## Suggested merge order

1. **A** (budget) — correctness the model sees, smallest, best-tested.
2. **B** (code_search ceiling/caching) — independent, biggest practical win,
   resource-safety gap.
3. **E** (honesty batch) — cheap, independent, low risk.
4. **C** (reviewFile refactor) — after A settles the region.
5. **D** (seam cleanup) — last, non-urgent.

A and B are the two to ship immediately and independently.
