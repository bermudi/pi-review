// Idle watchdog: active files survive, quiet files time out.
// pi-reviewer independent behavior (not OCR parity): the per-file timer
// measures time since last model activity, not total wall-clock time.

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../../src/ocr/agent/agent.js";
import { Runner } from "../../../src/ocr/llmloop/loop.js";
import { ScriptedTransport } from "../../../src/ocr/llmloop/transcript.js";
import { newTextMessage, type Message } from "../../../src/ocr/llmloop/compression.js";
import type { ToolDef, Template } from "../../../src/ocr/llmloop/types.js";
import type { Diff } from "../../../src/ocr/model/diff.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-idle-"));
}

function makeTemplate(): Template {
  return {
    MaxTokens: 10000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "user", content: "review {{diff}}" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
    PlanModeLineThreshold: 1000,
  } as unknown as Template;
}

function makeDiff(): Diff {
  return {
    oldPath: "a.go",
    newPath: "a.go",
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

describe("per-file idle timeout", () => {
  test("RunPerFile reports each successful model response as activity", async () => {
    const transport = new ScriptedTransport([
      {
        toolCalls: [{ id: "done-1", name: "task_done", arguments: "{}" }],
        usage: { PromptTokens: 1, CompletionTokens: 1, CacheReadTokens: 0, CacheWriteTokens: 0 },
      },
    ]);
    const adapter = {
      complete: (signal: AbortSignal, req: unknown): Promise<unknown> =>
        (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req, signal),
      CompletionsWithCtx: (signal: AbortSignal, req: unknown): Promise<unknown> =>
        (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req, signal),
    };
    const runner = new Runner({
      model: "test",
      template: { MaxTokens: 4000, MaxToolRequestTimes: 5, MaxCompletionTokens: 1000 } as unknown as Template,
      llmClient: adapter as unknown as never,
      mainToolDefs: [{ type: "function", function: { name: "task_done" } }] as unknown as readonly ToolDef[],
    } as unknown as ConstructorParameters<typeof Runner>[0]);

    let activity = 0;
    const msgs: Message[] = [newTextMessage("user", "hi")];
    const res = await runner.RunPerFile(new AbortController().signal, msgs, "a.go", () => {
      activity++;
    });
    expect(res.completed).toBe(true);
    expect(activity).toBe(1);
    await runner.waitBackground();
  });

  test("active file survives past the timeout window when it keeps responding", async () => {
    // 0.005 minutes = 300ms idle window. Three 100ms steps total 300ms+;
    // each step reports activity so the watchdog keeps resetting.
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: { complete: async (): Promise<never> => { throw new Error("unused"); } } as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [{ type: "function", function: { name: "task_done" } }] as unknown as never,
      maxConcurrency: 1,
      concurrentTaskTimeoutMinutes: 0.005,
      skipFilter: true,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [makeDiff()];
    const runner = (agent as unknown as { runner: Runner }).runner;
    runner.RunPerFile = (async (
      signal: AbortSignal,
      _messages: unknown,
      _filePath: string,
      onActivity?: () => void,
    ): Promise<{ completed: boolean; stop: number }> => {
      await abortableSleep(signal, 100);
      try { onActivity?.(); } catch {}
      await abortableSleep(signal, 100);
      try { onActivity?.(); } catch {}
      await abortableSleep(signal, 100);
      try { onActivity?.(); } catch {}
      return { completed: true, stop: 0 };
    }) as unknown as Runner["RunPerFile"];

    const comments = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
      new AbortController().signal,
    );
    expect(comments.length).toBe(0);
    const outcomes = (agent as unknown as { subtaskOutcomes: Map<string, { completed: boolean }> }).subtaskOutcomes;
    expect(outcomes.get("a.go")?.completed).toBe(true);
  });

  test("quiet file times out and stays classified as timeout", async () => {
    // 0.004 minutes = 240ms idle window; the subtask goes quiet for 600ms.
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: { complete: async (): Promise<never> => { throw new Error("unused"); } } as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [{ type: "function", function: { name: "task_done" } }] as unknown as never,
      maxConcurrency: 1,
      concurrentTaskTimeoutMinutes: 0.004,
      skipFilter: true,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [makeDiff()];
    const runner = (agent as unknown as { runner: Runner }).runner;
    runner.RunPerFile = ((signal: AbortSignal): Promise<{ completed: boolean; stop: number }> =>
      abortableSleep(signal, 600).then(() => ({ completed: true, stop: 0 }))) as unknown as Runner["RunPerFile"];

    let threw = "";
    try {
      await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
        new AbortController().signal,
      );
    } catch (e) {
      threw = (e as Error).message;
    }
    expect(threw).toContain("failed");
    const warnings = (agent as unknown as { warningsList: () => Array<{ message: string }> }).warningsList();
    const joined = warnings.map((w) => w.message).join("\n");
    expect(joined).toContain("file task timeout");
  });
});
