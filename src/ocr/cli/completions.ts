// SPDX-License-Identifier: GPL-3.0-or-later
// Independent pi-review command — not ported from Open Code Review.
//
// `pi-review completions <bash|zsh|fish>` prints one self-contained shell
// completion script on stdout. Flag names, short forms, and value arity are
// generated at runtime from the CLI_COMMANDS manifest, and enum candidates
// come from the parser's own value lists; the remaining metadata (value
// kinds, descriptions, terminal command names) is hand-maintained and
// pinned by tests. Git refs are computed by the shell itself via
// `git for-each-ref`; there is no dynamic-completion protocol and no I/O
// here beyond the single stdout write. Output is deterministic: the same
// shell argument produces byte-identical text.

import type { CliIo } from "./shared.js";
import { CliUsageError, AUDIENCES, BATCH_STRATEGIES, OUTPUT_FORMATS } from "./shared.js";
import { COLOR_MODES } from "./color.js";
import type { CliCommandSpec, FlagSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Completion metadata — cosmetic hints only; validation stays in the parser
// ---------------------------------------------------------------------------

type FlagValueKind = "enum" | "gitref" | "dir" | "file" | "free";

export const ENUM_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  audience: AUDIENCES,
  batch: BATCH_STRATEGIES,
  color: COLOR_MODES,
  format: OUTPUT_FORMATS,
};

export const GITREF_VALUE_FLAGS: ReadonlySet<string> = new Set(["commit", "from", "to"]);
export const DIR_VALUE_FLAGS: ReadonlySet<string> = new Set(["repo"]);
export const FILE_VALUE_FLAGS: ReadonlySet<string> = new Set(["background-file", "rule", "tools"]);

const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  audience: "output audience: human or agent",
  background: "optional requirement or business context text",
  "background-file": "path to a Markdown file used as review background",
  batch: "override BATCH_STRATEGY: none, by-language, or by-directory",
  color: "colorize output: auto, always, or never",
  commit: "single commit hash or tag to review (vs its parent)",
  concurrency: "max concurrent files",
  exclude: "comma-separated gitignore-style patterns to exclude",
  format: "output format: text, json, or sarif",
  from: "source ref to start diff from",
  help: "show help",
  "max-git-procs": "max concurrent git subprocesses",
  "max-tokens": "per-file prompt token ceiling",
  "max-tokens-budget": "cap total token usage",
  "max-tools": "max tool call rounds per file",
  model: "override LLM model for this run",
  "no-dedup": "skip the per-batch DEDUP_TASK",
  "no-filter": "keep all review comments without LLM post-filtering",
  "no-plan": "skip the per-file PLAN_TASK pre-pass",
  "no-summary": "skip the post-run PROJECT_SUMMARY_TASK",
  path: "comma-separated repo-relative directories or files to scan",
  preview: "preview which files will be reviewed without running the LLM",
  provider: "override configured LLM provider for this run",
  repo: "root directory of the git repository",
  resume: "resume from a previous session id",
  rule: "path to JSON file with system review rules",
  session: "replay a specific session id",
  timeout: "idle timeout per file in minutes",
  to: "target ref to end diff at",
  tools: "path to JSON tools config file",
};

const COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  completions: "print a shell completion script (bash, zsh, or fish)",
  findings: "replay findings from a previous session",
  help: "show help",
  review: "review a git range, commit, or workspace",
  scan: "scan repository files without a diff",
  version: "print version information",
};

export const TERMINAL_COMMANDS: readonly string[] = ["completions", "version", "help"];

export function flagValueKind(name: string): FlagValueKind {
  if (ENUM_CANDIDATES[name] !== undefined) return "enum";
  if (GITREF_VALUE_FLAGS.has(name)) return "gitref";
  if (DIR_VALUE_FLAGS.has(name)) return "dir";
  if (FILE_VALUE_FLAGS.has(name)) return "file";
  return "free";
}

