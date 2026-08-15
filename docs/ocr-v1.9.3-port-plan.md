# OCR v1.9.3 recovery plan — evidence before scope

## Purpose

`pi-reviewer` is intended to port the core observable behaviour of Open Code
Review (OCR) v1.9.3 onto the public Pi SDK. The fixed reference is:

- tag: `v1.9.3`
- signed tag object: `4d796ae54cabdcf4e22b69ef502ed8871456a909`
- commit: `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`
- development checkout: `../open-code-review`

This replaces the earlier roadmap. Git retains that roadmap for historical
context; it is not an active specification. The current `src/ocr-v193` tree is
candidate code, not evidence of parity. The legacy CLI remains the default
until the cutover gate passes.

The first question is not how much OCR-shaped code exists. It is whether the
parity engine can drive the public Pi SDK and produce OCR-compatible observable
results without invented harness data.

## Non-negotiable rules

1. **A phase is not complete because a document says so.** It is complete only
   when its committed verifier exits zero and prints a machine-readable report
   naming the tested commit.
2. **No self-comparison.** A differential test executes OCR and the parity
   engine separately, with fresh but equivalent scripted-provider transcripts.
   It never constructs either result from the other engine’s result or from
   scripted response objects.
3. **No inferred evidence.** Request records, tool calls, tool results, usage,
   selected files, comments, and stop reasons are captured at their actual
   boundary. Hard-coded tool lists, reconstructed usage, and fixture-derived
   response records are test bugs.
4. **No partial assertions presented as parity.** A fixture declares exactly
   which fields it verifies. A field may be `not_applicable` only with a
   concrete reason; ignored fields do not count as matched.
5. **The Pi integration path is the product path.** `ScriptedTransport` is
   useful for ported unit tests, but cannot close an integration or parity
   phase. Those tests exercise `PiTransport` against a local provider.
6. **Public Pi APIs only.** No deep imports, transitive `pi-agent-core`/`pi-ai`
   imports, private fields, undocumented mutable state, or monkey-patching.
   If a required behaviour needs one, stop and file the exact SDK gap.
7. **No broadening while a gate is red.** Do not add scan, resume, output
   formats, more templates, or more source ports while the current phase fails.
8. **Source and tests travel together.** Every translated production path has a
   v1.9.3 source path, upstream test names or explicit omissions, provenance,
   and a TypeScript test. Line counts and total test counts are not parity
   metrics.
9. **Strict TypeScript is real.** New parity code has no `any`; narrow `unknown`
   at boundaries. Do not swallow a provider, tool, relocation, filter, or
   persistence failure—record it in the result and test it.
10. **A dirty tree cannot be certified.** Verification runs from a clean,
    committed checkout. Uncommitted work is only `building`.

## Verification contract

Create these commands before claiming any phase complete:

```text
bun run verify:phase0-evidence
bun run verify:phase1-sdk
bun run verify:phase2-vertical
bun run verify:phase3-comments
bun run verify:phase4-inputs
bun run verify:phase5-scan-session
bun run verify:cutover
```

Each command must:

- fail if `git diff --quiet` or untracked files are present;
- verify OCR’s tag object and commit before running;
- run without credentials or network access, using a local scripted
  OpenAI-compatible server only;
- emit one JSON object to stdout containing `phase`, `commit`, `fixtures`,
  `assertions`, `notApplicable`, `privateImports`, and `result`;
- exit non-zero on the first missing assertion, upstream-reference mismatch,
  private import, or uncaptured boundary;
- leave raw request/response, stdout/stderr, and mismatch artifacts in a
  caller-selected temporary directory on failure.

Each verifier has a test proving it fails when a deliberately mutated field
differs. A report is evidence only for the commit it names. It expires when
relevant code changes.

Maintain `docs/ocr-v193-reference-manifest.md` as a verified ledger, not a
manually optimistic status board. Its only statuses are:

- `unmapped` — no source/test mapping;
- `building` — code or tests exist, but no committed verifier passed;
- `verified` — an exact verifier command passed at a named commit;
- `blocked` — a named upstream or public-SDK blocker;
- `deviation` — an approved, user-visible semantic difference.

## Phase 0 — Establish trustworthy evidence plumbing

**Goal:** make it impossible for a harness to pass by comparing Pi to itself or
by replaying fixture data as observed output.

Build one typed trace format for both processes. At minimum it records:

- each outgoing model request: ordinal, model, messages, and tool schema/name
  set;
- each incoming model response: ordinal, text, tool calls, and raw usage;
- each tool execution: ordinal, name, parsed arguments, result or error;
- final coverage, raw and processed comments, usage, stop reason, and exit
  status.

The trace writer belongs at provider, tool, and output boundaries. The comparer
may normalize temp paths and explicitly documented provider-only metadata, but
must never manufacture records from fixture turns.

**Acceptance metrics**

- A negative test mutating one request tool name, one tool argument, one usage
  value, one comment line, and one stop reason produces five named mismatches.
- A negative test proves a missing OCR trace and a missing Pi trace fail rather
  than falling back to a Pi-only result.
- Repository checks find no `as any`, `: any`, private Pi imports, or mutable
  `session.agent` access in parity production code. A temporary exception
  blocks the phase; it is not documented away.
- `bun run verify:phase0-evidence` passes from a clean commit.

## Phase 1 — Public Pi SDK stop/go gate

**Goal:** prove the actual `PiTransport`, not a scripted substitute, can host
the OCR round loop through public APIs.

Use one fresh local provider and one fresh Pi session per scenario. Capture the
wire trace. Disable Pi auto-retry and auto-compression. Do not mutate a session
history through hidden or undocumented state.

Required scenarios, all through `PiTransport`:

