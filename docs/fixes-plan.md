# Review fixes plan

Ordering principle: **make the precision/recall tradeoff measurable, improve the
presentation of findings already trusted, then change verification behavior,
measure cost, and finally let findings block CI.**

Prompt changes come after instrumentation because they require paid model runs
to validate and can silently trade precision for recall.

## Problems this plan addresses

### The candidate funnel is invisible

The reviewer has several silence-biased stages: the review prompt, added-line
anchoring, and citation-based verification. The host can observe candidates
only after a valid atomic `submit_review`; it cannot count ideas the model may
have considered before that submission.

Once candidates have been submitted, however, every one must receive a
host-visible terminal disposition. Today unanchored candidates warn, while
verification drops and candidates lost during verification failure or abort do
not appear in the result. A clean review and a review that dropped several
plausible candidates can therefore look identical.

### Absence and platform claims need different evidence mechanisms

An exact literal no-match can support a narrow absence claim only when the host
can prove that the stated scope was scanned completely. It does not prove that
equivalent behavior is absent.

Platform claims are different. Facts such as operating-system path semantics do
not become trustworthy because a model calls them "stable." They must either
remain unverified or cite a versioned, host-controlled platform-facts source.
The verifier must not silently rely on model prior knowledge.

### Finding presentation obscures useful information

Candidate `content` is currently one large free-form field. This encourages
wall-of-text comments and investigation narration. Findings need a short title,
a bounded defect/impact/fix body, severity grouping, and a compact coverage
summary.

`existingCode` is normalized during anchor resolution, so it does not preserve
the exact source bytes needed for an applicable patch. The CLI can render a
display-only `-`/`+` suggestion, but patch generation requires a separate exact
edit contract.

### Long reviews provide poor progress and cost feedback

Elapsed time and token usage exist in `ReviewResult` but are not rendered.
Concurrent per-tool progress is noisy and does not show settled files, active
files, or elapsed time. Supporting those requires a stateful reporter rather
than formatting each event independently.

### Planning cost and CI behavior are unmeasured or unspecified

Planning can nearly double the model-task count, but its contribution to
verified findings has not been measured. CI also cannot fail on findings, and
the proposed machine-readable formats need explicit exit, escaping, and
partial-coverage contracts.

---

# Phase 1 — Make every submitted candidate accountable

**Goal:** preserve an exhaustive funnel for completed and failed file
workflows. This phase is a prerequisite for changing verification or measuring
planning.

## Data contract

Add a `FindingFunnel` with:

- `submitted`
- `anchorRejected`
- `verified`
- `disproved`
- `unverified`
- `incomplete`

For every file that produced a valid atomic review submission, enforce:

```text
submitted =
  anchorRejected +
  verified +
  disproved +
  unverified +
  incomplete
```

`incomplete` means the host received the candidate but the workflow ended
before assigning another terminal disposition, including:

- abort before or during anchor resolution;
- verification-tool initialization failure;
- verifier startup or execution failure;
- abort during verification;
- missing or unusable exhaustive verification output.

A failure before a valid `submit_review` has `submitted = 0`; possible
unsubmitted model thoughts are unknowable and must not be estimated.

Store deterministic aggregate counts and per-file counts in `ReviewResult`.
Per-file funnel records must include the path and whether the file workflow
completed or failed. Funnel records accompany failed coverage rather than being
emitted only for successful files.

Extend both `file_completed` and `file_failed` events with an optional additive
`funnel` field. The reviewer should emit it whenever a terminal file event is
produced. Keeping the event field optional avoids breaking callers that
construct events, while the built-in reviewer guarantees it for dispatched
file workflows.

## Optional dropped-candidate diagnostics

Counts cannot reconstruct candidate content, verifier verdicts, or citations.
Add an explicit library option such as
`includeDroppedFindings?: boolean`. When enabled, return an optional bounded
collection:

```text
droppedFindings: {
  items: DroppedFinding[]
  omitted: number
}
```

Each item preserves:

- file path;
- original zero-based submitted candidate index;
- the original submitted candidate fields;
- disposition: `anchor_rejected`, `disproved`, `unverified`, or `incomplete`;
- a bounded reason enum, not model-authored reasoning;
- verifier citations when a verifier decision supplied them.

