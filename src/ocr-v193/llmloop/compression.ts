// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/compression.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later
// See LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

// Compression thresholds, as fractions of MaxTokens.
// Mirrors Go constants tokenSoftThreshold / tokenWarningThreshold.
export const tokenSoftThreshold = 0.60;
export const tokenWarningThreshold = 0.80;
export const TOKEN_SOFT_THRESHOLD = tokenSoftThreshold;
export const TOKEN_WARNING_THRESHOLD = tokenWarningThreshold;

/**
 * PromptTokenLimit returns tokenWarningThreshold (80%) of maxTokens.
 * Mirrors Go int(float64(maxTokens)*0.80). Non-positive input is not
 * special-cased — each caller decides what that means.
 */
export function PromptTokenLimit(maxTokens: number): number {
  return Math.trunc(maxTokens * tokenWarningThreshold);
}

// ---------------------------------------------------------------------------
// Message model — mirrors internal/llm.Message minimal surface needed for
// compression. Re-declared here to avoid importing legacy src/* policy.
// ---------------------------------------------------------------------------

export interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly tool_use_id?: string;
  readonly content?: readonly ContentBlock[];
}

export interface ToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface Message {
  readonly role: string;
  readonly content: string | readonly ContentBlock[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ToolCall[];
}

export function newTextMessage(role: string, content: string): Message {
  return { role, content };
}

function extractBlockText(block: ContentBlock): string {
  if (block.text !== undefined && block.text !== "") {
    return block.text;
  }
  if (block.content !== undefined) {
    let out = "";
    for (const nested of block.content) {
      out += extractBlockText(nested);
    }
    return out;
  }
  return "";
}

export function extractText(message: Message): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let sb = "";
    for (const block of c) sb += extractBlockText(block as ContentBlock);
    return sb;
  }
  return "";
}

// Token counting — mirrors llm.CountTokens / countTokensWithEncoding fallback.
// Go uses tiktoken-go (cl100k_base / o200k_base) with fallback len(bytes)/4.
// This port uses the fallback estimator (byte length / 4) to stay deterministic
// without a JS tiktoken dependency. Gap documented in report.
export function countTokens(text: string): number {
  if (text === "") return 0;
  const bytes = new TextEncoder().encode(text).length;
  return Math.floor(bytes / 4);
}

export const CountTokens = countTokens;

/**
 * CountMessagesTokens returns the rough token count of msgs by summing the
 * per-message text token count. Exported because both review and scan top
 * layers may want it for pre-flight checks.
 */
export function CountMessagesTokens(msgs: readonly Message[]): number {
  let total = 0;
  for (const m of msgs) total += countTokens(extractText(m));
  return total;
}

// ---------------------------------------------------------------------------
// Round / partition helpers
// ---------------------------------------------------------------------------

export interface Round {
  readonly assistantIdx: number;
  readonly toolIdxs: readonly number[];
}

export interface PartitionResult {
  readonly frozenEnd: number;
  readonly compressEnd: number;
  readonly rounds: readonly Round[];
  readonly activeCount: number;
}

/**
 * groupIntoRounds parses messages[start:] into logical (assistant + tool_results) pairs.
 * Mirrors Go groupIntoRounds.
 */
export function groupIntoRounds(messages: readonly Message[], start: number): Round[] {
  const rounds: Round[] = [];
  let i = start;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === "assistant") {
      const toolIdxs: number[] = [];
      const assistantIdx = i;
      i++;
      while (i < messages.length) {
        const t = messages[i];
        if (t !== undefined && t.role === "tool") {
          toolIdxs.push(i);
          i++;
        } else break;
      }
      rounds.push({ assistantIdx, toolIdxs });
    } else {
      i++;
    }
  }
  return rounds;
}

/**
 * computeActiveZoneSize returns how many trailing rounds fit within the
 * remaining token budget after accounting for the frozen zone and the
 * compressed summary. Mirrors Go computeActiveZoneSize.
 */
export function computeActiveZoneSize(
  rounds: readonly Round[],
  messages: readonly Message[],
  maxTokens: number,
  reservedTokens: number,
): number {
  const budget = PromptTokenLimit(maxTokens) - reservedTokens;
  if (budget <= 0) return 0;

  let count = 0;
  let tokensUsed = 0;
  for (let idx = rounds.length - 1; idx >= 0; idx--) {
    const r = rounds[idx];
    if (r === undefined) continue;
    const assistantMsg = messages[r.assistantIdx];
    let roundTokens = assistantMsg !== undefined ? countTokens(extractText(assistantMsg)) : 0;
    for (const ti of r.toolIdxs) {
      const toolMsg = messages[ti];
      if (toolMsg !== undefined) roundTokens += countTokens(extractText(toolMsg));
    }
    if (tokensUsed + roundTokens > budget) break;
    tokensUsed += roundTokens;
    count++;
  }
  return count;
}

/**
 * partitionMessages divides messages into frozen, compress, and active zones.
 * Frozen zone is always messages[0:2]. Active zone preserves the K most
 * recent complete rounds based on available token budget.
 * Mirrors Go partitionMessages.
 */