1. One response with two tool calls produces one model round, executes both in
   order, and sends their real results in exactly one next request.
2. At the normal-round limit, the next and only next request advertises exactly
   `code_comment` and `task_done`. After that request the host makes no further
   request for that file.
3. Aborting at that boundary makes no grace request and reaches a typed terminal
   result.
4. Three OCR empty-result retries send OCR’s retry text three times, then finish
   with OCR’s corresponding stop reason.
5. OCR compression actually occurs: the trace contains the OCR compression
   request, its returned summary, and the following main request with the
   specified rebuilt conversation. “Nothing to compact” is a failure.
6. Two simultaneous file sessions prove isolated messages, usage, cancellation,
   and compression traces.
7. A stalled provider is aborted, settles, and records its terminal state.

**Stop condition:** if any scenario needs a non-public Pi operation or missing
SDK feature, set the manifest to `blocked`, include the smallest SDK proposal
and reproducer, and stop. Do not start Phase 2.

**Acceptance metric:** `bun run verify:phase1-sdk` reports all seven captured
scenarios and `privateImports: 0` at a clean commit.

## Phase 2 — One real diff-review vertical slice

**Goal:** establish one small, end-to-end OCR/Pi comparison that cannot pass by
construction.

Fixture: one workspace repository, one selected changed source file, one
scripted `code_comment`, and one `task_done`. Keep filtering off only if OCR and
Pi both receive the same explicit switch; otherwise script the filter turn too.

For each engine, start a separate local server with the same immutable response
sequence. Run OCR without `--preview` and the parity engine through
`PiTransport`. Capture both traces and parse each actual final output.

Compare, with no ignored applicable fields:

- selected/excluded/skipped/completed/failed paths;
- normal and grace tool schemas/names;
- request count, response tool calls, tool arguments, tool results/errors, and
  usage values;
- raw and processed comment fields: path, content, existing code, suggestion,
  category, severity, and line range;
- completion/partial/failure stop status and exit status.

Text, JSON, SARIF, and checkpoints are `not_applicable` in this phase, not
silently ignored.

**Acceptance metrics**

- One positive fixture and one intentional mismatch fixture.
- The mismatch changes a provider response, not comparer input, and fails with
  the changed field named.
- The trace proves both processes sent model requests to their own local server.
- `bun run verify:phase2-vertical` requires Phase 1’s named passing commit.

## Phase 3 — Comment lifecycle, relocation, and filtering

**Goal:** make the comment path correct in the real vertical slice, not only in
unit doubles.

Port and map relevant v1.9.3 resolver, relocation, collector, loop-execute, and
agent-filter tests. Keep upstream names in the manifest. Add integration cases
for:

- hunk match, content fallback, whitespace/CRLF/diff-marker tolerance, duplicate
  first-match behaviour, and no match;
- an unresolved comment followed by a real relocation request, usage accounting,
  successful replacement, and failed rollback;
- asynchronous per-file collection drained before filtering;
- the default production collector removing requested per-file indices;
- fenced, malformed, duplicate, invalid, and out-of-range filter IDs;
- filter error, timeout, and abort retaining comments;
- comments and usage surviving partial/failure paths.

Thinking may remain internal if OCR requires it, but must never be emitted as
model chain-of-thought in public results, CLI output, or logs.

**Acceptance metrics**

- 100% of in-scope upstream comment-test names map to a passing port test or an
  explicit `blocked`/`deviation` entry.
- Every relocation/filter request and its usage appears in the real Pi trace.
- A test using the default production collector proves a removed ID is absent
  from final output.
- `bun run verify:phase3-comments` runs lifecycle fixtures through actual Pi
  transport, not `ScriptedTransport`.

## Phase 4 — Inputs and review orchestration

**Goal:** expand only the diff-review inputs needed for trustworthy use.

Add workspace, range, and commit fixtures one at a time. For each, compare
actual OCR and Pi Git evidence, selection decisions, rules, planning decision,
per-file coverage, budgets, and partial/error status. Selection must not use a
fallback synthetic diff when Git acquisition fails; record that error instead.

**Acceptance metrics**

- At least one passing and one failing fixture for each input mode.
- Every in-scope upstream `internal/diff`, `internal/gitcmd`, rules, and agent
  orchestration test is mapped or explicitly blocked/deviated.
- No harness fixture runs only the first changed file unless its declared input
  has exactly one selected file.
- `bun run verify:phase4-inputs` includes earlier regression cases.

## Phase 5 — Scan, session, output, and cutover readiness

These are separate sub-gates, in this order: scan; checkpoints/resume; output
formats; public API/CLI cutover. Do not bundle them into one “implemented”
claim.

Each sub-gate needs source-test mapping, actual Pi-transport integration, an
OCR differential fixture, negative cases, and a dedicated verifier section.

The cutover sub-gate additionally requires:

- the shipped CLI and library default to the verified parity engine;
- the legacy engine is available only behind an explicit compatibility switch
  until removal is approved;
- public result contracts preserve partial coverage and stop reasons;
- package build and a packed-install smoke test exercise the new default;
- no open `blocked` row in core diff review, comments, or transport.

**Acceptance metric:** `bun run verify:cutover` passes every earlier verifier
from a clean commit and reports zero core `blocked`/unmapped entries.

## Reporting format

Agents report facts, not phase labels:

```text
Commit: <full SHA>
Status: building | verified | blocked
Verifier: <exact command, or none>
Evidence: <JSON report path or stdout>
Changed invariant: <one sentence>
Remaining blocker: <one sentence, or none>
```

“Done,” “parity,” “fully implemented,” test-count deltas, and harness passes are
not valid completion claims without the phase verifier’s named commit and trace
artifacts.
