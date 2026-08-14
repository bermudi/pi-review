# Open Code Review v1.9.3 port plan

## North star

`pi-reviewer` is a behavioral port of the Open Code Review review engine onto
the Pi SDK. The reference is fixed:

- release: <https://github.com/alibaba/open-code-review/releases/tag/v1.9.3>
- tag: `v1.9.3`
- signed tag object: `4d796ae54cabdcf4e22b69ef502ed8871456a909`
- commit: `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`
- local reference checkout: `../open-code-review`

The tag, not the reference checkout's moving branch, defines parity. Later OCR
changes require an explicit upgrade plan.

Pi replaces OCR's model/provider runtime. TypeScript and Bun replace Go. Those
substitutions do not authorize changes to review behavior. Any intentional
deviation must be listed, justified, tested, and visible to users.

The present `pi-reviewer` engine is a precision-oriented reinterpretation, not
an OCR port. Do not continue refining its default protocol. Preserve it only as
a temporary legacy implementation while the parity engine is built alongside
it.

## Implementation decision — restart the core, keep the repository

Build the OCR v1.9.3 engine as a fresh implementation tree with fresh tests.
Do not retrofit the current reviewer one phase at a time: its atomic
submission, tool-start budgeting, strict resolver, change map, and mandatory
verifier encode the opposite protocol and would produce a hard-to-audit hybrid.

The restart rules are:

- new parity modules do not import legacy review policy;
- translate OCR package boundaries and tests into a separate `src/ocr-v193`
  and `test/ocr-v193` tree;
- put the Pi transport behind a new narrow adapter rather than extending the
  legacy runner;
- keep the legacy engine frozen and callable only for migration comparison;
- reuse a legacy utility only after OCR-derived tests prove semantic parity;
- retain the repository, package name, release automation, and history;
- cut the public API over through a thin adapter after the new vertical slice
  works;
- delete the legacy engine only after parity acceptance and explicit approval.

This is a new engine, not a refactor. Side-by-side construction provides
rollback and comparison without allowing sunk cost to dictate the design.

## Phase 0 — License, provenance, and scope

### License decision

Resolved: `pi-reviewer` is licensed under GPL-3.0-or-later. OCR v1.9.3 is
Apache-2.0, which is compatible with GPLv3 for an integrated derivative work.

The repository includes:

- the GPLv3 license in `LICENSE`;
- OCR's Apache-2.0 license in `LICENSES/Apache-2.0.txt`;
- upstream identity and attribution in `THIRD_PARTY_NOTICES.md`;
- package metadata that ships both notice files.

For every translated or substantially adapted file:

1. record the OCR v1.9.3 source path in the file header;
2. retain the applicable upstream Apache SPDX and copyright header rather than
   replacing it;
3. append this provenance shape, adapted to the file's comment syntax:

   ```text
   Ported from <upstream path> at
   c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
   Modifications are distributed as part of pi-reviewer under
   GPL-3.0-or-later;
   see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.
   ```

4. list material prompt, template, schema, or fixture imports in the source
   manifest;
5. keep modifications reviewable rather than disguising a translation as an
   independent implementation.

For byte-identical prompt/template data that cannot contain a comment without
changing model input, keep provenance in the source manifest and an adjacent
metadata file rather than modifying the imported bytes.

Do not copy from OCR branches newer than v1.9.3 under this plan.

### Port scope

The first compatibility target is OCR's core review product:

- diff review for workspace, range, and commit targets;
- full-file scan;
- file selection, excludes, rules, preview, and background context;
- planning, main review, comment collection, relocation, post-processing, and
  review filtering;
- round, timeout, context, and token controls;
- session checkpoints and resume behavior;
- text, JSON, SARIF, and agent-audience output;
- truthful partial/failure status and usage.

Pi supplies model discovery, authentication, provider calls, and model
selection. The following OCR product shells are separate tracks, not blockers
for core parity:

- provider configuration TUI and OCR's provider catalog;
- browser session viewer;
- IDE plugins and agent plugins;
- GitHub Action packaging;
- MCP and delegate commands;
- OpenTelemetry export.

These are deferred, not silently declared unnecessary. Add them to the parity
matrix so their status remains visible.

## Phase 1 — Prove the public Pi SDK can host the OCR loop

This is a stop/go feasibility gate. Complete it before building the source
translation map, comparison harness, or new engine tree.

The spike targets the project's pinned
`@earendil-works/pi-coding-agent` `0.82.1`, not a global or newer Pi install.
It may import only documented exports from that direct dependency. Deep imports
from Pi internals, transitive `pi-agent-core` imports, private-field access, and
runtime monkey-patching fail the gate even if they appear to work.

### Spike setup

Build one disposable executable test using:

- a local scripted OpenAI-compatible HTTP server;
- a temporary Pi agent directory with a non-secret local model definition;
- one public Pi `AgentSession`;
- tiny normal evidence, `code_comment`, and `task_done` tools;
- captured outbound requests, public session events, tool executions, usage,
  and stop state.

No paid model, credential, target repository, source port, or broad differential
harness is needed for this spike.

### Required capability proofs

| Capability | Spike | Pass condition |
| --- | --- | --- |
| OCR round accounting | Return one assistant response containing two tool calls, then another response | The host observes two model requests/rounds, not three tool rounds, and can identify each round before the following request |
| Multi-tool turn execution | Put multiple valid and invalid calls in one response | Every call in the response is handled in OCR order/policy and its results feed one following model request |
| Dynamic allowlist | Exhaust a tiny normal-round budget | Before the next request, the public API changes the advertised tools from the normal set to exactly `code_comment` and `task_done` |
| Restricted grace round | Keep requesting evidence at the normal limit | Exactly one additional model request occurs with only terminal tools; its usage is counted and it cannot start another normal or grace request |
| Cancelled grace | Abort as the normal budget ends | No grace request occurs and cleanup settles observably |
| Empty-round recovery | Return no usable tool calls repeatedly | Public APIs can append OCR's retry message and continue exactly three times, with a typed final stop |
| OCR-controlled compression | Trigger a tiny context threshold | The host can run OCR's compression prompt, replace the active conversation with its result, and prove the next outbound request contains the expected rebuilt messages |
| Compression isolation | Trigger compression in two concurrent sessions | Each file applies only its own compression result and cancellation cannot cross sessions |
| Timeout/abort | Stall a scripted response | Public abort APIs stop the run, expose the terminal state, and do not require hidden state mutation |

For compression, merely calling Pi's built-in `compact()` is not a pass. It
must be possible to reproduce OCR's prompt, trigger, retained state, request
accounting, and failure behavior. The spike should prefer public Pi compaction
hooks if they are sufficiently controllable; otherwise it may create an
explicit OCR compression request through the same public model/session surface.

### Gate result

Write a short feasibility report containing the executable evidence for each
row and the exact public API used.

- If every required row passes, continue to Phase 2.
- If a row needs a small supported Pi SDK addition, stop the port and propose
  that addition before proceeding.
- If matching the loop requires private Pi internals or replacing Pi's agent
  loop wholesale, stop: this repository cannot honestly be the planned Pi SDK
  port under the current architecture.

Do not respond to a failed gate by weakening OCR parity, quietly switching to a
different Pi package, or building a giant harness around an impossible core.

**Done when:** the spike proves all required capabilities on Pi `0.82.1`, or
the port is explicitly stopped with a concrete SDK blocker.

## Phase 2 — Establish a source map and executable conformance contract

This is a source-level port, not a black-box reimplementation. OCR's v1.9.3 Go
implementation, templates, and tests are the primary specification. End-to-end
differential tests are a backstop for translation mistakes, not a substitute
for understanding and porting the source.

### Source translation map

Create a checked-in map from each in-scope OCR package to its TypeScript home:

| OCR v1.9.3 source | Pi port responsibility |
| --- | --- |
| `internal/model` | review, diff, preview, scan, and comment contracts |
| `internal/config/template` | task templates, defaults, substitution, validation |
| `internal/config/rules` and `allowlist` | rules, include/exclude, and file policy |
| `internal/diff` and `internal/gitcmd` | target acquisition, parsing, placement |
| `internal/tool` | tool schemas, execution, collector, and result text |
| `internal/llmloop` | rounds, tool execution, grace, compression, worker pool |
| `internal/agent` | diff-review orchestration, planning, filtering, budgets |
| `internal/scan` | full-file scan, batching, deduplication, summary |
| `internal/session` | manifests, checkpoints, identity, trusted resume |
| `cmd/opencodereview` output/SARIF paths | CLI semantics and rendering |
| `internal/llm` | replaced by a narrow Pi SDK adapter |

For every row:

- inventory production files and corresponding upstream tests;
- state whether existing Pi code is reused, replaced, or wrapped;
- translate upstream tests before or with production behavior;
- preserve constants, ordering, stop reasons, and failure policy;
- record any construct that cannot map directly to supported Pi SDK behavior.

Do not mechanically transliterate Go syntax. Preserve semantics while using
strict TypeScript types and Bun primitives. Conversely, do not use
"idiomatic TypeScript" as a reason to change observable behavior.

### Reference manifest

Add a checked-in manifest containing:

- the fixed tag object and commit above;
- every translated/adapted OCR source path and its destination path;
- hashes of imported prompts, templates, tool schemas, default rules, output
  schemas, and fixtures;
- the upstream test names represented by each port test file;
- the expected Go and Bun command versions;
- a table of every in-scope OCR capability and its parity status:
  `unexamined`, `specified`, `implemented`, `matched`, or `deviates`.

The harness must fail if `../open-code-review` does not contain the expected
tag and commit. It must never silently test against OCR `main`.

### Source-derived tests

Port the relevant OCR tests package by package. Preserve each test's behavioral
purpose and edge cases, while replacing Go-only machinery with typed fakes.
Maintain the upstream test name in a comment or manifest entry so omissions are
searchable.

Do not copy assertions blindly: read the production path they protect and
document the invariant in the TypeScript test. New Pi-adapter tests complement
the translated suite; they do not replace it.

### End-to-end differential harness

Run both CLIs against:

- the same temporary Git repositories;
- the same workspace/range/commit fixtures;
- a local fake OpenAI-compatible server returning scripted model responses;
- deterministic clocks and paths;
- no paid provider and no external network.

Build OCR v1.9.3 from a temporary `git archive` of the tag so the neighboring
checkout is not modified. Configure both OCR and Pi to use the local fake
provider. Normalize only documented environmental differences such as
temporary absolute paths and timestamps.

Capture and compare:

- selected, excluded, skipped, completed, and failed files;
- prompts and tool definitions presented in each phase;
- model-request count and tool calls per request;
- tool arguments, results, and errors;
- comments before and after processing;
- stop reason, coverage, usage, and budget state;
- text, JSON, SARIF, and agent-audience output;
- checkpoint/resume transitions.

The scripts are derived from concrete OCR loop, tool, agent, scan, and session
tests. They must cover multiple tool calls in one model response; malformed and
empty responses; provider errors; cancellation; context pressure; budget
exhaustion; and grace-round submission.

### Unit-level transcript runner

Define a provider-independent conversation seam used by the new engine and
tests. A scripted implementation supplies assistant messages and records
requests without loading Pi. The production implementation adapts the Pi SDK.

No engine behavior may depend directly on Pi session events without passing
through this seam.

**Done when:** the source map covers every in-scope OCR production and test
file, and one command runs deterministic OCR-vs-Pi fixtures with field-level
mismatch reports.

## Phase 3 — Port the OCR model loop through public Pi SDK APIs