export function partitionMessages(
  messages: readonly Message[],
  maxTokens: number,
  prevSummaryTokenEstimate: number,
): PartitionResult {
  if (messages.length <= 2) {
    return { frozenEnd: 2, compressEnd: messages.length, rounds: [], activeCount: 0 };
  }

  const rounds = groupIntoRounds(messages, 2);
  if (rounds.length === 0) {
    return { frozenEnd: 2, compressEnd: messages.length, rounds, activeCount: 0 };
  }

  const activeCount = computeActiveZoneSize(rounds, messages, maxTokens, prevSummaryTokenEstimate);
  if (activeCount >= rounds.length) {
    // Everything fits — no compression needed.
    return { frozenEnd: 2, compressEnd: messages.length, rounds, activeCount: 0 };
  }

  const activeStartIdx = rounds.length - activeCount;
  const lastCompressRound = rounds[activeStartIdx - 1];
  if (lastCompressRound === undefined) {
    return { frozenEnd: 2, compressEnd: 2, rounds, activeCount };
  }
  let compressEnd: number;
  if (lastCompressRound.toolIdxs.length > 0) {
    const lastToolIdx = lastCompressRound.toolIdxs[lastCompressRound.toolIdxs.length - 1];
    compressEnd = lastToolIdx !== undefined ? lastToolIdx + 1 : lastCompressRound.assistantIdx + 1;
  } else {
    compressEnd = lastCompressRound.assistantIdx + 1;
  }
  return { frozenEnd: 2, compressEnd, rounds, activeCount };
}

// ---------------------------------------------------------------------------
// Markdown fence stripping — mirrors Go stripMarkdownFences / StripMarkdownFences
// ---------------------------------------------------------------------------

function stripMarkdownFences(s: string): string {
  s = s.trim();
  if (s.startsWith("```")) {
    const nl = s.indexOf("\n");
    if (nl >= 0) {
      s = s.slice(nl + 1);
    } else {
      if (s.startsWith("```json")) s = s.slice("```json".length);
      else if (s.startsWith("```")) s = s.slice("```".length);
    }
  }
  s = s.trim();
  if (s.endsWith("```")) {
    s = s.slice(0, -"```".length);
    s = s.trim();
  }
  return s;
}

export function StripMarkdownFences(s: string): string {
  return stripMarkdownFences(s);
}

export const stripMarkdownFencesExport = stripMarkdownFences;

// ---------------------------------------------------------------------------
// Message serialization / copy
// ---------------------------------------------------------------------------

/**
 * buildMessageXML serializes msgs into the <message><content> form expected
 * by the MEMORY_COMPRESSION_TASK prompt template.
 * Mirrors Go buildMessageXML exactly.
 */
export function buildMessageXML(msgs: readonly Message[]): string {
  let sb = "";
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m === undefined) continue;
    sb += `<message id="${i}" role="${m.role}">\n`;
    sb += "    <content>\n";
    sb += `      ${extractText(m)}\n`;
    sb += "    </content>\n";
    sb += "</message>";
    if (i < msgs.length - 1) sb += "\n";
  }
  return sb;
}

/**
 * copyMessages creates a shallow copy of a message slice.
 * Mirrors Go copyMessages.
 */
export function copyMessages(msgs: readonly Message[]): Message[] {
  return [...msgs];
}

// ---------------------------------------------------------------------------
// Compression helpers — pure rebuilt logic
// ---------------------------------------------------------------------------

/**
 * rebuildWithSummary constructs the rebuilt message array as Go runCompression does:
 *   rebuilt = msgs[:2] with summary appended to msgs[1], then msgs[compressEnd:]
 * Returns null if rawSummary is empty (failure keeps original per Go).
 */
export function rebuildWithSummary(
  msgs: readonly Message[],
  compressEnd: number,
  rawSummary: string,
): Message[] | null {
  const cleaned = StripMarkdownFences(rawSummary);
  if (cleaned === "") return null;
  if (msgs.length < 2) return null;
  const rebuilt: Message[] = [];
  const first = msgs[0];
  const second = msgs[1];
  if (first !== undefined) rebuilt.push(first);
  if (second !== undefined) {
    const currentText = extractText(second);
    rebuilt.push(newTextMessage(second.role, currentText + "\n\n<previous_review_summary>\n" + cleaned + "\n</previous_review_summary>"));
  }
  for (let i = compressEnd; i < msgs.length; i++) {
    const m = msgs[i];
    if (m !== undefined) rebuilt.push(m);
  }
  return rebuilt;
}

// ---------------------------------------------------------------------------
// Compression state — async per-file isolation
// Mirrors Go compressionState / compressionJob / triggerAsyncCompression /
// tryApplyPendingCompression / cancelPendingCompression.
// Failure keeps original (applied only on success with non-empty rebuilt).
// ---------------------------------------------------------------------------

interface InternalJob {
  readonly snapshotLen: number;
  rebuilt: Message[] | null;
  readonly done: Promise<void>;
  resolveDone: () => void;
  doneResolved: boolean;
  readonly abortController: AbortController;
  readonly cancel: () => void;
}

