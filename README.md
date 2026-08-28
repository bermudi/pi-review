# pi-reviewer

`pi-reviewer` is an independently maintained TypeScript review engine and
`pi-review` CLI built on the Pi SDK.

> **Status:** the legacy precision-oriented engine has been removed by explicit
> user approval; `src/ocr` is now the sole engine. It was derived from Open
> Code Review v1.9.9, which is the frozen fork point (`v1.9.9` /
> `c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94` / `4b6874bd23106b5c68bea6d230bb60303b9f0961`).
> The inventory is complete: 1,997 cases, with 1,015 covered, 112 equivalent,
> 388 not applicable, and 482 out of scope. Future pi-reviewer releases follow
> this project's own contracts and SemVer rather than tracking OCR releases.
> The
> `config`/`provider`/`login`/`MCP`/`telemetry`/`test-connection` command
> surfaces are intentionally not ported (omitted boundary; runtime only
> resolves/loads external Pi configuration via public Pi APIs from
> `~/.pi/agent`, Pi's external auth/model location). Full command-surface
> parity is not claimed. Historical migration evidence remains in
> `docs/ocr-port-plan.md` and `docs/ocr-source-map.md`.

The public library boundary is small; Pi sessions, prompts, and model-visible
tools remain behind `Reviewer`.

## Requirements

- **Bun 1.3.0 or newer** (`package.json` declares `bun >=1.3.0`)
- Git
- A Pi-configured provider/model and its authentication

## Install, check, test, and build

```bash
bun install
bun run check
bun test
bun run build
bun run verify:release
```

`verify:release` is the self-contained exact-commit release gate: typecheck,
tests, one build, one packed install, and installed CLI/library smoke tests. It
does not require an OCR checkout. The complete OCR 1.9.9 fork audit is
preserved at the `v0.4.0` tag.

From a checkout without a build:

```bash
bun run src/cli.ts review --help
bun run src/cli.ts scan --help
```

When the package is installed, use its binary as `pi-review`.

## CLI

`pi-review` exposes `review` and `scan` subcommands. Both use
`pi-review review|scan [flags]`; there is no `--engine` switch.

```bash
# Review the current workspace (unstaged changes vs HEAD)
pi-review review --repo . --model provider/model --format json

# Range: diff from merge-base of --from to --to
pi-review review \
  --repo /path/to/repo \
  --from main \
  --to feature \
  --model provider/model:high

# Single commit
pi-review review --repo /path/to/repo --commit HEAD --model provider/model

# Full-file scan (not diff-scoped)
pi-review scan --repo . --path src --model provider/model --format json

# Preview which files would be reviewed without calling the model
pi-review review --repo . --preview --format json
```

**Review flags** (see `pi-review review --help` for exact help):

- `--repo PATH` — repository root (default: current dir, resolved to Git top-level)
- `--rule PATH` — JSON system rule file
- `--from REF --to REF` — range diff (both required together)
- `-c, --commit REF` — single commit vs its first parent
- `--resume ID` — resume a previous review session by ID
- `--exclude PATTERNS` — comma-separated gitignore-style excludes
- `-f, --format FORMAT` — `text` (default), `json`, or `sarif`
- `--audience AUDIENCE` — `human` (default) or `agent`
- `--concurrency N` — max concurrent file reviews (default 8)
- `--timeout N` — per-file timeout in minutes (default 10)
- `--max-tools N` — max tool rounds per file (0 = template default, min 10)
- `--max-git-procs N` — max concurrent Git subprocesses (default 16)
- `--max-tokens N` — per-file prompt token ceiling (0 = default)
- `--max-tokens-budget N` — cap total token usage (0 = unlimited)
- `-b, --background TEXT` / `-B, --background-file PATH` — business context
- `--provider NAME` / `--model NAME` — override the Pi provider/model; model
  selectors accept Pi thinking suffixes such as `provider/model:high`
- `--tools PATH` — JSON tools config (default: embedded)
- `-p, --preview` — preview files without running the LLM
- `--no-filter` — keep all raw comments without LLM post-filtering

**Scan flags** are analogous with `--path`, `--no-plan`, `--no-dedup`, `--no-summary`, and `--batch`. See `pi-review scan --help`.

Output goes to stdout (`text`/`json`/`sarif`); diagnostics and progress go to stderr, so `--format json` remains machine-readable.

### Repository and model selection

Run `pi-review` inside the target Git repository, or pass its path explicitly:

```bash
pi-review review \
  --repo /home/me/src/project \
  --from origin/main \
  --to main
```

A valid review command run outside Git returns a concise repository error and
`--repo` hint; it does not dump the full help page.

Model selectors use the same syntax as Pi. A suffix selects the thinking level
without becoming part of the model ID:

```bash
pi-review review --model openai-codex/gpt-5.6-sol:high
```

The default concurrency is eight. Each file owns an isolated Pi session while
its plan, review, relocation, and filter stages reuse that file's history.
Independent files never share mutable model history.

### Exit status

`text`/`json`/`sarif` share one exit contract:

| terminal state | Exit code |
| --- | ---: |
| `complete` / `skipped` | `0` |
| `partial` | `2` |
| `failed` / invalid usage | `1` |

`--help` and `version` exit `0`. An `--engine` flag is unknown and exits `1`.

## Pi authentication and configuration

The runtime dependency is the released Pi SDK package **`@earendil-works/pi-coding-agent` `0.84.2`**, pinned exactly in `package.json`. `../pi-mono` was the implementation reference, not a runtime path dependency.

There is no login flow in `pi-reviewer`. By default, Pi uses `~/.pi/agent`:

- `~/.pi/agent/auth.json` for provider authentication
- `~/.pi/agent/models.json` for model definitions

Set `PI_CODING_AGENT_DIR` or pass `--agent-dir` via the library `ReviewOptions.agentDir` for another directory. Set `PI_REVIEW_MODEL` is not used; pass `--model` explicitly.

Model references follow `pi --model` resolution through `~/.pi/agent/models.json`. Repository `AGENTS.md`, skills, extensions, and settings are never loaded into review sessions; repository material is untrusted evidence.

## Library usage

```ts
import { review } from "pi-reviewer";

const result = await review(
  { repository: process.cwd(), mode: { kind: "workspace" } },
  { model: "provider/model" },
);

if (result.status === "partial" || result.status === "failed") {
  throw new Error(result.message);
}
console.log(JSON.stringify(result, null, 2));
```

For a range or commit:

```ts
const range = { repository: ".", mode: { kind: "range" as const, base: "main", head: "feature" } };
const commit = { repository: ".", mode: { kind: "commit" as const, ref: "HEAD" } };
```

`ReviewResult` contains `status`, `message`, findings, coverage, warnings, token usage, and elapsed time. The public facade is `review`, `createReviewer`, `Reviewer`, and the review domain types; internal runner/prompts/tools are not exported.

## Review modes and target data

- **Workspace** — working tree vs `HEAD` (or unborn snapshot); live reads may change during a long review.
- **Range** — `head` vs merge-base of `base`/`head`; pinned to Git objects.
- **Commit** — commit vs first parent; pinned.

Path safety, binary/deletion, user-exclude, and resource ceilings are enforced at the acquisition boundary; filtered files appear in `excluded` rather than being sent to a model.

## Review pipeline

1. Resolve and validate the Git target.
2. Apply deterministic selection, rules, and limits.
3. Optionally run a `PLAN_TASK` pre-pass per file.
4. Run the per-file `MAIN_TASK` loop with `code_comment` / `task_done` and bounded evidence tools (`file_read`, `code_search`, `file_find`, `file_read_diff`).
5. Relocate, validate, and filter comments.
6. Enforce bounded round/context/time/token/recovery behavior and the single restricted grace request.
7. Emit `text`/`json`/`sarif` with coverage, warnings, and exit code; support `scan`, checkpoints/resume (`--resume`), and `preview`.

There is no model-visible shell, edit, or write tool.

## Security and read-only guarantees

- Git invocations use argv arrays, never shell interpolation.
- Model-visible tools are allowlisted and bounded; the reviewer does not mutate repository files.
- Pi sessions load no repository instructions or extensions; diffs, code, rules, and tool results are delimited untrusted data.
- Host filesystem operations run with the caller's permissions; review evidence is sent to the configured provider.

## Limitations (current)

- No `rules check` or `session` CLI subcommands beyond `review`/`scan` and `version`/`help`.
- Resume is per-session (`--resume ID`); it requires the same target/options and resumes a single prior session, not cross-run coverage merging.
- Workspace evidence is live and may change during a long review; range/commit evidence is pinned.
- The CLI requires an explicit `review` or `scan` subcommand.
- Inventory classification complete (0 pending, 1,997 cases; 1,015 covered,
  112 equivalent, 388 not-applicable, 482 out-of-scope):
  `config`/`provider`/`MCP`/`telemetry`/
  `test-connection` command surfaces intentionally not ported (omitted
  boundary; Pi's external auth/model configuration lives at `~/.pi/agent` and
  is only resolved/loaded at runtime via public Pi APIs); full
  command-surface parity is not claimed.

## SDK reference and public boundary

The deliberate public boundary is `src/index.ts`:

- `Reviewer`, `review`, `createReviewer`
- review domain types
- retained `PiTransport`/`OcrRunner`/`runOcrCli` compatibility utilities

`src/ocr/**` is the independently maintained engine. Its name and source map
preserve fork provenance; they do not imply ongoing upstream synchronization.

## License and upstream attribution

`pi-reviewer` is licensed under [GPL-3.0-or-later](LICENSE). It contains
material derived from Open Code Review v1.9.9 (Apache-2.0)—see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
