// pi-reviewer extension tests: duplicate file_read guard + no-progress early stop.
// Motivated by a 60-minute review where one file re-read the same windows
// 18x and cycled through 8 compressions. These are owned pi-reviewer
// contracts, not OCR parity.

import { describe, test, expect } from "bun:test";
import { Runner, MainLoopStop, fileReadRangeKey } from "../../../src/ocr/llmloop/loop.ts";
import { ScriptedTransport, type ScriptedResponse } from "../../../src/ocr/llmloop/transcript.ts";
import { newTextMessage, type Message } from "../../../src/ocr/llmloop/compression.ts";
import type { ToolDef, Template } from "../../../src/ocr/llmloop/types.ts";
import type { LlmComment } from "../../../src/ocr/model/types.ts";

type StubCollector = {
  readonly store: LlmComment[];
  add: (c: LlmComment) => void;
  comments: () => LlmComment[];
  Add: (c: LlmComment) => void;
  Comments: () => LlmComment[];
};

function createCollector(): StubCollector {
  const store: LlmComment[] = [];
  const c: StubCollector = {
    store,
    add(comment: LlmComment): void {
      store.push(comment);
    },
    comments(): LlmComment[] {
      return [...store];
    },
    Add(comment: LlmComment): void {
      store.push(comment);
    },
    Comments(): LlmComment[] {
      return [...store];
    },
  };
  return c;
}

type ToolProviderStub = {
  readonly name: string;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string;
};

