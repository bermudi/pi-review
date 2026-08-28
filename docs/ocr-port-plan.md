# Historical OCR v1.9.9 fork plan — black-box evidence

> **Frozen evidence:** this migration is complete. It is not the active
> development or release process. Normal releases use `bun run verify:release`;
> the tooling that produced this evidence is preserved at tag `v0.4.0`. Future
> OCR releases are not automatic pi-reviewer upgrade targets.

## Decision and current status

This plan supersedes every earlier OCR parity plan and every recorded phase
completion. Git history preserves the old plans and reports; they are not
evidence.

The shipped reference is:

- OCR tag `v1.9.9`
- signed tag object `c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94`
- commit `4b6874bd23106b5c68bea6d230bb60303b9f0961`
- development checkout `../open-code-review`

The previous package baseline was v0.3.0/OCR v1.9.3. Its committed delta to
v1.9.9 remains `docs/ocr-upstream-test-delta.json` as historical evidence.

The first v1.9.9 upgrade tranche translates 11 changed/additional cases:
v1.9.5 cross-file relocation and v1.9.5/v1.9.6 rule-language assets. This
tranche is complete.

The next v1.9.9 tranche translates the four background-selection cases. File
content now wins over inline and commit-message fallback through one shared
resolver; this tranche is complete.

The review-filter/fingerprint tranche translates five v1.9.9 cases using the
v1.9.5 terminal filter-tool contract and pinned filter prompts. This tranche
is complete.

The named-main-loop-stop tranche translates four v1.9.9 cases. Review and
scan now retain the typed stop reason in incomplete-item diagnostics; this
tranche is complete.

The cancellation checkpoint tranche translates two v1.9.9 cases. Review
sessions preserve completed checkpoints but record interrupted and undispatched
work as cancelled. The production factory now uses that same single Agent-owned
session/finalization boundary; this tranche is complete.

The scan budget/enumeration tranche translates three v1.9.9 cases. Aggregate
scan budget truncation remains warning-derived JSON status while exposing
`budget_exceeded`; unreadable binary-sniff candidates are skipped without
disturbing remaining ordered files. This tranche is complete.

The session filesystem/finalization tranche translates two v1.9.9 cases.
Malformed sessions directories fail rather than looking empty, and failed
writer creation cannot advertise a resumable session. Its completed manifest is
still emitted once on stdout while the delivery error makes the command fail on
stderr. This tranche is complete.

The color/text-rendering tranche translates fourteen v1.9.9 cases. ANSI is
TTY-aware and injectable at the CLI boundary; text receives OCR styling while
JSON and SARIF remain machine-clean. This tranche is complete.

The progress/quiet/stdout tranche translates seven v1.9.9 cases. Per-run
injected routers replace OCR's mutable global stdout swapping: human progress
goes to stderr, agent progress is suppressed, and nested quiet scopes restore
only their own router. This tranche is complete.

The final runtime-boundary tranche classifies four v1.9.9 OCR adapter tests as
not applicable through public Pi APIs: Pi owns runtime configuration and lacks
a provider-wire `tool_choice` request field. Active-tool verification and
stage-only filter tooling remain tested; this is not a claim of required-tool
wire equivalence. The inventory is classified, but release/packed-install
verification remains separate.

`src/ocr` is the sole engine derived from the v1.9.9 fork point. The
differential gates below establish historical compatibility evidence; normal
release acceptance is now the independent exact-commit release gate. Do not
claim full provider command-surface parity.

All gates begin `unverified`. Gate 5 verifies that the shipped CLI defaults to
the parity engine. Before explicit removal on 2026-08-22, legacy remained
available behind `--engine legacy` and suffixed library exports; after removal
the sole engine is OCR v1.9.9 and the verifier proves absence of that switch.