Anchor-rejected and incomplete candidates may have no citations. Preserve the
original submitted index through anchoring and verification; do not renumber
the resolved subset. Bound the collection across the whole review with a fixed
documented ceiling, sort it deterministically, and report the omitted count.

`--show-dropped` enables collection and renders these records to stderr,
clearly marked as untrusted and not verified. It is off by default and is
available only with human-readable text output.

## Implementation

- `src/types.ts`: add funnel, per-file funnel, and bounded dropped-diagnostic
  contracts; add the explicit collection option and optional result data.
- `src/reviewer.ts`: carry original candidate indices and funnel state through
  `WorkflowResult`/`IndexedWorkflowResult`; finalize all known candidates on
  every return path; aggregate by path rather than task completion order.
- `src/tools.ts`: add a bounded verification reason enum such as
  `insufficient_evidence`, `contradicted`, and `out_of_scope`. Host-generated
  incomplete reasons should distinguish `aborted` and
  `verification_failed`.
- `src/cli.ts`: render a compact summary, for example
  `14 files · 12 submitted · 3 anchor-rejected · 2 verified · 1 incomplete`.

## Tests

Use the existing stub executor; make no network calls.

- anchor rejection;
- verified, disproved, and unverified decisions;
- abort after submission and during verification;
- verification-tool initialization and verifier execution failure;
- failed files retaining funnel data;
- the funnel equation on every path;
- deterministic aggregation and dropped-item ordering under concurrency;
- collection disabled, enabled, and truncated;
- CLI labeling and stderr placement.

**Done when:** every host-observed candidate is counted exactly once, including
when its file fails.

---

# Phase 2 — Improve finding shape and result rendering

**Goal:** make trusted findings concise and readable without implying that
model suggestions are directly applicable patches.

## Changes

- `src/tools.ts`: require a short bounded `title` in the model submission
  schema; add descriptions for `title` and `content`; reduce the content limit
  from 10,000 characters to a documented bound such as 1,500.
- `src/types.ts`: make `title` optional on the public `CandidateFinding` type so
  existing external constructors remain compatible.
- Propagate title through submission capture, anchor resolution, verification
  prompts, deterministic finding sorting, JSON output, and text rendering.
- `src/prompts.ts`: require the body to state defect, impact, and practical fix.
  Forbid investigation narration such as "I confirmed" or "confirmed by
  search." Evidence citations belong to verification data, not process
  narration.
- `src/cli.ts`: group findings by severity with counts, use the title as the
  headline, truncate coverage lists in text output, and retain complete lists
  in JSON.
- Render `existingCode` and `suggestionCode` as an **illustrative**
  line-oriented `-`/`+` block. Do not include patch file headers or claim it can
  be applied.
- Add a final elapsed-time and token-usage summary using the existing
  `elapsedMs` and `usage` fields.

## Tests

- schema acceptance and rejection for title and body limits;
- title survival through resolution, verification, sorting, and rendering;
- fallback title behavior for externally constructed findings without title;
- severity grouping, coverage truncation, elapsed time, and token totals;
- display-only suggestion rendering with multiline and newline edge cases;
- ANSI-free deterministic text and unchanged exact JSON serialization.

**Done when:** a finding fits on one screen, has a useful headline, and its
suggestion is visibly helpful without being represented as an applicable
patch.

---

# Phase 3 — Add stateful progress for long runs

**Goal:** show that a long concurrent review is alive without flooding stderr.

## Reporter contract

Replace independent `formatProgress(event)` use with a small stateful progress
reporter. It tracks:

- total, settled, active, completed, and failed files;
- per-file start time and evidence-call count;
- whole-run elapsed time;
- whether verbose tool events are enabled.

Inject the clock and terminal capabilities (`now`, TTY detection, color
support) rather than reading global time and TTY state inside formatting logic.
Color is enabled only on a TTY and respects `NO_COLOR`.

The existing events plus Phase 1 terminal funnel fields are sufficient inputs;
the state itself is new.

## Output behavior

- Interactive stderr: rewrite one bounded status line containing settled/total,
  elapsed time, and concurrent active files. Warnings and failures remain
  durable lines.
- Piped stderr: emit deterministic append-only lines; never emit cursor control
  codes or color.
- Default: suppress individual evidence-tool starts and print a per-file
  rollup such as `delegate.ts · 5 evidence calls · 2m03s`.