This is the central replacement. Do not modify the existing runner until the
new loop passes its own fixtures.

Translate `internal/llmloop/loop.go`, `compression.go`, and `pool.go` together
with their v1.9.3 tests. Keep OCR's separation between loop policy and model
transport: only the transport side becomes Pi-specific.

### Required loop semantics

Match OCR v1.9.3:

- one round equals one model request, regardless of the number of tool calls in
  the response;
- default review budget is 30 rounds;
- default scan budget is 60 rounds;
- `--max-tools` uses OCR's validation and minimum behavior;
- all tool calls in one response are executed and returned as one conversation
  turn;
- three consecutive rounds without a usable tool result stop with the typed
  empty-round reason;
- normal budget exhaustion triggers one grace model request;
- the grace request exposes only `code_comment` and `task_done`;
- cancellation prevents a grace request;
- every model request and grace request contributes usage;
- typed stop reasons distinguish task completion, round exhaustion, empty
  rounds, compression stop, provider error, timeout, cancellation, and budget
  exhaustion.

Use real tool allowlisting for grace. A prompt asking the model not to call
other tools is not equivalent.

### Pi adapter

Use only supported Pi SDK surfaces. The adapter must:

- create isolated per-file sessions;
- expose exactly the active OCR tool set;
- count assistant/model turns separately from tool starts;
- retain responses containing multiple tool calls;
- switch the active tool allowlist before the grace request;
- expose retry attempts separately from OCR rounds;
- aggregate usage once;
- support abort and session disposal without hiding cleanup failure;
- preserve a task-scoped session identity for provider prompt caching.

Disable or explicitly control Pi behaviors that would alter OCR semantics,
including automatic compaction, retries, discovered instructions, skills,
extensions, and tools.

Spike context replacement using public Pi session/compaction APIs before
committing to the adapter. If public APIs cannot reproduce OCR's compression or
grace behavior, stop and document the SDK gap. Prefer adding a narrow supported
Pi seam over importing private internals.

### Context compression

Port OCR's thresholds, warning behavior, compression prompt, asynchronous
ownership, fallback behavior, and stop classification. Compression must retain
the current task, confirmed comments, important tool conclusions, and pending
work. Concurrent files must not consume each other's compression result.

Use OCR's compression implementation and tests as the semantic source. Pi's
built-in compaction may be used only if the translated tests demonstrate
equivalent requests, retained state, and failure behavior; otherwise invoke the
OCR compression task explicitly through the Pi adapter.

**Done when:** the loop and compression fixtures match OCR request-for-request
and stop-reason-for-stop-reason.

## Phase 4 — Port diff review as one vertical slice

### Input and selection

Translate the relevant v1.9.3 paths in `internal/diff`, `internal/gitcmd`,
`internal/config/allowlist`, `internal/config/rules`, and
`internal/agent`. Audit the existing Git, diff, selection, and path-safety
modules against those implementations and tests. Reuse code only where output
matches. Port:

- workspace, range, and commit semantics;
- merge-base and commit-parent behavior;
- staged, unstaged, and untracked handling;
- default extension and path allowlists;
- excludes, rules, maximum file/prompt size, and preview behavior;
- background and background-file normalization;
- commit-message background behavior;
- deterministic review-item identity.

Keep stronger path and process safety only when it does not alter valid OCR
inputs. Record every deliberate rejection difference.

### Templates and planning

Import the v1.9.3 task template and prompt files with provenance. Port template
loading, substitution behavior, plan threshold, plan failure handling,
language instructions, and token limits. Freeze imported prompt text with
hashes and golden tests.

Do not insert the current deterministic change map or other Pi-only context
into the compatibility prompt.

### Main task and comment lifecycle

Translate OCR's tool definitions, argument parsing, collector, and execution
policy rather than designing replacement schemas. Use OCR's tools and
lifecycle:

- `file_read`
- `code_search`
- `file_find`
- `file_read_diff`
- `code_comment`
- `task_done`