function makeRunner(opts: {
  readonly responses: readonly ScriptedResponse[];
  readonly toolRegistry?: Map<string, ToolProviderStub>;
  readonly maxTools?: number;
}): { readonly runner: Runner; readonly transport: ScriptedTransport; readonly collector: StubCollector } {
  const transport = new ScriptedTransport(opts.responses);
  const adapter = {
    complete: (signal: AbortSignal, req: unknown): Promise<unknown> => {
      return (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(
        req as unknown,
        signal as unknown,
      );
    },
    CompletionsWithCtx: (signal: AbortSignal, req: unknown): Promise<unknown> => {
      return (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(
        req as unknown,
        signal as unknown,
      );
    },
  };
  const template = {
    MaxTokens: 4000,
    MaxToolRequestTimes: opts.maxTools ?? 30,
    MaxCompletionTokens: 1000,
  } as Template;
  const mainToolDefs = [
    { type: "function", function: { name: "code_comment" } },
    { type: "function", function: { name: "task_done" } },
    { type: "function", function: { name: "file_read" } },
  ] as unknown as readonly ToolDef[];
  const collector = createCollector();
  const registry = opts.toolRegistry ?? new Map<string, ToolProviderStub>();
  const deps = {
    model: "fake",
    template,
    llmClient: adapter as unknown,
    mainToolDefs,
    commentCollector: collector as unknown,
    toolRegistry: registry,
  };
  const runner = new Runner(deps as unknown as ConstructorParameters<typeof Runner>[0]);
  return { runner, transport, collector };
}

describe("duplicate file_read guard", () => {
  test("fileReadRangeKey normalizes defaults", () => {
    const nul = "\u0000";
    expect(fileReadRangeKey({ file_path: "a.ts" })).toBe(`a.ts${nul}1${nul}0`);
    expect(fileReadRangeKey({ file_path: "a.ts", start_line: 1, end_line: 100 })).toBe(`a.ts${nul}1${nul}100`);
    expect(fileReadRangeKey({})).toBeNull();
    expect(fileReadRangeKey({ file_path: "" })).toBeNull();
  });

  test("second identical file_read returns a short reminder without calling the provider", async () => {
    let calls = 0;
    const registry = new Map<string, ToolProviderStub>([
      ["file_read", { name: "file_read", execute: (): string => { calls++; return "line1\nline2\n"; } }],
    ]);
    const { runner } = makeRunner({
      responses: [],
      toolRegistry: registry,
    });
    const sig = new AbortController().signal;
    const mk = (id: string): never => ({
      id,
      type: "function",
      function: { name: "file_read", arguments: JSON.stringify({ file_path: "src/a.ts", start_line: 1, end_line: 100 }) },
    }) as unknown as never;

    const first = await runner.executeToolCall(sig, "src/a.ts", mk("1"), "", null);
    const second = await runner.executeToolCall(sig, "src/a.ts", mk("2"), "", null);

    expect(calls).toBe(1);
    expect(first.data).toContain("line1");
    expect(second.data).toContain("already read");
    expect(second.data.length).toBeLessThan(first.data.length + 500);
  });

  test("different ranges still hit the provider", async () => {
    let calls = 0;
    const registry = new Map<string, ToolProviderStub>([
      ["file_read", { name: "file_read", execute: (): string => { calls++; return "content"; } }],
    ]);
    const { runner } = makeRunner({ responses: [], toolRegistry: registry });
    const sig = new AbortController().signal;
    const mk = (id: string, start: number, end: number): never => ({
      id,
      type: "function",
      function: { name: "file_read", arguments: JSON.stringify({ file_path: "src/a.ts", start_line: start, end_line: end }) },
    }) as unknown as never;
    await runner.executeToolCall(sig, "src/a.ts", mk("1", 1, 100), "", null);
    await runner.executeToolCall(sig, "src/a.ts", mk("2", 101, 200), "", null);
    expect(calls).toBe(2);
  });

  test("duplicate-only rounds stop early instead of running to the round cap", async () => {
    const registry = new Map<string, ToolProviderStub>([
      ["file_read", { name: "file_read", execute: (): string => "content" }],
    ]);
    // 30 identical reads would previously run all 30 rounds. With the guard
    // the first read is real and the next 8 duplicate-only rounds stop early.
    const dupCall = (id: string): ScriptedResponse["toolCalls"] extends readonly (infer T)[] | undefined ? T : never => ({
      id,
      name: "file_read",
      arguments: JSON.stringify({ file_path: "src/a.ts", start_line: 1, end_line: 50 }),
    }) as unknown as ScriptedResponse["toolCalls"] extends readonly (infer T)[] | undefined ? T : never;
    const responses: readonly ScriptedResponse[] = Array.from({ length: 30 }, (_, i) => ({
      toolCalls: [dupCall(`c${i}`)],
    }));
    const { runner, transport } = makeRunner({ responses, toolRegistry: registry, maxTools: 30 });
    const msgs: Message[] = [newTextMessage("user", "review")];
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "src/a.ts");
    expect(result.completed).toBe(false);
    expect(result.stop).toBe(MainLoopStop.StopEmptyRounds);
    // 1 real + 8 duplicate-only rounds = 9 requests, not 30.
    expect(transport.requests.length).toBe(9);
  });

  test("code_comment resets the no-progress counter", async () => {
    const registry = new Map<string, ToolProviderStub>([
      ["file_read", { name: "file_read", execute: (): string => "content" }],
    ]);
    const dup = (id: string): { readonly id: string; readonly name: string; readonly arguments: string } => ({
      id,
      name: "file_read",
      arguments: JSON.stringify({ file_path: "src/a.ts", start_line: 1, end_line: 50 }),
    });
    const responses: readonly ScriptedResponse[] = [
      { toolCalls: [dup("c0")] },
      {
        toolCalls: [{
          id: "cm1",
          name: "code_comment",
          arguments: JSON.stringify({
            comments: [{ content: "issue", existing_code: "x", category: "bug", severity: "low", path: "src/a.ts" }],
          }),
        }],
      },
      ...Array.from({ length: 8 }, (_, i) => ({ toolCalls: [dup(`d${i}`)] })),
      { toolCalls: [{ id: "done", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
    ];
    const { runner, transport } = makeRunner({ responses, toolRegistry: registry, maxTools: 30 });
    const msgs: Message[] = [newTextMessage("user", "review")];
    // The run should survive the first duplicate round because a comment
    // landed in between; it stops after 8 duplicates following the comment.
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "src/a.ts");
    expect(result.completed).toBe(false);
    expect(result.stop).toBe(MainLoopStop.StopEmptyRounds);
    expect(transport.requests.length).toBeLessThan(30);
    expect(transport.requests.length).toBeGreaterThan(3);
  });
});
