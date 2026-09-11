// SPDX-License-Identifier: GPL-3.0-or-later
// Independent pi-review tests for the `completions` command — not ported
// from Open Code Review. The generators are pure functions of the
// CLI_COMMANDS manifest, so every contract below is checked without
// spawning a shell, touching Git, or requiring network access.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { runCli, HELP_TEXT, CLI_COMMANDS } from "../../../src/ocr/cli/index.js";
import type { CliCommandSpec } from "../../../src/ocr/cli/index.js";
import {
  generateBashCompletions,
  generateZshCompletions,
  generateFishCompletions,
  ENUM_CANDIDATES,
  GITREF_VALUE_FLAGS,
  DIR_VALUE_FLAGS,
  FILE_VALUE_FLAGS,
  TERMINAL_COMMANDS,
  flagValueKind,
} from "../../../src/ocr/cli/completions.js";
import {
  isValidFormat,
  isValidAudience,
  isValidBatchStrategy,
} from "../../../src/ocr/cli/shared.js";
import type { CliIoOverrides } from "../../../src/ocr/cli/shared.js";
import { validateColorMode } from "../../../src/ocr/cli/color.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureIo(): { io: CliIoOverrides; stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      cwd: () => "/unused",
      env: () => ({ TERM: "dumb" }),
      stdout: (t: string) => { out += t; },
      stderr: (t: string) => { err += t; },
      stdoutIsTTY: () => false,
    },
    stdout: () => out,
    stderr: () => err,
  };
}

