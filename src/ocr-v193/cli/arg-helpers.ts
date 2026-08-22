// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/arg_errors.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Positional-argument helpers for friendly error messages.
 * Mirrors OCR's exactArgs / minimumArgs / argCountError / positionalSignature / validArgNames.
 */

export interface CommandLike {
  readonly Use: string;
  readonly ValidArgs?: readonly string[] | null;
  readonly UseLine?: () => string;
  readonly CommandPath?: () => string;
  readonly Example?: string;
}

export type PositionalArgs = (cmd: CommandLike, args: readonly string[]) => Error | null;

export function exactArgs(n: number): PositionalArgs {
  return (cmd: CommandLike, args: readonly string[]): Error | null => {
    if (args.length === n) return null;
    return argCountError(cmd, `requires exactly ${n} argument(s)`);
  };
}

export function minimumArgs(n: number): PositionalArgs {
  return (cmd: CommandLike, args: readonly string[]): Error | null => {
    if (args.length >= n) return null;
    return argCountError(cmd, `requires at least ${n} argument(s)`);
  };
}

export function argCountError(cmd: CommandLike, requirement: string): Error {
  const parts: string[] = [];
  const path = cmd.CommandPath ? cmd.CommandPath() : "command";
  const sig = positionalSignature(cmd);
  let header = `"${path}" ${requirement}`;
  if (sig !== "") header += ` (${sig})`;
  parts.push(header);

  if (cmd.ValidArgs && cmd.ValidArgs.length > 0) {
    parts.push(`\n\nValid values: ${validArgNames([...cmd.ValidArgs]).join(", ")}`);
  }

  const useLine = cmd.UseLine ? cmd.UseLine() : cmd.Use;
  parts.push(`\n\nUsage:\n  ${useLine}`);

  const example = (cmd.Example ?? "").replace(/\n+$/u, "");
  if (example !== "") {
    parts.push(`\n\nExample:\n${example}`);
  }

  parts.push(`\n\nRun '${path} --help' for more information.`);
  return new Error(parts.join(""));
}

export function positionalSignature(cmd: CommandLike): string {
  const fields = cmd.Use.trim() === "" ? [] : cmd.Use.trim().split(/\s+/u);
  if (fields.length < 2) return "";
  const parts: string[] = [];
  for (const f of fields.slice(1)) {
    if (f.startsWith("<")) parts.push(f);
  }
  return parts.join(" ");
}

export function validArgNames(valid: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of valid) {
    out.push(v.split("\t", 2)[0] ?? v);
  }
  return out;
}
