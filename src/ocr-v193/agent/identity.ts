// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/identity.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { Provider } from "../diff/git.js";
import type { Diff } from "../model/diff.js";

function hashFields(...fields: string[]): string {
  const h = createHash("sha256");
  const lenBuf = Buffer.allocUnsafe(8);
  for (const f of fields) {
    const bytes = Buffer.from(f, "utf-8");
    lenBuf.writeBigUInt64BE(BigInt(bytes.length), 0);
    h.update(lenBuf);
    h.update(bytes);
  }
  return h.digest("hex");
}

function fingerprintForDiff(mode: string, d: Diff): string {
  const diffText = d.diff.replace(/[\r\n]+$/g, "");
  const payload = `${mode}\u0000${d.oldPath}\u0000${d.newPath}\u0000${diffText}`;
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

function itemIdForDiff(mode: string, d: Diff): string {
  const oldP = d.oldPath === "/dev/null" ? "" : d.oldPath;
  const newP = d.newPath === "/dev/null" ? "" : d.newPath;
  return `review:${mode}:${oldP}:${newP}`;
}

// ---------------------------------------------------------------------------
// Types — mirrors Go SealedInput
// ---------------------------------------------------------------------------

export interface InputResolution {
  readonly resolvedBase: string;
  readonly resolvedHead: string;
  readonly exactRange: string;
}

export interface RunIdentity {
  readonly mode: string;
  readonly sourceArtifactSHA256: string;
  readonly ruleConfigSHA256: string;
  readonly repositorySHA256: string;
}

export interface SealedInput {
  readonly identity: RunIdentity;
  readonly resolution: InputResolution;
}

// ---------------------------------------------------------------------------
// Helpers mirroring Go resolveCommitHead / resolveInputBeforeDiff
// ---------------------------------------------------------------------------

async function resolveCommitHead(
  repoDir: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const p = Provider.forCommit(repoDir, ref, null);
  const res = await p.resolveInput(signal);
  return res.resolvedHead;
}

async function resolveInputBeforeDiff(
  repoDir: string,
  from: string | undefined,
  to: string | undefined,
  commit: string | undefined,
  signal?: AbortSignal,
): Promise<InputResolution | null> {
  if (commit !== undefined && commit !== "") {
    const head = await resolveCommitHead(repoDir, commit, signal);
    if (head === "") throw new Error(`resolve commit ${JSON.stringify(commit)}`);
    return { resolvedBase: "", resolvedHead: head, exactRange: "" };
  }
  if (from !== undefined && from !== "" && to !== undefined && to !== "") {
    const fromHead = await resolveCommitHead(repoDir, from, signal);
    if (fromHead === "") throw new Error(`resolve commit ${JSON.stringify(from)}`);
    const head = await resolveCommitHead(repoDir, to, signal);
    if (head === "") throw new Error(`resolve commit ${JSON.stringify(to)}`);
    const prov = Provider.forRange(repoDir, fromHead, head, null);
    const resolved = await prov.resolveInput(signal);
    if (resolved.resolvedBase === "") {
      throw new Error(`resolve merge-base between ${JSON.stringify(from)} and ${JSON.stringify(to)}`);
    }
    return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identity helpers — mirrors Go runIdentity / sourceArtifactSHA256 / ruleConfigSHA256
// ---------------------------------------------------------------------------

function repositorySHA256(raw: string): string {
  if (raw === "") return "";
  const h = createHash("sha256");
  h.update(raw, "utf-8");
  return h.digest("hex");
}

/**
 * sourceArtifactSHA256ForDiffs replicates Agent.sourceArtifactSHA256 without
 * needing an Agent instance. It hashes (itemId, fingerprint) pairs.
 * ItemId is simplified to `${mode}\0${old}\0${new}` hashed similarly; fingerprint
 * is the per-file diff hash. The exact Go hashFields framing is preserved where
 * possible via the shared hashFields helper.
 */
export function sourceArtifactSHA256For(
  mode: string,
  diffs: readonly Diff[],
  fingerprintFor: (d: Diff) => string,
  itemIdFor: (d: Diff) => string,
): string {
  type Pair = { id: string; fingerprint: string };
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    if (d.isDeleted) continue;
    const id = itemIdFor(d);
    if (seen.has(id)) continue;
    seen.add(id);
    pairs.push({ id, fingerprint: fingerprintFor(d) });
  }
  pairs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fields: string[] = [];
  for (const p of pairs) {
    fields.push(p.id, p.fingerprint);
  }
  return hashFields(...fields);
}

// ---------------------------------------------------------------------------
// Public entry — mirrors Go ResolveIdentity
// ---------------------------------------------------------------------------

export interface ResolveIdentityArgs {
  readonly repoDir: string;
  readonly from?: string;
  readonly to?: string;
  readonly commit?: string;
  readonly sealedInput?: InputResolution | null;
  readonly fileFilter?: unknown;
  readonly systemRule?: unknown;
  readonly template?: unknown;
  readonly Template?: unknown;
}

export async function resolveIdentity(
  args: ResolveIdentityArgs,
  signal?: AbortSignal,
): Promise<SealedInput> {
  let sealed: InputResolution | null = null;
  try {
    sealed = await resolveInputBeforeDiff(args.repoDir, args.from, args.to, args.commit, signal);
  } catch (err) {
    throw err;
  }
  // Build a minimal Agent to reuse its selection and identity logic exactly.
  const { Agent } = await import("./agent.js");
  const dummyClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
  let maxTokens = 4000;
  const tmplRaw = (args as unknown as Record<string, unknown>)["template"] ?? (args as unknown as Record<string, unknown>)["Template"];
  if (tmplRaw !== null && typeof tmplRaw === "object") {
    const mt = (tmplRaw as Record<string, unknown>)["MaxTokens"] ?? (tmplRaw as Record<string, unknown>)["maxTokens"];
    if (typeof mt === "number") maxTokens = mt;
  }
  const explicitMax = (args as unknown as Record<string, unknown>)["maxTokens"] as number | undefined;
  if (typeof explicitMax === "number") maxTokens = explicitMax;
  const agentArgs: Record<string, unknown> = {
    repoDir: args.repoDir,
    from: args.from,
    to: args.to,
    commit: args.commit,
    sealedInput: sealed,
    fileFilter: (args as unknown as Record<string, unknown>)["fileFilter"] ?? null,
    systemRule: (args as unknown as Record<string, unknown>)["systemRule"] ?? null,
    template: { MaxTokens: maxTokens, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } },
    model: "test",
    llmClient: dummyClient,
    mainToolDefs: [],
  };
  // Propagate explicit fileFilter/systemRule lower case variants
  if ((args as unknown as Record<string, unknown>)["FileFilter"] !== undefined) agentArgs["fileFilter"] = (args as unknown as Record<string, unknown>)["FileFilter"];
  if ((args as unknown as Record<string, unknown>)["SystemRule"] !== undefined) agentArgs["systemRule"] = (args as unknown as Record<string, unknown>)["SystemRule"];
  const agent = new Agent(agentArgs as unknown as never);
  await (agent as unknown as { loadDiffs: (s?: AbortSignal) => Promise<void> }).loadDiffs(signal);
  // Apply same two filter passes as the run
  const anyAgent = agent as unknown as { filterDiffs: (d: unknown[]) => unknown[]; filterLargeDiffs: (d: unknown[]) => unknown[]; diffs: unknown[]; runIdentity: () => RunIdentity; inputResolution: InputResolution };
  anyAgent.diffs = anyAgent.filterDiffs(anyAgent.diffs);
  anyAgent.diffs = anyAgent.filterLargeDiffs(anyAgent.diffs);
  const identity = anyAgent.runIdentity();
  const resolution = (agent as unknown as { inputResolution: InputResolution }).inputResolution ?? sealed ?? { resolvedBase: "", resolvedHead: "", exactRange: "" };
  return { identity, resolution };
}

function deriveMode(from: string | undefined, to: string | undefined, commit: string | undefined): string {
  if (commit !== undefined && commit !== "") return "commit";
  if (from !== undefined && from !== "" && to !== undefined && to !== "") return "range";
  return "workspace";
}

export const ResolveIdentity = resolveIdentity;
