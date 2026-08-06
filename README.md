# pi-reviewer

`pi-reviewer` is a precision-first, read-only AI reviewer for Git changes. It is a TypeScript library with a `pi-review` CLI. The public library boundary is small; Pi sessions, prompts, and model-visible tools remain behind `Reviewer`.

A quiet review is preferable to a clever-looking false positive. An incomplete review is reported as incomplete rather than presented as success.

## Requirements

- **Bun 1.3.0 or newer** (`package.json` declares `bun >=1.3.0`)
- Git
- A Pi-configured provider/model and its authentication

## Install, check, test, and build

From the repository root:

```bash
bun install
bun run check
bun test
bun run build
```

`bun run check` runs the strict TypeScript check. `bun test` runs the Bun test suite. `bun run build` creates the bundled `dist/cli.js` and `dist/index.js` entry points plus declarations; the package exposes the CLI as `pi-review`.

The direct source entry point is also runnable without a build:

```bash
bun run src/cli.ts --repo . --model provider/model
```

The equivalent package start script is:

```bash
bun run start -- --repo . --model provider/model
```

When the package is installed or linked, use its binary as `pi-review`. From a checkout, `bun run src/cli.ts` is the reliable unbundled form.

## CLI

`--model` (shorthand `-m`) uses Pi's `provider/model[:thinking]` reference form. Bare and partial model names resolve against `~/.pi/agent/models.json` exactly as `pi --model` does — exact id first, then fuzzy — so `-m gpt-5.6-luna:max` works when `pi --model gpt-5.6-luna:max` does. The option is required unless the `PI_REVIEW_MODEL` environment variable is set; an explicit flag always wins over the variable. The default scope is the current directory's workspace:

```bash
# Workspace in the current directory; --repo and the workspace scope are both defaults.
pi-review -m provider/model:high

# Workspace in an explicit repository.
pi-review --repo /path/to/repository --model provider/model

# Range: both refs are required; the target is head at the merge-base range.
pi-review --repo /path/to/repository \
  --base main --head feature --model provider/model

# One commit against its first parent, or the root tree for a root commit.
pi-review --repo /path/to/repository --commit HEAD --model provider/model

# Emit the exact ReviewResult JSON object on stdout.
pi-review --repo . --model provider/model --json
```

The same commands can be run from source by replacing `pi-review` with `bun run src/cli.ts`. `--base` implies `--head HEAD` when `--head` is omitted; `--head` requires `--base`. `--commit` cannot be combined with either range option. There is no separate mode flag: the selected flags determine the mode.

Available options are:

- `--repo PATH` — repository to review; defaults to the current directory.
- `-m, --model PROVIDER/MODEL[:thinking]` — Pi model reference; required unless `PI_REVIEW_MODEL` is set. Accepts bare and partial names resolved through `~/.pi/agent/models.json`, like `pi --model`.
- `--thinking LEVEL` — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `--base REF [--head REF]` — review the range from the merge-base of the refs to `head`; `--head` defaults to `HEAD`.
- `--commit REF` — review one commit.
- `--include PATTERN` and `--exclude PATTERN` — repeatable path filters.
- `--background TEXT`, `--background-file PATH`, and `--rules-file PATH` — review context; the two background forms are mutually exclusive.
- `--concurrency N` — positive maximum number of concurrent file tasks; default `4`.
- `--max-tool-rounds N` — positive per-task tool-call budget; default `32` (the runner's hard cap allows one extra start so a single overshoot can still submit).
- `--plan-threshold N` — non-negative changed-line threshold for risk planning; default `50`.
- `--agent-dir PATH` — Pi agent directory override.
- `--session-dir PATH` — persist each per-task Pi session transcript (`.jsonl`) under PATH for debugging; off by default.
- `--json` — output the exact `ReviewResult` object instead of the human-readable rendering.
- `--help` — print usage.

Human-readable results and JSON go to stdout. Progress events and warnings go to stderr, so `--json` remains machine-readable. The text renderer includes status, message, coverage, warnings, and anchored findings.

### Exit status

The result status maps to these exact review exit codes:

| `ReviewResult.status` | Exit code |
| --- | ---: |
| `complete` | `0` |
| `skipped` | `0` |
| `partial` | `2` |
| `failed` | `1` |

`--help` exits `0`. Invalid usage, unreadable background/rules files, reviewer initialization failures, and failures before a `ReviewResult` is produced exit `1`.

## Pi authentication and configuration

The runtime dependency is the released Pi SDK package **`@earendil-works/pi-coding-agent` `0.82.1`**, pinned exactly in `package.json` and the lockfile. The implementation reference was the local `../pi-mono` checkout; it is not a runtime path dependency.

There is no login flow in `pi-reviewer`. By default, Pi uses the agent directory `~/.pi/agent`, including:

- `~/.pi/agent/auth.json` for provider authentication
- `~/.pi/agent/models.json` for model definitions

Set `PI_CODING_AGENT_DIR` or pass `--agent-dir PATH` for another directory; the explicit CLI/library option takes precedence. Authentication and model resolution happen before a Pi task session is created. A provider that cannot be resolved or authenticated produces a failed review task/result rather than an interactive credential prompt.

Set `PI_REVIEW_MODEL` to make `--model` optional in the CLI, for example `export PI_REVIEW_MODEL="provider/model"` in a shell profile. The explicit `--model` flag takes precedence; a blank or invalid variable value is treated as unset or rejected the same way as an invalid flag. The library keeps `model` required in `ReviewOptions` — the environment fallback is a CLI convenience only.

Model references follow the same rules as `pi --model`: `provider/model[:thinking]`, a bare name, or a partial name, all resolved through `~/.pi/agent/models.json` by the Pi model runtime. Names that do not resolve produce a failed task/review with the resolver's error rather than an interactive prompt.

Pi sessions use an in-memory session/settings manager and a minimal resource loader by default. With `--session-dir PATH` (or `ReviewOptions.sessionDir`), each per-task session transcript is persisted as a `.jsonl` file under that directory — useful for debugging failed or aborted reviews; failed files carry the transcript path in the result. Repository `AGENTS.md` files, skills, extensions, prompts, and settings are not loaded into review sessions. Repository material is evidence, not authority. Review evidence and context are sent to the configured model provider, so use the tool where that disclosure is acceptable.

## Library usage

The public library keeps Pi behind `review(input, options)`:

```ts
import { review } from "pi-reviewer";

const result = await review(
  {
    repository: process.cwd(),
    mode: { kind: "workspace" },
  },
  {
    model: "provider/model",
  },
);

if (result.status === "partial" || result.status === "failed") {
  throw new Error(result.message);
}

console.log(JSON.stringify(result, null, 2));
```

For a range or commit, use the same domain API:

```ts
const range = {
  repository: ".",
  mode: { kind: "range" as const, base: "main", head: "feature" },
};
const commit = {
  repository: ".",
  mode: { kind: "commit" as const, ref: "HEAD" },
};
```

`ReviewResult` contains `status`, `message`, findings, selected/completed/failed/skipped coverage, warnings, token usage, and elapsed time. The public facade exports `review`, `Reviewer`, `createReviewer`, the review domain types, and deterministic Git/diff/selection/finding-placement seams. Pi runner types, prompts, phase toolkits, and model-visible tool definitions are internal.

## Review modes and target data

- **Workspace** compares the working tree with `HEAD` when one exists. It includes tracked changes and non-ignored untracked files; an unborn repository is handled as a workspace snapshot. Workspace evidence is read from the live working tree.
- **Range** compares `head` with the merge-base of `base` and `head`. Diff files and evidence reads are pinned to the `head` Git snapshot.
- **Commit** compares a commit with its first parent, or with the root tree for a root commit. Diff files and evidence reads are pinned to the commit snapshot.

Git refs, repository-relative paths, traversal, absolute paths, `.git` paths, and workspace/Git symlinks are checked at the acquisition/read boundaries. Binary, deleted, unsupported, excluded, over-limit, and otherwise non-reviewable files appear as skipped coverage rather than being sent to a model.

## Precision pipeline

The useful behavior is the set of hard boundaries around the model:

1. **Deterministic target acquisition.** `git.ts` validates the repository and refs, obtains the selected Git diff, parses it into changed files, and enriches text files with the target-side content. Range and commit targets are pinned; workspace targets use the working tree.
2. **Deterministic selection.** Files are ordered before selection. Safety, binary/deletion, user-exclude, default extension/path, and the `2,000` changed-line cap are applied before model work. A selected file also must have a non-empty diff no larger than `100,000` bytes and at least one changed line.
3. **Optional structured planning.** A file with at least `50` changed lines receives a separate risk-planning task. Its only terminating tool is `submit_plan`, which accepts a schema-checked `change_summary` plus prioritized issues and bounded evidence guidance. The planner describes evidence; the later worker performs the evidence reads. A planner failure emits a warning and the main review still runs.
4. **One isolated task per selected file.** The main worker receives the current file's diff, other changed paths for orientation, optional background/rules, and an optional plan. Its explicit tool allowlist contains only bounded evidence tools and `submit_review`.
5. **Atomic structured output.** The worker must call `submit_review` exactly once as its final action. One call supplies `state: "DONE"` or `"FAILED"` and the complete comments array (up to 20). Candidates are not accepted as a successful file result until the terminating `DONE` submission is received; a task that ends without it fails that file.
6. **Deterministic placement.** `existingCode` is matched against target-side content and a finding is accepted only when its range intersects an added target-side line. An unanchored candidate is discarded with a warning rather than placed at line `0`.
7. **Conservative veto.** Resolved findings go through a separate veto task using `submit_veto`. It may remove a candidate only when the current diff directly disproves the candidate's central claim; uncertainty keeps the finding. A non-aborted veto failure keeps all findings and adds a warning.
8. **Coverage-aware assembly.** Per-file tasks may run concurrently, but findings, coverage, warnings, and token usage are assembled into a deterministic result. `complete` means every selected file completed; partial or failed work is never reported as complete.

The main worker's model-visible tools are `file_read`, `code_search`, `file_find`, `file_read_diff`, and `submit_review`. Reads/searches/diffs have output and result limits, and each task has a tool-call budget. There is no model-visible shell, edit, or write tool. Prompt data is fenced as untrusted evidence so repository text cannot change system policy or authorize tools.

The evidence bounds are intentionally explicit: file reads return at most `500` numbered lines and `100,000` bytes; searches return at most `100` results and `50,000` bytes; finds return at most `100` paths and `50,000` bytes; changed-file diffs return at most `100,000` bytes. Search skips files over `1,000,000` bytes and binary files. The default per-task budget is `32` tool calls, including `submit_review`; the runner's hard tool-start cap is one start higher so a model that overshoots exploration by a single call can still submit instead of being killed.

## Security and read-only guarantees

- Git child processes receive argument arrays, not shell commands. Refs and paths are validated before use.
- Model-visible tools can inspect only repository-relative target data, search the target file list, inspect a known changed diff, record in-memory candidates, and terminate a phase.
- The reviewer does not apply patches or mutate repository files. `submit_review`, `submit_plan`, and `submit_veto` only update in-memory task state.
- Pi sessions load no repository instructions or extensions. Diffs, code, rules, background, and tool results are delimited untrusted data.
- Read-only is not sandboxed: Git and file reads run with the invoking host's permissions, and the configured provider receives review evidence.

## Limitations

- **No resume.** Sessions and phase state are in memory; a partially completed run cannot be resumed.
- **No full scan.** The reviewer audits the selected Git workspace/range/commit diff. It has no whole-repository or whole-directory review mode.
- **No mechanical validation.** It does not run compilers, tests, formatters, linters, or arbitrary repository commands. A model review is not CI.
- **Bounded output is not a sandbox.** Evidence results are capped, but target reads and Git operations are performed with host permissions. Safe relative-path and symlink checks reduce traversal risk; they do not provide an OS sandbox.
- **Workspace evidence can change.** The workspace diff and initial target content are acquired before tasks start, but workspace `readFile`/`listFiles` evidence reads the live working tree. A long review can therefore observe changes made after acquisition. Range and commit evidence are pinned.
- **Target acquisition is buffered but capped.** Git command output is collected in memory with a 64 MiB stdout / 2 MiB stderr ceiling, and workspace/Git-blob files are rejected above 16 MiB. Parsing and enrichment are still whole-buffer operations rather than streaming; the later 100,000-byte per-file diff gate is stricter than these host-side safety ceilings.
- **Selection is conservative.** Binary, deleted, unsafe, unsupported, excluded, over-line-limit, oversized-diff, empty-diff, and otherwise gated files may be skipped and are reported in coverage.
- **Model/provider failures remain visible.** A provider or task failure can produce `partial` or `failed`; `complete` means selected tasks terminated successfully, not that the code is correct.

## SDK reference and public boundary

`../pi-mono` was the implementation reference for the Pi session/runtime seams. The runtime dependency is the pinned released package `@earendil-works/pi-coding-agent` `0.82.1`, not the neighboring checkout.

The deliberate public boundary is `src/index.ts`:

- `Reviewer`, `review`, and `createReviewer`;
- `createReviewTarget`, `parseUnifiedDiff`, `selectFiles`, and `resolveFinding`;
- review, diff, finding, target, and selection types.

`src/pi-runner.ts`, `src/prompts.ts`, `src/tools.ts`, and `src/phase-tools.ts` stay internal so consumers depend on the review domain rather than Pi SDK details.