function createJob(snapshotLen: number, timeoutMs: number): InternalJob {
  const abortController = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const wrappedResolve = (): void => {
    clearTimeout(timeout);
    resolveDone();
  };
  return {
    snapshotLen,
    rebuilt: null,
    done,
    resolveDone: wrappedResolve,
    doneResolved: false,
    abortController,
    cancel: () => {
      clearTimeout(timeout);
      abortController.abort();
    },
  };
}

/**
 * CompressionState is the async-compression bookkeeping for a single
 * conversation (one RunPerFile call). The Runner is shared by concurrent
 * per-file goroutines, so this state must not live on the Runner: a shared
 * slot lets one file apply, cancel, or replace another file's compression
 * job (#384). Mirrors Go compressionState.
 *
 * In TypeScript JS is single-threaded so no mutex is required, but the
 * logical guard `if (pendingJob !== null) return` is preserved for isolation.
 */
export class CompressionState {
  private pendingJob: InternalJob | null = null;

  hasPendingJob(): boolean {
    return this.pendingJob !== null;
  }

  getPendingDone(): Promise<void> | null {
    return this.pendingJob?.done ?? null;
  }

  /**
   * triggerAsyncCompression kicks off a background compression job for the
   * conversation owning this state. A no-op when a job is already pending.
   * Mirrors Go Runner.triggerAsyncCompression.
   *
   * @param messages current conversation messages (snapshot is copied)
   * @param filePath file identifier for session scoping (passed to compressor)
   * @param compressor async function that performs the actual LLM compression:
   *                   (snapshot, filePath, signal) => Promise<rebuilt>
   *                   On success should return rebuilt messages.
   *                   On failure should reject; failure keeps original per Go.
   */
  triggerAsyncCompression(
    messages: readonly Message[],
    filePath: string,
    compressor: (snapshot: readonly Message[], filePath: string, signal: AbortSignal) => Promise<Message[]>,
  ): void {
    if (this.pendingJob !== null) return;

    const snapshot = copyMessages(messages);
    const job = createJob(messages.length, 5 * 60 * 1000);
    this.pendingJob = job;

    void (async () => {
      let rebuilt: Message[] | null = null;
      let err: unknown = null;
      try {
        rebuilt = await compressor(snapshot, filePath, job.abortController.signal);
      } catch (e) {
        err = e;
      }

      if (this.pendingJob !== job) return;

      if (err !== null) {
        console.error(`[ocr] Memory compression failed: ${String(err)}`);
        job.doneResolved = true;
        job.resolveDone();
        if (this.pendingJob === job) this.pendingJob = null;
        return;
      }

      if (rebuilt !== null && rebuilt.length > 0) {
        job.rebuilt = rebuilt;
      } else {
        job.rebuilt = null;
      }
      job.doneResolved = true;
      job.resolveDone();
    })();
  }

  /**
   * tryApplyPendingCompression checks whether a background compression has
   * completed and swaps the rebuilt messages into place. Returns true if applied.
   * Mirrors Go Runner.tryApplyPendingCompression — non-blocking select on done.
   *
   * Mutates `messages` in-place (splice) to match Go `*[]Message` pointer semantics.
   */
  tryApplyPendingCompression(messages: Message[]): boolean {
    const job = this.pendingJob;
    if (job === null) return false;
    if (!job.doneResolved) return false;
    if (this.pendingJob !== job) return false;

    let applied = false;
    if (job.rebuilt !== null) {
      let rebuilt = job.rebuilt;
      if (job.snapshotLen < messages.length) {
        rebuilt = [...rebuilt, ...messages.slice(job.snapshotLen)];
      }
      messages.splice(0, messages.length, ...rebuilt);
      applied = true;
    }
    if (this.pendingJob === job) this.pendingJob = null;
    return applied;
  }

  /**
   * Async variant that awaits the pending job before applying.
   * Convenience for tests; Go callers poll tryApply.
   */
  async awaitAndApply(messages: Message[]): Promise<boolean> {
    const job = this.pendingJob;
    if (job === null) return false;
    await job.done;
    job.doneResolved = true;
    if (this.pendingJob !== job) return false;
    if (job.rebuilt !== null) {
      let rebuilt = job.rebuilt;
      if (job.snapshotLen < messages.length) {
        rebuilt = [...rebuilt, ...messages.slice(job.snapshotLen)];
      }
      messages.splice(0, messages.length, ...rebuilt);
      this.pendingJob = null;
      return true;
    }
    if (this.pendingJob === job) this.pendingJob = null;
    return false;
  }

  /**
   * cancelPendingCompression aborts the conversation's in-flight background
   * compression, if any. Mirrors Go cancelPendingCompression.
   */
  cancelPendingCompression(): void {
    if (this.pendingJob !== null) {
      const job = this.pendingJob;
      job.cancel();
      job.doneResolved = true;
      job.resolveDone();
      this.pendingJob = null;
    }
  }
}