`code_comment` records validated comments as the model discovers them and may
batch comments in one call. `task_done` terminates the task. A final atomic
`submit_review` is not part of compatibility mode.

Preserve comments already collected when the main loop reaches a non-success
stop, subject to OCR's actual file/status rules. Never convert partial work
into a clean review.

### Remove the mandatory verifier from the default path

OCR v1.9.3 has no independent citation verifier. The current verifier must not
run in compatibility mode. Retain it only as a later opt-in extension such as a
precision profile, and measure that profile separately.

**Done when:** deterministic diff-review fixtures produce the same raw comments,
completion state, and coverage as OCR.

## Phase 5 — Port comment processing and filtering

Translate the comment paths in `internal/tool`, `internal/llmloop`, and
`internal/agent`, including their tests. Match OCR's comment pipeline rather
than replacing it with stricter anchoring:

- parse and validate `code_comment` data as OCR does;
- track comments to changed code;
- retry tracking/relocation using the v1.9.3 relocation task when needed;
- preserve exact suggestion handling and validation behavior;
- support asynchronous comment processing with per-file draining;
- run the v1.9.3 review filter unless `--no-filter` is set;
- match filter timeout, malformed response, and failure behavior;
- preserve deterministic final ordering where OCR guarantees it.

The existing whitespace-normalized resolver may remain as a utility only if
fixtures prove equivalence for the relevant path. Strict added-line rejection
must not override OCR's relocation behavior in compatibility mode.

Test duplicate snippets, moved code, multiline suggestions, deleted/context
lines, malformed locations, filter failures, and concurrent comment
processing.

**Done when:** raw comment fixtures match OCR after relocation, suggestion
validation, and filtering.

## Phase 6 — Port operational limits and failure behavior

Keep independent controls independent:

- review and scan concurrency;
- per-file timeout;
- overall command cancellation;
- maximum completion/prompt tokens;
- aggregate token budget and look-ahead dispatch gate;
- maximum concurrent Git processes;
- provider retry reporting;
- empty-round limit;
- context-compression thresholds;
- main and grace round budgets.

Use injectable clocks and fake sessions. If Pi cancellation cleanup is
unbounded, document timeout as best-effort rather than claiming OCR-equivalent
hard return timing. This is a recorded runtime deviation until the SDK can
bound cleanup.

Match OCR's behavior when:

- the budget prevents the first file;
- a later file would exceed the projected budget;
- one file times out while others continue;
- the provider retries then succeeds or fails;
- Ctrl-C arrives during planning, main review, comment processing, or grace;
- Git or a model task fails after comments were collected.

**Done when:** every operational stop has the same status, retained comments,
usage accounting, and subsequent dispatch behavior as OCR, except documented
Pi-runtime limitations.

## Phase 7 — Port scan mode

Translate `internal/scan`, the scan template, and their v1.9.3 tests. Implement
scan as its own OCR-compatible pipeline, not diff review with a fake diff:

- path/file enumeration and ignore behavior;
- full-file prompt and size limits;
- default 60-round budget;
- optional planning;
- batching by language/directory/none;
- per-batch deduplication;
- project summary;
- `--no-plan`, `--no-dedup`, and `--no-summary`;
- scan preview;
- aggregate token budget;
- scan checkpoint and resume behavior.

Keep scan templates and budgets separate from diff review as OCR does.

**Done when:** representative directory, file, language-batch, budget, dedup,
summary, and resume fixtures match OCR v1.9.3.

## Phase 8 — Port sessions and trusted resume

Translate the domain logic in `internal/session` and the identity/checkpoint
paths in `internal/agent` and `internal/scan`. Do not attempt to reuse OCR's Go
serialization structs by intuition; port their field and transition tests.

Pi's raw transcript format may remain an implementation detail, but the port
must reproduce OCR's observable checkpoint guarantees:

- stable review-item fingerprints;
- sealed input identity for refs and commits;
- model/provider/config identity validation;
- checkpoint lineage and trusted transitions;
- rejection of stale, foreign, or incompatible resume state;
- preservation of completed work;
- correct Ctrl-C checkpoint behavior.

Do not claim OCR-compatible resume if the implementation merely continues a Pi
conversation. Store an OCR-domain checkpoint alongside any Pi transcript.

**Done when:** the differential suite accepts and rejects the same resume
scenarios and resumes without repeating completed work.

## Phase 9 — Match CLI output and cut over

Port the in-scope v1.9.3 command behavior:

- compatible review and scan option semantics;
- text, JSON, SARIF, and agent-audience output;
- progress and diagnostics on the correct streams;
- preview output;
- usage and retry summaries;
- partial/budget/failure status;
- exit codes.

The TypeScript library may retain its domain API, but it must expose enough
state to render OCR-equivalent CLI results without reconstructing facts.

During development, select the new engine only through an internal test seam or
clearly experimental flag. Do not make users choose between two undocumented
defaults.

Cut over only when:

1. every in-scope matrix row is `matched` or has an approved deviation;
2. all differential fixtures pass;
3. `bun run check`, `bun test`, and `bun run build` pass;
4. a fixed real-review corpus shows no unexplained material output difference;
5. README and architecture documentation describe the port rather than the
   legacy precision fork.

After cutover, keep the legacy engine for one release behind an explicit
compatibility option. Remove it only with explicit approval after migration
evidence is published.

## Reuse policy

The new engine starts with no imports from the legacy orchestrator, prompts,
phase tools, resolver, change map, or budget runner.

Candidates for later extraction, after OCR-derived parity tests:

- Git process and object-reading boundaries;
- unified-diff parsing;
- path and symlink safety;
- bounded read-only filesystem tools;
- Pi model resolution and authentication, excluding its current agent-loop
  policy;
- result coverage and usage primitives;
- CLI stream and signal seams.

Expected replacement or isolation:

- current review orchestrator;
- current tool-start budget logic;
- `submit_review` protocol;
- mandatory verification default;
- precision-first prompts;
- strict resolver as the only placement strategy;
- deterministic change-map prompt injection;
- phase-only resume semantics.

Reuse is earned by matching fixtures, not by code quality or existing test
coverage. Prefer a small amount of temporary duplication over coupling the new
engine to a legacy invariant.

## Test and evidence rules

- No paid or network model calls in automated tests.
- Translate upstream unit tests for every ported package; record upstream test
  coverage in the source manifest.
- Differential tests use a local scripted provider as an integration backstop.
- Preserve raw mismatch artifacts for failed parity tests.
- Compare semantics before normalizing output.
- Never call a known deviation "parity."
- Keep OCR-derived source, prompts, and fixtures versioned under the fixed tag
  with the required provenance and attribution.
- When an upstream test cannot be translated, record the exact test name and a
  concrete reason in the parity matrix; omission is not success.
- Run the narrowest affected tests first, then `bun run check`, `bun test`, and
  `bun run build`.

## First implementation slice

The first slice is only the Phase 1 feasibility spike:

1. start a public Pi `0.82.1` session against a local scripted provider;
2. prove model-request round counting with a multi-tool response;
3. prove host-controlled transition to an exact terminal-only tool allowlist;
4. prove one restricted grace request and the cancellation case;
5. prove three-round empty-result recovery;
6. prove OCR-controlled compression and concurrent isolation;
7. prove timeout/abort settlement;
8. publish the pass/fail evidence and exact public APIs used.

Only after that gate passes:

1. check in the v1.9.3 source translation manifest and parity matrix;
2. create isolated `src/ocr-v193` and `test/ocr-v193` roots;
3. translate `internal/llmloop` and its tests;
4. build the broader differential harness;
5. port one minimal workspace review through `code_comment` and `task_done`.

Do not translate the engine, build the broad comparison harness, or start scan,
resume, output formats, or optional verification before the public SDK
feasibility gate passes.