async function runCompletions(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cap = captureIo();
  const code = await runCli(["completions", ...args], { io: cap.io });
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

const SHELLS = ["bash", "zsh", "fish"] as const;

function generated(shell: (typeof SHELLS)[number]): string {
  if (shell === "bash") return generateBashCompletions(CLI_COMMANDS);
  if (shell === "zsh") return generateZshCompletions(CLI_COMMANDS);
  return generateFishCompletions(CLI_COMMANDS);
}

/** The per-command section of a generated script, extracted per shell. */
function commandSection(shell: (typeof SHELLS)[number], command: CliCommandSpec): string {
  const script = generated(shell);
  if (shell === "bash") {
    const names = [command.name, ...command.aliases].join("\\|");
    const match = script.match(new RegExp(`${names}\\) flags="([^"]*)"`));
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }
  if (shell === "zsh") {
    const match = script.match(new RegExp(`_pi_review_${command.name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`));
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }
  const condition = `__fish_seen_subcommand_from ${[command.name, ...command.aliases].join(" ")}`;
  return script
    .split("\n")
    .filter((line) => line.includes(condition))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Dispatch and exit codes
// ---------------------------------------------------------------------------

test("completions prints one script per shell on stdout and exits 0", async () => {
  for (const shell of SHELLS) {
    const result = await runCompletions([shell]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(200);
    expect(result.stderr).toBe("");
  }
});

test("completions output is deterministic", async () => {
  for (const shell of SHELLS) {
    const first = await runCompletions([shell]);
    const second = await runCompletions([shell]);
    expect(second.stdout).toBe(first.stdout);
  }
});

test("completions rejects a missing shell argument", async () => {
  const result = await runCompletions([]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Error:");
  expect(result.stderr).toContain("completions requires a shell argument");
  expect(result.stderr).toContain("Review flags:");
});

test("completions rejects an unknown shell", async () => {
  const result = await runCompletions(["tcsh"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('unknown shell "tcsh"');
  expect(result.stderr).toContain("Review flags:");
});

test("completions rejects more than one argument", async () => {
  const result = await runCompletions(["bash", "zsh"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('unexpected argument "zsh"');
});

test("completions --help prints the shared help page and exits 0", async () => {
  const result = await runCompletions(["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(HELP_TEXT);
  expect(result.stderr).toBe("");
});

test("unknown commands still list completions", async () => {
  const cap = captureIo();
  const code = await runCli(["unknown-cmd"], { io: cap.io });
  expect(code).toBe(1);
  expect(cap.stderr()).toContain('unknown command "unknown-cmd"');
  expect(cap.stderr()).toContain("review, scan, findings, or completions");
});

// ---------------------------------------------------------------------------
// Structural invariants shared by all three shells
// ---------------------------------------------------------------------------

test("all shells reference every command, alias, and manifest flag", () => {
  for (const shell of SHELLS) {
    const script = generated(shell);
    for (const command of CLI_COMMANDS) {
      for (const token of [command.name, ...command.aliases]) {
        expect(script).toContain(token);
      }
      const section = commandSection(shell, command);
      for (const flag of command.flags) {
        if (shell === "fish") {
          expect(section).toContain(`-l ${flag.name}`);
          if (flag.short !== undefined) expect(section).toContain(`-s ${flag.short}`);
        } else {
          expect(section).toContain(`--${flag.name}`);
          if (flag.short !== undefined) expect(section).toContain(`-${flag.short}`);
        }
      }
    }
  }
});

test("enum-valued flags offer exactly their candidate sets", () => {
  const candidates: ReadonlyArray<readonly [RegExp, string]> = [
    [/text json sarif/g, "format"],
    [/human agent/g, "audience"],
    [/auto always never/g, "color"],
    [/none by-language by-directory/g, "batch"],
  ];
  for (const shell of SHELLS) {
    const script = generated(shell);
    for (const [pattern, flag] of candidates) {
      const matches = script.match(pattern);
      expect(matches, `${shell}: ${flag} candidates`).not.toBeNull();
      expect(matches?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  }
});

test("boolean flags are never offered with value arity", () => {
  for (const shell of SHELLS) {
    const script = generated(shell);
    const booleans = CLI_COMMANDS.flatMap((command) => command.flags.filter((flag) => !flag.takesValue));
    expect(booleans.length).toBeGreaterThan(0);
    for (const flag of booleans) {
      if (shell === "bash") {
        // A case pattern like `--preview)` inside a value-completion section
        // would mean the flag consumes a value. Command-name case patterns
        // elsewhere are irrelevant and must not be scanned.
        const valueSections = [...script.matchAll(/case "\$(?:prev|flag)" in\n([\s\S]*?)\n\s*esac/g)].map(
          (match) => match[1] ?? "",
        );
        expect(valueSections.length).toBe(2);
        for (const section of valueSections) {
          expect(section).not.toContain(`--${flag.name}`);
          if (flag.short !== undefined) expect(section).not.toContain(`-${flag.short})`);
        }
      } else if (shell === "zsh") {
        // The trailing `=` marks a value-taking option spec.
        expect(script).not.toContain(`--${flag.name}=`);
      } else {
        // `-r` marks a required parameter on a fish completion line.
        const line = script
          .split("\n")
          .find((entry) => entry.includes(`-l ${flag.name} `) || entry.endsWith(`-l ${flag.name}`));
        expect(line, `fish line for --${flag.name}`).toBeDefined();
        expect(line).not.toMatch(/(^|\s)-r(\s|$)/);
      }
    }
  }
});

test("git refs are completed through git for-each-ref", () => {
  for (const shell of SHELLS) {
    expect(generated(shell)).toContain("for-each-ref");
  }
});

test("scripts are clean single documents: no ANSI escapes or CR", () => {
  for (const shell of SHELLS) {
    const script = generated(shell);
    expect(script).not.toMatch(/\x1b/);
    expect(script).not.toContain("\r");
  }
});

// ---------------------------------------------------------------------------
// Per-shell registration and shape
// ---------------------------------------------------------------------------

test("bash script registers the completion function", () => {
  const script = generateBashCompletions(CLI_COMMANDS);
  expect(script.startsWith("# bash completion for pi-review\n")).toBe(true);
  expect(script).toContain("complete -F _pi_review pi-review");
  expect(script).toContain('review r scan s findings completions version help');
  // Value kinds: enum, git refs, files, and free-form flags that complete nothing.
  expect(script).toContain('-f|--format) COMPREPLY=($(compgen -W "text json sarif" -- "$cur")); return 0 ;;');
  expect(script).toContain('git for-each-ref');
  expect(script).toContain('compgen -f -- "$cur"');
});

test("zsh script is a compdef file that registers itself", () => {
  const script = generateZshCompletions(CLI_COMMANDS);
  expect(script.startsWith("#compdef pi-review\n")).toBe(true);
  expect(script).toContain("_arguments -S");
  expect(script).toContain("_pi_review_git_refs");
  expect(script).toContain("compdef _pi_review pi-review");
  expect(script).toContain("'1:shell:(bash zsh fish)'");
  expect(script).toContain(":format:(text json sarif)");
  expect(script).toContain(":color:(auto always never)");
  expect(script).toContain(":from:_pi_review_git_refs");
});

test("fish script disables default files and completes the shell argument", () => {
  const script = generateFishCompletions(CLI_COMMANDS);
  expect(script.startsWith("# fish completion for pi-review\n")).toBe(true);
  expect(script).toContain("complete -c pi-review -f");
  expect(script).toContain("__fish_use_subcommand");
  // Git-ref parameters must not also offer file names.
  const gitrefLine = script.split("\n").find((line) => line.includes("-l commit "));
  expect(gitrefLine).toBeDefined();
  expect(gitrefLine).toMatch(/(^|\s)-f(\s|$)/);
  expect(gitrefLine).toContain("-a '(command git for-each-ref");
  const shellArg = script.split("\n").find((line) => line.includes("seen_subcommand_from completions") && line.includes("-a bash"));
  expect(shellArg).toBeDefined();
});

// ---------------------------------------------------------------------------
// Derivation from the manifest, not a hand-copied list
// ---------------------------------------------------------------------------

test("zsh dispatches every command token to a defined function", () => {
  const script = generateZshCompletions(CLI_COMMANDS);
  const defined = new Set(
    [...script.matchAll(/^_pi_review_(\w+)\(\) \{/gm)].map((match) => `_pi_review_${match[1] ?? ""}`),
  );
  const caseBlock = script.match(/case "\$cmd" in\n([\s\S]*?)\n    esac/);
  expect(caseBlock, "zsh dispatcher case block").not.toBeNull();
  const arms = [...(caseBlock?.[1] ?? "").matchAll(/^ +([\w|]+)\) (_pi_review_\w+) ;;/gm)];
  // Every dispatch arm must call a function the script actually defines;
  // a dead function or a missing arm is a silent completion hole.
  for (const arm of arms) {
    expect(defined.has(arm[2] ?? ""), `${arm[2] ?? ""} is defined`).toBe(true);
  }
  const dispatched = new Set(arms.flatMap((arm) => (arm[1] ?? "").split("|")));
  for (const command of CLI_COMMANDS) {
    for (const token of [command.name, ...command.aliases]) {
      expect(dispatched.has(token), `zsh dispatches ${token}`).toBe(true);
    }
  }
  expect(dispatched.has("completions"), "zsh dispatches completions").toBe(true);
});

test("zsh finds the command after root options like --color", () => {
  const script = generateZshCompletions(CLI_COMMANDS);
  // The dispatcher must scan words for the first command token instead of
  // assuming word 2, or `pi-review --color always review --<TAB>` dies.
  expect(script).toContain('for (( i = 2; i < CURRENT; i++ ))');
  expect(script).not.toContain('case "${words[2]}" in');
});

test("zsh completes the completions shell argument", () => {
  const script = generateZshCompletions(CLI_COMMANDS);
  expect(script).toContain("completions) _pi_review_completions ;;");
});

// ---------------------------------------------------------------------------
// Drift guards — the metadata that is NOT derived from the manifest
// ---------------------------------------------------------------------------

test("enum candidate lists pass the parser's own validators", () => {
  const validators: Readonly<Record<string, (value: string) => boolean>> = {
    audience: isValidAudience,
    batch: isValidBatchStrategy,
    color: validateColorMode,
    format: isValidFormat,
  };
  for (const [flag, accepts] of Object.entries(validators)) {
    const candidates = ENUM_CANDIDATES[flag];
    expect(candidates, `ENUM_CANDIDATES.${flag}`).toBeDefined();
    for (const candidate of candidates ?? []) {
      expect(accepts(candidate), `parser accepts ${flag}=${candidate}`).toBe(true);
    }
  }
});

test("value-kind tables only name real value-taking manifest flags", () => {
  const valueFlags = new Set(
    CLI_COMMANDS.flatMap((command) => command.flags)
      .filter((flag) => flag.takesValue)
      .map((flag) => flag.name),
  );
  const classified = [
    ...Object.keys(ENUM_CANDIDATES),
    ...GITREF_VALUE_FLAGS,
    ...DIR_VALUE_FLAGS,
    ...FILE_VALUE_FLAGS,
  ];
  for (const name of classified) {
    expect(valueFlags.has(name), `${name} is a manifest value flag`).toBe(true);
  }
  // And no kind table double-books a flag.
  const seen = new Set<string>();
  for (const name of classified) {
    expect(seen.has(name), `${name} classified once`).toBe(false);
    seen.add(name);
  }
});

test("every command token has a real description", () => {
  const script = generateZshCompletions(CLI_COMMANDS);
  const tokens = [
    ...CLI_COMMANDS.flatMap((command) => [command.name, ...command.aliases]),
    ...TERMINAL_COMMANDS,
  ];
  for (const token of tokens) {
    // The command list entry is 'name:description'; a missing description
    // falls back to the bare name, producing 'name:name'.
    expect(script, token).not.toContain(`'${token}:${token}'`);
  }
});

// ---------------------------------------------------------------------------
// bash value completion in both forms
// ---------------------------------------------------------------------------

test("bash completes attached --flag= values for every value kind", () => {
  const script = generateBashCompletions(CLI_COMMANDS);
  const attached = script.match(/case "\$flag" in\n([\s\S]*?)\n        esac/);
  expect(attached, "attached-value case block").not.toBeNull();
  const block = attached?.[1] ?? "";
  for (const spec of CLI_COMMANDS.flatMap((command) => command.flags).filter((flag) => flag.takesValue)) {
    const kind = flagValueKind(spec.name);
    if (kind === "free") continue; // free-form values intentionally complete nothing
    // Names may be grouped in one arm (e.g. `commit|from|to)`).
    const arm = new RegExp(`(?:^|[\\s|])${spec.name}(?:\\)|\\|)`, "m");
    expect(arm.test(block), `--${spec.name}= attached`).toBe(true);
  }
});

test("bash completes --repo as a directory", () => {
  const script = generateBashCompletions(CLI_COMMANDS);
  expect(script).toMatch(/--repo\)\n\s*COMPREPLY=\(\$\(compgen -d -- "\$cur"\)\); return 0 ;;/);
  expect(script).toContain('repo) COMPREPLY=($(compgen -d -P "--repo=" -- "$val")) ;;');
});

test("bash offers no flags for version, which accepts none", () => {
  const script = generateBashCompletions(CLI_COMMANDS);
  expect(script).toContain('version) flags="" ;;');
});

test("all shells complete the same git ref namespaces", () => {
  for (const shell of SHELLS) {
    const script = generated(shell);
    for (const namespace of ["refs/heads", "refs/tags", "refs/remotes"]) {
      expect(script, `${shell} scans ${namespace}`).toContain(namespace);
    }
  }
});

test("generated scripts parse under their own shell when available", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["bash", generateBashCompletions(CLI_COMMANDS)],
    ["zsh", generateZshCompletions(CLI_COMMANDS)],
    ["fish", generateFishCompletions(CLI_COMMANDS)],
  ];
  let checked = 0;
  for (const [shell, script] of cases) {
    const result = spawnSync(shell, ["-n"], { input: script, encoding: "utf8" });
    if (result.error !== undefined) continue; // shell not installed
    expect(result.status, `${shell} -n: ${result.stderr}`).toBe(0);
    checked += 1;
  }
  expect(checked).toBeGreaterThan(0);
});

test("generators derive flags from the injected manifest", () => {
  const synthetic: readonly CliCommandSpec[] = [
    {
      name: "synthetic",
      aliases: ["syn"],
      flags: [
        { name: "alpha", short: "a", takesValue: true },
        { name: "beta", takesValue: false },
      ],
    },
  ];
  const bash = generateBashCompletions(synthetic);
  expect(bash).toContain("synthetic syn");
  expect(bash).toContain("--alpha -a --beta");
  const zsh = generateZshCompletions(synthetic);
  expect(zsh).toContain("_pi_review_synthetic()");
  expect(zsh).toContain("(-a --alpha){-a,--alpha=}");
  const fish = generateFishCompletions(synthetic);
  expect(fish).toContain("-a synthetic");
  expect(fish).toContain("-l alpha -s a");
});