Inventory classification is complete — 0 pending of 1,997 upstream cases:
1,015 covered, 112 equivalent, 388 not applicable, and 482 out of scope. The
`config`/`provider`/`login`/`MCP`/`telemetry`/`test-connection` command
surfaces are intentionally not ported (omitted boundary; runtime only
resolves/loads external Pi configuration via public Pi APIs from
`~/.pi/agent`, Pi's external auth/model location). Full command-surface
parity is therefore not claimed; verified parity is limited to differential
fixtures and the black-box gates below.

## Why the previous evidence is invalid

The old verifiers could pass while:

- constructing traces directly instead of recording process boundaries;
- testing missing traces by manually throwing the expected error;
- deriving OCR usage from scripted provider turns;
- inferring coverage instead of observing engine output;
- importing parity internals and thereby testing a different path from the
  installed product;
- calling module importability and `package.json.files` a packed-install smoke
  test; and
- leaving the public command on the legacy engine.

Do not repair these scripts assertion by assertion. Replace their evidence
path with the black-box harness below.

## Prime directive

**Verification starts outside both engines.**

The differential verifier may know:

- how to create a Git fixture;
- how to run subprocesses;
- how to host and record a local OpenAI-compatible HTTP server;
- how to parse each engine's documented output; and
- how to compare normalized observations.

It may not import review, trace, transport, selection, comment, output, or
harness code from `src/`, `test/ocr/harness`, or the OCR Go module.

The verifier must never use scripted response objects to populate observed
requests, usage, comments, coverage, tool execution, or status. Scripted
responses control the server only. Observations come from HTTP captures,
subprocess output, exit status, Git, or files actually written by the
subprocess.

## Required verifier architecture

Create a fresh top-level `verification/blackbox/` tree. Do not extend
`test/ocr/harness`.

### Allowed dependencies

Verifier runtime files may import only:

- Bun and Node standard-library modules;
- a dedicated runtime schema library already declared by this package;
- files under `verification/blackbox/`; and
- the built package by its public package export in the SDK feasibility driver.

They must not import `src/**`, `dist/**` by relative path,
`test/ocr/harness/**`, private/deep Pi paths, or OCR Go packages.

A committed static import check must inspect imports in every verifier runtime
file and fail on a forbidden path. Shelling out to project scripts that import
forbidden code is also forbidden.

### Process isolation

For every differential fixture:

1. create one immutable Git fixture, then clone it separately for OCR and Pi;
2. start a separate local provider server for each process;
3. give both servers deep-frozen copies of the same response sequence;
4. isolate `HOME`, configuration, cache, and output directories;
5. execute the pinned OCR binary as a subprocess without `--preview`;
6. execute a packed and locally installed `pi-review` command as a subprocess;
7. capture raw HTTP requests/responses, stdout, stderr, exit code, and declared
   output/checkpoint files;
8. validate every capture with a runtime schema; and
9. compare only fields with an explicit provenance entry.

No paid or external network call is allowed. Bind servers to loopback. Run the
fixture with credential environment variables removed.

Before cutover, the installed Pi command may use an explicit
`--engine ocr` switch. The final gate removes that requirement and proves
the parity engine is the default.

### Evidence provenance

Every compared field in a fixture declares one of:

- `provider_request`: request body captured by that process's local server;
- `provider_response`: response bytes actually returned by that server;
- `stdout`: parsed subprocess stdout;
- `stderr`: parsed subprocess diagnostics;
- `exit`: subprocess exit code or signal;
- `git`: independently queried fixture facts;
- `artifact`: parsed file written by the subprocess.

Each declaration also states whether the value is `observed`, `normalized`, or
`derived`. A derived value names its exact inputs and function. A field cannot
be called OCR/Pi parity when one side is fixture-authored or unavailable.
Unavailable fields are reported as `not_observable`, not silently ignored.

Normalization is limited to temporary roots, loopback ports, deterministic
timestamps, and provider-generated request IDs. Normalization must not change
ordering, counts, tool names/schemas, arguments, usage, comments, coverage,
status, or exit codes.

### Mandatory anti-false-positive tests

The black-box harness itself is incomplete until all of these tests pass:

1. mutate one Pi provider response at the server and get a named output-field
   mismatch;
2. mutate an outgoing Pi tool schema after capture and get a named request
   mismatch;
3. alter one provider usage value and get a named usage mismatch;
4. remove OCR stdout and make the verifier fail `missing OCR stdout`;
5. remove Pi HTTP capture and make it fail `missing Pi provider trace`;
6. point both result inputs at the same process and make it fail
   `engine identity collision`;
7. make the Pi process never contact its server and make it fail before
   comparison;
8. add a forbidden `src/` import to a temporary verifier copy and make the
   import guard fail; and
9. verify mismatch artifacts contain both raw observations and the field path,
   without secrets.

These mutations occur at the process/server/artifact boundary. Calling the
comparer with two manually assembled objects does not satisfy them.

## Gate 0 — Replace the evidence system

**Scope:** build only the independent harness, schemas, recorder, comparer,
artifact writer, package installer, and anti-false-positive tests.

The package installer must:

1. run `bun pm pack` or the repository's Bun-equivalent pack command;
2. create an empty temporary consumer directory;
3. install the produced archive there;
4. resolve the package and `pi-review` binary from that consumer directory; and
5. execute `pi-review --help`.

Merely building `dist`, importing a source module, or checking
`package.json.files` is not a packed-install test.

**Completion command**

```text
bun run verify:blackbox-integrity
```

**Pass conditions**

- all nine anti-false-positive tests pass;
- forbidden import count is zero;
- packed-install smoke succeeds;
- OCR tag object and commit are exact;
- report names the clean tested commit and artifact directory; and
- no review-semantic parity is claimed by this gate.

Delete or rename old `verify:phase*` commands so they cannot be mistaken for
active evidence. Historical scripts may remain only under a clearly named
`verification/invalidated/` directory and must never run from active gates.

## Gate 1 — Public Pi SDK feasibility

**Scope:** prove the required Pi behavior before more porting.

Use the packed package's public export from a tiny driver in an empty consumer
project. The driver may use only documented public Pi APIs and the package's
public API. Its model traffic goes to a recording local server.

Required scenarios:

1. one provider response containing two tool calls produces one model request
   round, not two;
2. exhausted normal rounds allow exactly one additional request exposing only
   `code_comment` and `task_done`;
3. abort before grace produces no grace request and settles within 500 ms;
4. three consecutive rounds in which the model calls tools but every tool
   execution returns no usable result stop after exactly three requests,
   matching OCR v1.9.3
   `internal/llmloop/loop_test.go:TestRunPerFile_EmptyToolResultsStopWithEmptyRounds`;
5. OCR-controlled compression sends a distinct compression request and the
   following main request contains the returned summary;
6. provider stall plus abort settles within 500 ms;
7. two concurrent sessions have distinct messages, usage, cancellation, and
   compression observations.

Request counts and tool allowlists come only from server captures. Usage comes
only from returned provider usage and public result/output. Compression is not
proved by searching prompts for words such as “compression”; the trace must
show the designated request, its response, and the rebuilt next request.
Request arrival and response delivery are separate observations: a stalled,
aborted request has a captured request but no captured provider response.
Never pre-populate a response capture from the scripted response fixture before
the server actually returns those bytes.

**Completion command**

```text
bun run verify:sdk-feasibility
```

If any scenario requires a private/deep import, mutation of private session
state, monkey-patching, or cannot be observed through public APIs, stop and
record `blocked` with the minimal reproducer. Do not continue to Gate 2.

## Gate 2 — One real OCR/Pi vertical slice

**Fixture:** one workspace repository, exactly one selected changed source
file, one `code_comment`, then `task_done`. Filtering is either enabled for
both engines with scripted responses or disabled for both by documented CLI
options.

Compare:

- process identity and exact commands;
- selected, excluded, skipped, completed, and failed paths where observable;
- each provider request's ordinal, model, messages, tool names, and schemas;
- each provider response's text, tool calls, arguments, and raw usage;
- tool results/errors as observed in subsequent provider messages or output;
- raw and processed comment fields;
- total usage;
- completion/partial/failure state; and
- exit code.

For this gate, “compare messages and schemas” means normalized deep equality,
not merely checking that messages exist or that tool names match. Provider-only
HTTP metadata may be normalized, but system/user/tool message content,
ordering, tool descriptions, parameter schemas, and required fields may not.
OCR manifest coverage is observable and must be compared to Pi coverage; a
missing Pi coverage field is a mismatch, not `not_observable`. The positive
fixture must also compare comment line range and output tool-call accounting.

The positive fixture must pass with no ignored applicable fields. A second
fixture changes only the Pi server's comment content and must fail at the
specific comment path.

The historical installed `--engine ocr-v193` path had to delegate to the parity CLI/domain
entrypoint. Do not duplicate a test harness inline in the legacy CLI, add stub
tool implementations, use `any`, or swallow failures to make this fixture run.

**Completion command**

```text
bun run verify:vertical
```

This command first runs Gate 0 and Gate 1. It must fail if OCR falls back to a
stub, preview, fixture-built result, or a Pi-only result.

## Gate 3 — Core diff review

Add one behavior family at a time. Each family needs:

- a source/test map to pinned OCR v1.9.3;
- translated unit tests for edge cases;
- at least one black-box positive differential fixture;
- at least one boundary-injected negative fixture; and
- explicit provenance for every compared field.

Families, in order:

1. comment collection and `task_done`;
2. resolution and relocation;
3. review filtering and async drain;
4. workspace selection, rules, binary/deletion/path safety, and limits;
5. range target;
6. commit target;
7. planning and per-file orchestration;
8. round, token, context, time, abort, and partial-result behavior.

Do not begin a family while the previous family is red. Git failures must
surface; no synthetic fallback diff is allowed. Incomplete work must never
become a clean review.

**Completion command**

```text
bun run verify:core-review
```

The command runs all earlier gates and prints a family-by-family result.

## Gate 4 — Scan, sessions, and outputs

These are three sequential sub-gates, not one bundled claim:

1. full-file scan and batching;
2. checkpoint creation, interruption, trusted resume, and terminal manifests;
3. text, JSON, SARIF, and agent-audience output.

Each sub-gate follows Gate 3's source-map, unit, black-box differential,
negative-mutation, and provenance requirements. Output tests parse bytes from
the installed command's stdout or output file. Resume tests kill and restart
installed subprocesses; calling persistence helpers directly is insufficient.

**Completion commands**

```text
bun run verify:scan
bun run verify:sessions
bun run verify:outputs
```

## Gate 5 — Actual cutover

Only after Gates 0–4 pass:

1. change the shipped CLI default to the parity engine;
2. change the library's default `review` API to the parity engine;
3. (transitional, now retired) legacy behavior was retained behind an explicit `--engine legacy` switch and explicit legacy library export until removal was approved — explicit removal was approved and executed on 2026-08-22; the retention requirement is now closed and the cutover verifier proves absence of `--engine`, legacy exports, and legacy modules;
4. pack and install into a new empty consumer directory;
5. execute `pi-review review` (and `pi-review scan`) without an engine switch against the local server;
6. prove the server receives parity-engine tool schemas;
7. prove a `--engine legacy` request is rejected without invoking a model (no provider capture, unknown-flag error);
8. run one partial/incomplete fixture and prove non-clean status and exit; and
9. run the complete suite from the installed package.

**Completion command**

```text
bun run verify:cutover
```

The cutover verifier fails if source comments, documentation, exports, or the
installed command still identify the legacy engine as the default. Importing a
parity module is not cutover evidence.

## Machine-readable reports

Every active gate:

- requires a clean committed tree, including no untracked files;
- writes diagnostics to stderr and exactly one JSON report to stdout;
- exits non-zero on missing evidence or first failed prerequisite;
- accepts `--artifacts <directory>`;
- preserves raw sanitized HTTP captures, commands, stdout, stderr, exit data,
  provenance, and mismatches;
- records `gate`, full `commit`, OCR tag object/commit, package archive hash,
  fixtures, assertions, `notObservable`, forbidden imports, result, and
  artifact directory; and
- performs no external network request.

Success reports are valid only for their exact commit and package archive.

## Ledger rules

`docs/ocr-reference-manifest.md` is a ledger, not an assertion source.
Allowed statuses:

- `candidate` — implementation exists but new black-box evidence has not passed;
- `building` — active gate work;
- `verified` — a new-plan gate passed at the named commit/archive;
- `blocked` — exact public SDK or pinned-reference blocker with reproducer;
- `deviation` — explicit user-approved behavior difference.

Old verifier reports remain in Git history but must not appear as current
`verified` evidence. Unit-test counts and source line counts never establish
parity.

## Required implementation-agent report

After each work session, report:

```text
Commit: <full SHA or "uncommitted">
Gate: <0-5 and name>
Status: building | verified | blocked
Command: <exact command run>
Result: <exact JSON report or failure>
Boundary evidence: <artifact paths>
Remaining blocker: <one concrete sentence>
```

Do not report percentages, “done,” “parity,” or “cutover” from candidate code
or old verifier output.

## Immediate next action

Work on Gate 0 only:

1. reset the manifest's old phase statuses to `candidate`;
2. create `verification/blackbox`;
3. implement the import guard and packed-install runner;
4. implement raw local-server and subprocess capture;
5. implement the nine anti-false-positive tests;
6. expose `bun run verify:blackbox-integrity`; and
7. stop after Gate 0 passes on a clean committed revision.

Do not modify review semantics during Gate 0 unless a minimal packaging seam is
strictly required by the packed-install smoke test.
