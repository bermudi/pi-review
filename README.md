# pi-reviewer

`pi-reviewer` is a TypeScript library and `pi-review` CLI for running Open Code
Review v1.9.3's core behavior through the Pi SDK.

> **Status:** the legacy precision-oriented engine has been removed by explicit
> user approval; `src/ocr-v193` is now the sole engine and implements Open Code
> Review v1.9.3 as the pinned behavioral reference (`v1.9.3` /
> `4d796ae54cabdcf4e22b69ef502ed8871456a909` / `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`).
> Inventory classification complete — 0 pending (all 1895 upstream cases classified).
> Provider/config command tree (`config`/`provider`/`login`/`MCP`/`telemetry`/`test-connection` via `~/.pi/agent`) is intentionally not ported (scope boundary via Pi SettingsManager); parity beyond verified fixtures is not claimed. See `docs/ocr-v1.9.3-port-plan.md` and `docs/ocr-v193-source-map.md`.

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
```

`bun run check` runs the strict TypeScript check. `bun test` runs the Bun test suite. `bun run build` creates the bundled `dist/cli.js` and `dist/index.js` entry points plus declarations; the package exposes the CLI as `pi-review`.

From a checkout without a build:

```bash
bun run src/cli.ts review --help
bun run src/cli.ts scan --help
```

When the package is installed, use its binary as `pi-review`.

## CLI

`pi-review` exposes two OCR-compatible subcommands. Both use `pi-review review|scan [flags]`; there is no `--engine` switch.

```bash
# Review the current workspace (unstaged changes vs HEAD)
pi-review review --repo . --model provider/model --format json

# Range: diff from merge-base of --from to --to
pi-review review --repo /path/to/repo --from main --to feature --model provider/model

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
- `--provider NAME` / `--model NAME` — override LLM provider/model for this run
- `--tools PATH` — JSON tools config (default: embedded)
- `-p, --preview` — preview files without running the LLM
- `--no-filter` — keep all raw comments without LLM post-filtering

**Scan flags** are analogous with `--path`, `--no-plan`, `--no-dedup`, `--no-summary`, and `--batch`. See `pi-review scan --help`.

Output goes to stdout (`text`/`json`/`sarif`); diagnostics and progress go to stderr, so `--format json` remains machine-readable.

### Exit status

`text`/`json`/`sarif` share the OCR exit contract:

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

## Pipeline (OCR parity)

1. Resolve and validate the Git target.
2. Apply OCR-compatible selection, rules, and limits.
3. Optionally run a `PLAN_TASK` pre-pass per file.
4. Run the per-file `MAIN_TASK` loop with `code_comment` / `task_done` and bounded evidence tools (`file_read`, `code_search`, `file_find`, `file_read_diff`).
5. Relocate, validate, and filter comments as OCR does.
6. Enforce OCR-compatible round/context/time/token/recovery and the single restricted grace request.
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
- Inventory classification complete (0 pending, 1895 cases): `config`/`provider`/`MCP`/`telemetry`/`test-connection` via `~/.pi/agent` intentionally not ported (deferred scope boundary via Pi SettingsManager); parity beyond verified fixtures is not claimed.

## SDK reference and public boundary

The deliberate public boundary is `src/index.ts`:

- `Reviewer`, `review`, `createReviewer`
- review domain types
- OCR-backed `PiTransport`/`OcrRunner`/`runOcrCli` utilities

`src/ocr-v193/**` is the full port; see `docs/ocr-v193-source-map.md` for the upstream mapping.

## License and upstream attribution

`pi-reviewer` is licensed under [GPL-3.0-or-later](LICENSE). It ports Open Code
Review v1.9.3 (Apache-2.0) — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