function flagDescription(name: string): string {
  return FLAG_DESCRIPTIONS[name] ?? name;
}

function commandDescription(name: string): string {
  return COMMAND_DESCRIPTIONS[name] ?? name;
}

/** All value-taking flag specs across the manifest, deduplicated by long name and sorted. */
function valueFlagSpecs(commands: readonly CliCommandSpec[]): readonly FlagSpec[] {
  const byName = new Map<string, FlagSpec>();
  for (const command of commands) {
    for (const flag of command.flags) {
      if (flag.takesValue && !byName.has(flag.name)) byName.set(flag.name, flag);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Short forms usable in merged shell patterns: a short is included only when
 * exactly one value flag across the manifest claims it, so a future short
 * collision degrades to long-only patterns instead of ambiguous output.
 */
function unambiguousShorts(specs: readonly FlagSpec[]): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const spec of specs) {
    if (spec.short === undefined) continue;
    const previous = owners.get(spec.short);
    owners.set(spec.short, previous !== undefined && previous !== spec.name ? "" : spec.name);
  }
  const out = new Map<string, string>();
  for (const spec of specs) {
    if (spec.short === undefined) continue;
    if (owners.get(spec.short) === spec.name) out.set(spec.name, spec.short);
  }
  return out;
}

function flagPattern(spec: FlagSpec, shorts: ReadonlyMap<string, string>): string {
  const short = shorts.get(spec.name);
  return short !== undefined ? `-${short}|--${spec.name}` : `--${spec.name}`;
}

function allCommandTokens(commands: readonly CliCommandSpec[]): readonly string[] {
  return [...commands.flatMap((command) => [command.name, ...command.aliases]), ...TERMINAL_COMMANDS];
}

function bashFlagWords(flags: readonly FlagSpec[]): string {
  const words: string[] = [];
  for (const flag of flags) {
    words.push(`--${flag.name}`);
    if (flag.short !== undefined) words.push(`-${flag.short}`);
  }
  return words.join(" ");
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

export function generateBashCompletions(commands: readonly CliCommandSpec[]): string {
  const specs = valueFlagSpecs(commands);
  const shorts = unambiguousShorts(specs);
  const enumFlags = specs.filter((spec) => flagValueKind(spec.name) === "enum");
  const gitrefFlags = specs.filter((spec) => flagValueKind(spec.name) === "gitref");
  const dirFlags = specs.filter((spec) => flagValueKind(spec.name) === "dir");
  const fileFlags = specs.filter((spec) => flagValueKind(spec.name) === "file");
  const freeFlags = specs.filter((spec) => flagValueKind(spec.name) === "free");

  const commandNames = allCommandTokens(commands).join(" ");
  const commandCasePattern = allCommandTokens(commands).join("|");

  const attachedArms = [
    ...enumFlags.map(
      (spec) =>
        `            ${spec.name}) COMPREPLY=($(compgen -W "${(ENUM_CANDIDATES[spec.name] ?? []).join(" ")}" -P "--${spec.name}=" -- "$val")) ;;`,
    ),
    ...dirFlags.map(
      (spec) => `            ${spec.name}) COMPREPLY=($(compgen -d -P "--${spec.name}=" -- "$val")) ;;`,
    ),
    ...fileFlags.map(
      (spec) => `            ${spec.name}) COMPREPLY=($(compgen -f -P "--${spec.name}=" -- "$val")) ;;`,
    ),
    gitrefFlags.length > 0
      ? `            ${gitrefFlags.map((spec) => spec.name).join("|")})
                local refs
                refs="$(git for-each-ref --format='%(refname:short)' refs/heads refs/tags refs/remotes 2>/dev/null)"
                COMPREPLY=($(compgen -W "$refs" -P "--\${flag}=" -- "$val")) ;;`
      : "",
  ].filter((arm) => arm !== "");

  const enumArms = enumFlags.map((spec) => {
    const candidates = (ENUM_CANDIDATES[spec.name] ?? []).join(" ");
    return `            ${flagPattern(spec, shorts)}) COMPREPLY=($(compgen -W "${candidates}" -- "$cur")); return 0 ;;`;
  });
  const gitrefArm =
    gitrefFlags.length > 0
      ? `            ${gitrefFlags.map((spec) => flagPattern(spec, shorts)).join("|")})
                local refs
                refs="$(git for-each-ref --format='%(refname:short)' refs/heads refs/tags refs/remotes 2>/dev/null)"
                COMPREPLY=($(compgen -W "$refs" -- "$cur")); return 0 ;;`
      : "";
  const dirArm =
    dirFlags.length > 0
      ? `            ${dirFlags.map((spec) => flagPattern(spec, shorts)).join("|")})
                COMPREPLY=($(compgen -d -- "$cur")); return 0 ;;`
      : "";
  const fileArm =
    fileFlags.length > 0
      ? `            ${fileFlags.map((spec) => flagPattern(spec, shorts)).join("|")})
                COMPREPLY=($(compgen -f -- "$cur")); return 0 ;;`
      : "";
  const freeArm =
    freeFlags.length > 0
      ? `            ${freeFlags.map((spec) => flagPattern(spec, shorts)).join("|")})
                return 0 ;;`
      : "";

  const commandCases = [
    ...commands.map(
      (command) =>
        `            ${[command.name, ...command.aliases].join("|")}) flags="${bashFlagWords(command.flags)}" ;;`,
    ),
    "            completions|help) flags=\"-h --help\" ;;",
    "            version) flags=\"\" ;;",
    "            *) flags=\"--color --version --help -V -h\" ;;",
  ].join("\n");

  return `# bash completion for pi-review
# Generated by \`pi-review completions bash\`; do not edit by hand.
# Install by adding to ~/.bashrc:  source <(pi-review completions bash)

_pi_review() {
    local cur prev cmd i
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    # Nothing completes after an explicit end-of-options marker; the parser
    # rejects or ignores every token that follows it.
    for ((i = 1; i < COMP_CWORD; i++)); do
        if [[ "\${COMP_WORDS[i]}" == "--" ]]; then
            return 0
        fi
    done

    # First word: root flags when completing an option, commands otherwise.
    if [[ "$COMP_CWORD" -eq 1 ]]; then
        if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "--color --version --help -V -h" -- "$cur"))
        else
            COMPREPLY=($(compgen -W "${commandNames}" -- "$cur"))
        fi
        return 0
    fi

    # Active command: the first word that names one.
    cmd=""
    for ((i = 1; i < COMP_CWORD; i++)); do
        case "\${COMP_WORDS[i]}" in
            ${commandCasePattern}) cmd="\${COMP_WORDS[i]}"; break ;;
        esac
    done

    # Value completion for an attached value, --flag=partial.
    if [[ "$cur" == --*=* ]]; then
        local flag="\${cur%%=*}" val="\${cur#*=}"
        flag="\${flag#--}"
        case "$flag" in
${attachedArms.join("\n")}
        esac
        return 0
    fi

    # Value completion for the previous word when it takes one.
    if [[ "$prev" == -* ]]; then
        case "$prev" in
${[...enumArms, gitrefArm, dirArm, fileArm, freeArm].filter((arm) => arm !== "").join("\n")}
        esac
    fi

    # Flag-name completion for the active command.
    if [[ "$cur" == -* ]]; then
        local flags=""
        case "$cmd" in
${commandCases}
        esac
        COMPREPLY=($(compgen -W "$flags" -- "$cur"))
        return 0
    fi

    # The completions command takes exactly one shell name.
    if [[ "$cmd" == "completions" ]]; then
        COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))
    fi
    return 0
}
complete -F _pi_review pi-review
`;
}

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

function zshSpec(flags: FlagSpec): string {
  const description = flagDescription(flags.name);
  const names =
    flags.short !== undefined
      ? `(-${flags.short} --${flags.name}){-${flags.short},--${flags.name}${flags.takesValue ? "=" : ""}}`
      : `--${flags.name}${flags.takesValue ? "=" : ""}`;
  if (!flags.takesValue) {
    return `${names}[${description}]`;
  }
  const value = `:${flags.name}:`;
  switch (flagValueKind(flags.name)) {
    case "enum":
      return `${names}[${description}]${value}(${(ENUM_CANDIDATES[flags.name] ?? []).join(" ")})`;
    case "gitref":
      return `${names}[${description}]${value}_pi_review_git_refs`;
    case "dir":
      return `${names}[${description}]${value}_files -/`;
    case "file":
      return `${names}[${description}]${value}_files`;
    case "free":
      return `${names}[${description}]${value}`;
  }
}

function zshCommandFunction(functionName: string, specs: readonly FlagSpec[]): string {
  const lines = specs.map((spec, index) => {
    const suffix = index < specs.length - 1 ? " \\" : "";
    return `        '${zshSpec(spec)}'${suffix}`;
  });
  return [`_pi_review_${functionName}() {`, "    _arguments -S \\", ...lines, "}", ""].join("\n");
}

export function generateZshCompletions(commands: readonly CliCommandSpec[]): string {
  const commandEntries = [
    ...commands.flatMap((command) => {
      const description = commandDescription(command.name);
      return [
        `${command.name}:${description}`,
        ...command.aliases.map((alias) => `${alias}:${description} (alias for ${command.name})`),
      ];
    }),
    ...TERMINAL_COMMANDS.map((name) => `${name}:${commandDescription(name)}`),
  ]
    .map((entry) => `                '${entry}'`)
    .join("\n");

  const functions = commands
    .map((command) => zshCommandFunction(command.name, command.flags))
    .join("\n");

  return `#compdef pi-review
# zsh completion for pi-review
# Generated by \`pi-review completions zsh\`; do not edit by hand.
# Install (fpath): pi-review completions zsh > ~/.zfunc/_pi-review
#                  (add ~/.zfunc to fpath before running compinit)
# Install (source): source <(pi-review completions zsh)
#                  (only after compinit has run — compdef must exist)

_pi_review_git_refs() {
    local -a refs
    refs=(\${(f)"$(command git for-each-ref --format='%(refname:short)' refs/heads refs/tags refs/remotes 2>/dev/null)"})
    if (( \${#refs[@]} > 0 )); then
        _describe -t pi-review-git-refs 'git ref' refs
    fi
}

${functions}_pi_review_completions() {
    _arguments -S \\
        '1:shell:(bash zsh fish)'
}

_pi_review() {
    # The active command is the first word that names one; root options
    # such as --color may precede it.
    local cmd="" i
    for (( i = 2; i < CURRENT; i++ )); do
        case "\${words[i]}" in
            ${allCommandTokens(commands).join("|")}) cmd="\${words[i]}"; break ;;
        esac
    done

    if [[ -z "$cmd" ]]; then
        if [[ "\${words[CURRENT-1]}" == "--color" ]]; then
            local -a modes
            modes=('auto:colorize only on a terminal' 'always:always colorize' 'never:never colorize')
            _describe -t pi-review-color-modes 'color mode' modes
        elif [[ "\${words[CURRENT]}" == -* ]]; then
            _arguments -S \\
                '--color=[colorize output: auto, always, or never]:mode:(auto always never)' \\
                '(-V --version)'{-V,--version}'[print version information]' \\
                '(-h --help)'{-h,--help}'[show help]'
        else
            local -a commands
            commands=(
${commandEntries}
            )
            _describe -t pi-review-commands 'pi-review command' commands
        fi
        return
    fi

    case "$cmd" in
${commands
  .map((command) => `        ${[command.name, ...command.aliases].join("|")}) _pi_review_${command.name} ;;`)
  .join("\n")}
        completions) _pi_review_completions ;;
    esac
}

if (( $+functions[compdef] )); then
    compdef _pi_review pi-review
fi
`;
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishFlagLine(command: CliCommandSpec, flag: FlagSpec): string {
  const condition = `__fish_seen_subcommand_from ${[command.name, ...command.aliases].join(" ")}`;
  const long = `-l ${flag.name}`;
  const short = flag.short !== undefined ? ` -s ${flag.short}` : "";
  const description = ` -d '${flagDescription(flag.name)}'`;
  if (!flag.takesValue) {
    return `complete -c pi-review -n '${condition}' ${long}${short}${description}`;
  }
  switch (flagValueKind(flag.name)) {
    case "enum":
      return `complete -c pi-review -n '${condition}' ${long}${short} -x -a '${(ENUM_CANDIDATES[flag.name] ?? []).join(" ")}'${description}`;
    case "gitref":
      // `-f` keeps fish from also offering file names when the flag's
      // parameter is expected to be a git ref.
      return `complete -c pi-review -n '${condition}' ${long}${short} -r -f -a '(command git for-each-ref --format="%(refname:short)" refs/heads refs/tags refs/remotes 2>/dev/null)'${description}`;
    case "dir":
      return `complete -c pi-review -n '${condition}' ${long}${short} -r -f -a '(__fish_complete_directories)'${description}`;
    case "file":
      return `complete -c pi-review -n '${condition}' ${long}${short} -r -F${description}`;
    case "free":
      return `complete -c pi-review -n '${condition}' ${long}${short} -x${description}`;
  }
}

export function generateFishCompletions(commands: readonly CliCommandSpec[]): string {
  const commandLines = [
    ...commands.flatMap((command) => {
      const description = commandDescription(command.name);
      return [
        `complete -c pi-review -n '__fish_use_subcommand' -a ${command.name} -d '${description}'`,
        ...command.aliases.map(
          (alias) => `complete -c pi-review -n '__fish_use_subcommand' -a ${alias} -d '${description} (alias for ${command.name})'`,
        ),
      ];
    }),
    ...TERMINAL_COMMANDS.map(
      (name) => `complete -c pi-review -n '__fish_use_subcommand' -a ${name} -d '${commandDescription(name)}'`,
    ),
  ];

  const shellArgLines = ["bash", "zsh", "fish"].map(
    (shell) =>
      `complete -c pi-review -n '__fish_seen_subcommand_from completions' -x -a ${shell} -d '${shell} completion script'`,
  );

  const flagSections = commands.map((command) =>
    ["", `# ${command.name} flags`, ...command.flags.map((flag) => fishFlagLine(command, flag))].join("\n"),
  );

  return `# fish completion for pi-review
# Generated by \`pi-review completions fish\`; do not edit by hand.
# Install: pi-review completions fish > ~/.config/fish/completions/pi-review.fish

complete -c pi-review -f

${[...commandLines, ...shellArgLines, ...flagSections].join("\n")}
`;
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export function runCompletionsCommand(
  rest: readonly string[],
  io: CliIo,
  commands: readonly CliCommandSpec[],
): number {
  if (rest.length === 0) {
    throw new CliUsageError("completions requires a shell argument: bash, zsh, or fish");
  }
  if (rest.length > 1) {
    const extra = rest[1] ?? "";
    throw new CliUsageError(
      `unexpected argument "${extra}"; completions takes exactly one shell argument: bash, zsh, or fish`,
    );
  }
  const shell = rest[0] ?? "";
  if (shell === "bash") {
    io.stdout(generateBashCompletions(commands));
    return 0;
  }
  if (shell === "zsh") {
    io.stdout(generateZshCompletions(commands));
    return 0;
  }
  if (shell === "fish") {
    io.stdout(generateFishCompletions(commands));
    return 0;
  }
  throw new CliUsageError(`unknown shell "${shell}"; expected bash, zsh, or fish`);
}
