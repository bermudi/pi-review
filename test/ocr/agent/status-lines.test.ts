// SPDX-License-Identifier: Apache-2.0
// Live status lines: per-file lifecycle progress on the human stderr channel
// via the injected ProgressSink. Milestones only (start / done / quiet
// warning / done counter) — never model message content. pi-reviewer
// independent behavior, not OCR parity.

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../../src/ocr/agent/agent.js";
import { Runner } from "../../../src/ocr/llmloop/loop.js";
import type { Template, ToolDef } from "../../../src/ocr/llmloop/types.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";
import type { ProgressSink } from "../../../src/ocr/progress.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-"));
}

function makeTemplate(): Template {
  return {
    MaxTokens: 10000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "user", content: "review {{diff}}" }] },
    PlanModeLineThreshold: 1000,
  } as unknown as Template;
}

function makeDiff(newPath: string): Diff {
  return {
    oldPath: newPath,
    newPath,
    diff: "+x",
    newFileContent: "",
    isBinary: false,
    isDeleted: false,
    isNew: false,
    isRenamed: false,
    insertions: 1,
    deletions: 0,
  } as unknown as Diff;
}

function makeCollector(comments: LlmComment[]): {
  add: (c: LlmComment) => void;
  comments: () => LlmComment[];
  commentsForPath: (p: string) => LlmComment[];
} {
  const store: LlmComment[] = [...comments];
  return {
    add: (c: LlmComment): void => {
      store.push(c);
    },
    comments: (): LlmComment[] => [...store],
    commentsForPath: (p: string): LlmComment[] => store.filter((c) => c.path === p),
  };
}

function recordingSink(): { sink: ProgressSink; messages: string[] } {
  const messages: string[] = [];
  return { sink: { emit: (e) => messages.push(e.message) }, messages };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    throw reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      const reason = (signal as AbortSignal & { reason?: unknown }).reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function makeAgent(opts: { timeoutMinutes?: number; collector?: unknown; sink: ProgressSink }): Agent {
  return new Agent({
    repoDir: makeTempDir(),
    model: "test",
    llmClient: { complete: async (): Promise<never> => { throw new Error("unused"); } } as unknown as never,
    template: makeTemplate(),
    mainToolDefs: [{ type: "function", function: { name: "task_done" } }] as unknown as never,
    maxConcurrency: 2,
    concurrentTaskTimeoutMinutes: opts.timeoutMinutes,
    skipFilter: true,
    commentCollector: opts.collector ?? null,
    progress: opts.sink,
  } as unknown as never);
}

describe("per-file status lines", () => {
  test("emits start line and done line with note count and counter", async () => {
    const { sink, messages } = recordingSink();
    const collector = makeCollector([{ path: "a.go", content: "note", start_line: 1, end_line: 2 } as LlmComment]);
    const agent = makeAgent({ timeoutMinutes: 5, collector, sink });
    (agent as unknown as { diffs: Diff[] }).diffs = [makeDiff("a.go")];
    const runner = (agent as unknown as { runner: Runner }).runner;
    runner.RunPerFile = (async (): Promise<{ completed: boolean; stop: number }> => {
      await sleep(10);
      return { completed: true, stop: 0 };
    }) as unknown as Runner["RunPerFile"];

    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
      new AbortController().signal,
    );
    expect(messages.some((m) => m === "[pi-review] Checking a.go...")).toBe(true);
    expect(messages.some((m) => m === "[pi-review] a.go done, 1 note (1/1 files done)")).toBe(true);
  });

  test("emits a quiet warning at half the idle window before the abort", async () => {
    const { sink, messages } = recordingSink();
    // 0.004 minutes = 240ms idle window; warning at 120ms, abort at 240ms.
    const agent = makeAgent({ timeoutMinutes: 0.004, sink });
    (agent as unknown as { diffs: Diff[] }).diffs = [makeDiff("a.go")];
    const runner = (agent as unknown as { runner: Runner }).runner;
    runner.RunPerFile = ((signal: AbortSignal): Promise<{ completed: boolean; stop: number }> =>
      abortableSleep(signal, 600).then(() => ({ completed: true, stop: 0 }))) as unknown as Runner["RunPerFile"];

    await expect(
      (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const quiet = messages.find((m) => m.includes("still waiting"));
    expect(quiet).toBeDefined();
    expect(quiet).toContain("a.go");
    // The abort itself still classifies as a timeout.
    const warnings = (agent as unknown as { warningsList: () => Array<{ message: string }> }).warningsList();
    expect(warnings.map((w) => w.message).join("\n")).toContain("file task timeout");
  });

  test("failed files count toward the done counter without a done line", async () => {
    const { sink, messages } = recordingSink();
    const agent = makeAgent({ timeoutMinutes: 5, sink });
    (agent as unknown as { diffs: Diff[] }).diffs = [makeDiff("a.go"), makeDiff("b.go")];
    const runner = (agent as unknown as { runner: Runner }).runner;
    runner.RunPerFile = (async (_signal: AbortSignal, _msgs: unknown, filePath: string): Promise<{ completed: boolean; stop: number }> => {
      if (filePath === "b.go") throw new Error("boom");
      await sleep(50);
      return { completed: true, stop: 0 };
    }) as unknown as Runner["RunPerFile"];

    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
      new AbortController().signal,
    );
    expect(messages.some((m) => m === "[pi-review] Checking a.go...")).toBe(true);
    expect(messages.some((m) => m === "[pi-review] Checking b.go...")).toBe(true);
    // b.go failed (error line, no done line) but still counts as finished.
    expect(messages.some((m) => m.includes("Subtask error for b.go"))).toBe(true);
    expect(messages.some((m) => m === "[pi-review] a.go done, 0 notes (2/2 files done)")).toBe(true);
  });
});