- `--verbose`: retain bounded per-evidence lines.
- Keep final text/JSON/SARIF output on stdout and progress on stderr.

## Tests

Use fake clocks and fake terminal capabilities for:

- overlapping active files and out-of-order completion;
- correct settled/total and elapsed values;
- TTY rewriting;
- deterministic non-TTY output;
- `NO_COLOR`;
- verbose and default evidence behavior;
- warning/failure output while a status line is active.

**Done when:** concurrent activity and elapsed time are visible, while piped
logs remain stable and ANSI-free.

---

# Phase 4 — Improve verification recall without weakening evidence

**Goal:** support narrowly provable absence and platform claims while keeping
positive, host-validated citations mandatory.

Phase 1 measurements must show that verification is the relevant drop stage
before this phase changes prompts.

## 4A — Exhaustive literal-search evidence

Change search results to report a structured completeness record containing:

- exact searched literal and normalized scope;
- candidate files considered;
- files and bytes fully scanned;
- files skipped with bounded reasons, including binary, oversized, policy
  exclusion, and read failure;
- every scan and result/output limit and whether it was reached;
- an `exhaustive` boolean computed by the host.

`exhaustive` is true only when every file eligible for the stated scope was
fully scanned and no scan cap, read failure, or unsupported-file skip could
hide a match. Output truncation must be distinguished from scan truncation.

Make the human-readable evidence quotable, for example:

```text
No literal matches for "test.skipIf" in scope "test/".
Scanned 41/41 eligible files and 182,431 bytes.
Skipped: 0. Scan limits reached: none. Exhaustive: yes.
```

The verification prompt may treat this as positive support only for absence of
that exact literal in that exact scope. It must explicitly reject the inference
that no equivalent behavior exists. Incomplete search remains useful context
but cannot verify an absence claim.

## 4B — Host-controlled platform facts

Do not add a prompt exception for uncited "stable platform premises."

First define a host-owned, versioned platform-facts source. A suitable mechanism
is a read-only allowlisted tool whose records have:

- stable fact ID;
- exact statement;
- platform and version applicability;
- source/version metadata maintained with the package.

Tool output enters the existing evidence recorder and is cited with byte-exact
quotes like repository evidence. Verification may combine a cited platform fact
with cited code showing that the changed line depends on it. If the allowlist
has no applicable fact, the claim remains `unverified`.

Repository content and caller-provided background do not become trusted
platform facts. Adding or changing a fact requires focused contract tests and
documentation review. If maintaining this source is not worthwhile, keep
platform-only claims unverified rather than weakening the trust model.

## Validation

Create a development benchmark command, not a paid-call test. It runs a fixed,
pinned corpus with session persistence and records:

- per-file and aggregate funnels;
- dropped-diagnostic samples;
- verified findings;
- elapsed time and token use;
- model and reviewer version/configuration.

Evaluate absence-search changes separately from platform-fact changes. Accept a
change only when verified recall improves and manual review of newly verified
findings shows no precision regression. A no-match prompt tweak alone is not
enough evidence.

**Done when:** every newly supported claim cites host-validated evidence, and
the fixed corpus demonstrates the improvement.

---

# Phase 5 — Measure and reduce cost and latency

**Goal:** reduce wall-clock time without reducing verified findings or
misrepresenting cancellation as a hard deadline.

## Changes

- Add explicit `--no-plan`.
- Run the fixed corpus with planning on and off. Compare verified findings,
  complete funnels, tokens, and elapsed time. Depending on the result, keep
  planning, raise its threshold, or remove it. Do not fold planning into the
  review task without separately evaluating the loss of the current isolation
  boundary.
- Measure concurrency levels against the same corpus and provider limits.
  Increase the default only when wall-clock improvement is repeatable and
  failure/rate-limit behavior does not worsen. Provider-bound work alone is not
  evidence that a higher default is safe.
- If `--timeout` is added, define it as a best-effort run budget that requests
  cancellation and returns partial/failed coverage once cleanup completes.
  Current session abort cleanup can wait indefinitely, so it cannot promise a
  hard return deadline.
- A hard deadline requires a separate bounded-cleanup design covering active Pi
  sessions and executor shutdown. Do not race a return while silently leaking
  active work.
- Inject timers in timeout tests.

## Tests and measurement

- parsing and behavior for `--no-plan`;
- best-effort timeout before dispatch, during review, and during verification;
- honest skipped/failed coverage and `incomplete` candidate counts after
  cancellation;
- benchmark records for planner and concurrency comparisons;
- no paid or network calls in the automated suite.

**Done when:** the recorded corpus is materially faster at equal or better
verified-finding count, and timeout documentation promises only behavior the
cleanup path can provide.

---

# Phase 6 — Specify CI gating and integrations

**Goal:** allow trusted findings to block CI with deterministic formats and
honest partial coverage.

## Exit behavior

Add opt-in `--fail-on <critical|high|medium|low>`, where the selected severity
and every more severe finding meet the threshold.

Use this precedence:

| Condition | Exit code |
| --- | ---: |
| CLI/configuration/acquisition error, or result status `failed` | 1 |
| Result status `partial` | 2 |
| Complete result contains a finding meeting `--fail-on` | 3 |
| Result status `complete` or `skipped`, with no threshold failure | 0 |

Coverage failure therefore wins over finding severity. Without `--fail-on`,
existing status-based behavior remains unchanged.

## Output formats

Introduce one primary selector:

```text
--format text|json|sarif|github
```

Keep `--json` as a compatibility alias for `--format json`; reject conflicting
selectors. `--show-dropped` is valid only with `text`. Stdout contains exactly
the selected final format; stderr remains progress and diagnostics.

### SARIF

- Use stable rule IDs derived only from stable schema data, initially
  `pi-review/<category>`. Do not derive IDs from model-authored titles or
  content.
- Map severity deterministically to SARIF levels and retain reviewer severity
  in result properties.
- Represent incomplete coverage in the SARIF run:
  `invocations[].executionSuccessful = false`, bounded tool execution
  notifications for failed/skipped files, and aggregate coverage properties.
- Include target-side physical locations only after normal host anchor
  validation.
- Add schema/golden tests and verify that hostile paths and text remain data,
  not SARIF structure.

### GitHub workflow commands

- Emit one annotation per verified finding with host-validated file and line
  data.
- Implement GitHub's distinct escaping rules for command properties and message
  data. Cover `%`, carriage return, newline, `:`, and `,` as applicable.
- Never place untrusted text into a workflow command without escaping.
- Represent partial coverage with an escaped error annotation and preserve the
  normal nonzero exit code.

## Deferred applicable patch output

Do not add `--patch` in this phase. Applicable patches require:

- exact target source bytes and newline style;
- exact replacement spans rather than whitespace-normalized anchors;
- a stale-content check against the reviewed target;
- deterministic overlap/conflict handling;
- all-or-nothing or explicitly partial output semantics.

Design that as a separate feature if users need machine-applicable edits.

**Done when:** exit behavior is covered by the table, machine formats expose
partial coverage, hostile strings are tested, and formats cannot conflict.

---

## Recommended first implementation slice

1. Exhaustive funnel accounting, including failed workflows.
2. Optional bounded dropped-candidate diagnostics.
3. Title propagation through submission, verification, sorting, and rendering.
4. Elapsed-time and token summary.
5. Display-only suggestion diff.
6. Fixed-corpus benchmark command and `--no-plan`.

This slice improves observability and presentation without changing the
verification trust policy.

## Cross-cutting requirements

- Run the narrowest affected test first, then `bun run check`, `bun test`, and
  `bun run build` when package behavior changes.
- Automated tests make no paid or network model calls.
- Update `docs/architecture.md` and README in the same change as public
  behavior.
- Keep public additions additive where possible: optional result diagnostics,
  optional public finding title, and optional event fields.
- Keep deterministic ordering independent of task completion order.
- Preserve selected/completed/failed/skipped coverage in every result.
- Do not expose model chain-of-thought in findings, dropped diagnostics, logs,
  or verifier reasons.

## Deliberately not in this plan

- **Cross-file synthesis.** Per-file isolation plus added-line anchoring has no
  honest home for a module-wide claim. A future synthesis pass must remain
  bounded, anchor to changed code, and pass independent verification.
- **Markdown/docs review by default.** Markdown is already reachable through
  explicit include rules; the default extension policy remains a precision
  choice.
- **Chasing another reviewer's recall.** The target is measurable improvement
  under this reviewer's trust model, not matching another tool's output count.
- **Applicable patches.** Display-only suggestions are useful now; exact edit
  generation is deferred until its safety contract exists.
