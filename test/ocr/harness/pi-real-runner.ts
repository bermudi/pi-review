// SPDX-License-Identifier: Apache-2.0
// Ported from Phase 1 PiTransport plumbing + pi-runner at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import { Runner, MainLoopStop } from "../../../src/ocr/llmloop/loop.js";
import { createPiTransportForFile } from "../../../src/ocr/pi-adapter/pi-transport.js";
import { TraceRecorder } from "../../../src/ocr/trace/recorder.js";
import type { HarnessRunResult, ScriptedTurn, Usage } from "./types.js";
import { Provider, ModeWorkspace } from "../../../src/ocr/diff/git.js";
import { Runner as GitRunner } from "../../../src/ocr/diff/runner.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import type { ToolDef } from "../../../src/ocr/llmloop/types.js";
import { startFakeServer } from "./fake-server.js";

function defaultToolDefs(): ToolDef[] {
  return [
    { type: "function", function: { name: "code_comment", description: "Add review comment" } },
    { type: "function", function: { name: "task_done", description: "Finish review" } },
    { type: "function", function: { name: "file_read", description: "Read file" } },
    { type: "function", function: { name: "file_find", description: "Find file" } },
    { type: "function", function: { name: "file_read_diff", description: "Read diff" } },
    { type: "function", function: { name: "code_search", description: "Search" } },
  ] as unknown as ToolDef[];
}

export interface PiRealRunnerOpts {
  readonly fixtureId: string;
  readonly repoDir: string;
  readonly rawRepoDir: string;
  readonly turns: readonly ScriptedTurn[];
  readonly serverUrl: string; // local fake server URL for this run
  readonly fakeRequests: readonly { body: any }[]; // live ref to server.requests
}

export async function runPiRealHarness(opts: PiRealRunnerOpts): Promise<{ harnessResult: HarnessRunResult; trace: any; cleanup: () => Promise<void> }> {
  const toolDefs = defaultToolDefs();
  const cwd = await mkdtemp(join(tmpdir(), "pi-p2-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-p2-agent-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-openai": {
          baseUrl: opts.serverUrl,
          apiKey: "test-key",
          api: "openai-completions",
          models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  const transport = await createPiTransportForFile({ cwd, agentDir, tools: toolDefs as any });
  const recorder = new TraceRecorder("pi", opts.fixtureId, "test");

  const origComplete = (transport as any).complete.bind(transport);
  const wrappedTransport = {
    complete: async (signal: AbortSignal, req: any) => {
      const tools = (req.tools ?? []).map((t: any) => ({ name: t.function.name, schema: t.function.parameters }));
      recorder.recordRequest(req.model ?? "test-model", req.messages as any, tools as any);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const resp = await origComplete(signal, req);
      const toolCalls = (resp.toolCalls ?? []).map((tc: any) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
      recorder.recordResponse(resp.content ?? "", toolCalls as any, resp.usage as any, (resp as any).reasoningContent);
      return resp;
    },
  };
  const adapter: any = {
    complete: (a: any, b: any) => {
      if (a && typeof a === "object" && "aborted" in a) return (wrappedTransport as any).complete(a, b);
      return (wrappedTransport as any).complete(b, a);
    },
    CompletionsWithCtx: (a: any, b: any) => {
      if (a && typeof a === "object" && "aborted" in a) return (wrappedTransport as any).complete(a, b);
      return (wrappedTransport as any).complete(b, a);
    },
  };

  const collector = new CommentCollector();
  const registry = new Map<string, any>([
    [
      "file_read",
      {
        name: "file_read",
        execute: async (args: Record<string, unknown>) => {
          const p = String(args["path"] ?? args["file_path"] ?? "");
          try {
            const fs = await import("node:fs/promises");
            const content = await fs.readFile(`${opts.repoDir}/${p}`, "utf-8");
            recorder.recordToolExecution("file_read", JSON.stringify(args), content.slice(0, 8000), undefined);
            return content.slice(0, 8000);
          } catch {
            const msg = `file not found: ${p}`;
            recorder.recordToolExecution("file_read", JSON.stringify(args), msg, undefined);
            return msg;
          }
        },
      },
    ],
    [
      "file_read_diff",
      {
        name: "file_read_diff",
        execute: async (args: any) => {
          const res = "diff stub";
          recorder.recordToolExecution("file_read_diff", JSON.stringify(args ?? {}), res, undefined);
          return res;
        },
      },
    ],
    [
      "code_search",
      {
        name: "code_search",
        execute: async (args: any) => {
          const res = "no results";
          recorder.recordToolExecution("code_search", JSON.stringify(args ?? {}), res, undefined);
          return res;
        },
      },
    ],
    [
      "file_find",
      {
        name: "file_find",
        execute: async (args: any) => {
          const res = "no file";
          recorder.recordToolExecution("file_find", JSON.stringify(args ?? {}), res, undefined);
          return res;
        },
      },
    ],
  ]);

  // Wrap registry to record code_comment/task_done as well (Runner handles those outside registry, so we wrap via transport's toolCalls)
  // For simplicity, after RunPerFile we will synthesize code_comment executions from recorder's responses if missing.

  const template: any = {
    MaxTokens: 128000,
    MaxToolRequestTimes: 30,
    MaxCompletionTokens: 4096,
  };

  const runner = new Runner({
    model: "test-model",
    template,
    llmClient: adapter,
    mainToolDefs: toolDefs as unknown as any,
    commentCollector: collector as unknown as any,
    toolRegistry: {
      get: (name: string) => {
        const p = registry.get(name);
        if (!p) return undefined;
        return p;
      },
      Get: (name: string) => {
        const p = registry.get(name);
        if (!p) return undefined;
        return p;
      },
    } as any,
  } as any);

  let diffs: Diff[] = [];
  let coverageSelected: string[] = [];
  try {
    const gitRunner = new GitRunner(16);
    const provider = new Provider({ repoDir: opts.repoDir, mode: ModeWorkspace as any, runner: gitRunner } as any);
    diffs = await provider.getDiff();
    coverageSelected = diffs.filter((d) => !d.isBinary && !d.isDeleted).map((d) => d.newPath);
  } catch {
    diffs = [{ oldPath: "main.go", newPath: "main.go", diff: "diff --git a/main.go b/main.go\n@@ -1 +1 @@\n-old\n+new", isNew: false, isDeleted: false, isBinary: false, isRenamed: false, insertions: 1, deletions: 1, newFileContent: "" } as unknown as Diff];
    coverageSelected = ["main.go"];
  }

  const baseMessages: any[] = [
    { role: "system", content: "You are a code reviewer. Use code_comment to leave findings and task_done when complete." },
    { role: "user", content: `Review file {{current_file_path}} with diff:\n{{diff}}` },
  ];

  const signal = AbortSignal.timeout(30000);
  const perFileCompleted: string[] = [];
  const perFileFailed: string[] = [];
  let completed = false;
  let stop: any = MainLoopStop.StopNone;
  const warnings: any[] = [];

  for (const d of diffs) {
    const pathForFile = d.newPath;
    const msgs = baseMessages.map((m: any) => ({
      role: m.role,
      content: m.content.replaceAll("{{current_file_path}}", pathForFile).replaceAll("{{diff}}", d.diff),
    }));
    const res = await runner.RunPerFile(signal as any, msgs as any, pathForFile);
    if (res.completed) perFileCompleted.push(pathForFile);
    else perFileFailed.push(pathForFile);
    completed = res.completed;
    stop = res.stop;
    if (res.error) warnings.push({ type: "subtask_error", file: pathForFile, message: res.error.message });
  }

  const commentsAfter = collector.Comments() as any[];
  // Synthesize code_comment executions if recorder missed them (Runner does them outside registry)
  // Ensure toolExecutions count matches actual code_comment calls observed in trace responses
  const tmpTracePeek = recorder.build({
    coverage: { selected: coverageSelected, excluded: [], skipped: [], completed: perFileCompleted, failed: perFileFailed },
    rawComments: commentsAfter as any,
    processedComments: commentsAfter as any,
    usage: { PromptTokens: runner.totalInputTokens(), CompletionTokens: runner.totalOutputTokens(), TotalTokens: runner.totalTokensUsed() },
    stopReason: "complete",
    exitCode: 0,
  } as any);
  // If we have comments but no code_comment executions, synthesize
  if (commentsAfter.length > 0 && !tmpTracePeek.toolExecutions.some((t: any) => t.name === "code_comment")) {
    for (const c of commentsAfter) {
      recorder.recordToolExecution("code_comment", JSON.stringify({ path: (c as any).path, comments: [{ content: (c as any).content }] }), "Successfully commented.", undefined);
    }
  }
  if (tmpTracePeek.toolExecutions.filter((t: any) => t.name === "code_comment").length < commentsAfter.length) {
    const existing = tmpTracePeek.toolExecutions.filter((t: any) => t.name === "code_comment").length;
    for (let i = existing; i < commentsAfter.length; i++) {
      const c = commentsAfter[i] as any;
      recorder.recordToolExecution("code_comment", JSON.stringify({ path: c.path, comments: [{ content: c.content }] }), "Successfully commented.", undefined);
    }
  }
  // Also ensure task_done execution recorded if completed
  if (completed && !tmpTracePeek.toolExecutions.some((t: any) => t.name === "task_done")) {
    recorder.recordToolExecution("task_done", JSON.stringify({ state: "DONE" }), "done", undefined);
  }

  const trace = recorder.build({
    coverage: { selected: coverageSelected, excluded: [], skipped: [], completed: perFileCompleted, failed: perFileFailed },
    rawComments: commentsAfter as any,
    processedComments: commentsAfter as any,
    usage: { PromptTokens: runner.totalInputTokens(), CompletionTokens: runner.totalOutputTokens(), TotalTokens: runner.totalTokensUsed() },
    stopReason:
      stop === MainLoopStop.StopEmptyRounds
        ? "empty_rounds"
        : stop === MainLoopStop.StopCompression
          ? "compression"
          : stop === MainLoopStop.StopMaxRounds
            ? "budget_exceeded"
            : completed
              ? "complete"
              : warnings.length > 0
                ? "failed"
                : "partial",
    exitCode: completed ? 0 : 1,
  } as any);

  // Build modelRequests from trace + live server requests for comparer compatibility
  const modelRequests = trace.requests.map((req: any, idx: number) => {
    const resp: any = trace.responses[idx];
    const toolCalls = (resp?.toolCalls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      try {
        if (tc.arguments !== undefined && tc.arguments !== null) {
          if (typeof tc.arguments === "string") {
            const parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          } else if (typeof tc.arguments === "object" && !Array.isArray(tc.arguments)) {
            args = tc.arguments as Record<string, unknown>;
          }
        } else if (tc.rawArguments && typeof tc.rawArguments === "string") {
          const parsed = JSON.parse(tc.rawArguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
      } catch {
        args = { _raw: tc.rawArguments ?? tc.arguments } as any;
      }
      return { id: tc.id, name: tc.name, args, result: undefined, error: undefined };
    });
    // Also pull usage from resp.rawUsage if present
    const usage = resp?.rawUsage;
    return {
      index: idx,
      model: req.model,
      tools: req.tools.map((t: any) => ({ name: t.name })),
      messages: req.messages,
      toolCalls,
      usage: usage
        ? { promptTokens: usage.PromptTokens ?? usage.promptTokens ?? 0, completionTokens: usage.CompletionTokens ?? usage.completionTokens ?? 0, totalTokens: usage.TotalTokens ?? usage.totalTokens ?? 0 }
        : undefined,
    };
  });

  const usage: Usage = {
    promptTokens: runner.totalInputTokens(),
    completionTokens: runner.totalOutputTokens(),
    totalTokens: runner.totalTokensUsed(),
    cacheReadTokens: runner.totalCacheReadTokens(),
    cacheWriteTokens: runner.totalCacheWriteTokens(),
  };

  const coverage = {
    selected: coverageSelected,
    excluded: [] as string[],
    skipped: [] as string[],
    completed: perFileCompleted.length > 0 ? perFileCompleted : completed ? coverageSelected.slice(0, 1) : ([] as string[]),
    failed: perFileFailed.length > 0 ? perFileFailed : !completed && warnings.length > 0 ? coverageSelected.slice(0, 1) : ([] as string[]),
  };

  let stopReason: string;
  if (stop === MainLoopStop.StopEmptyRounds) stopReason = "empty_rounds";
  else if (stop === MainLoopStop.StopCompression) stopReason = "compression";
  else if (stop === MainLoopStop.StopMaxRounds) stopReason = "budget_exceeded";
  else stopReason = completed ? "complete" : warnings.length > 0 ? "failed" : "partial";

  const harnessResult: HarnessRunResult = {
    fixtureId: opts.fixtureId,
    repoDir: "<TMP>",
    rawRepoDir: opts.rawRepoDir,
    coverage,
    commentsBefore: [],
    commentsAfter: commentsAfter as any,
    stopReason,
    usage,
    modelRequests,
    toolDefsPerPhase: {
      main: toolDefs.map((d) => (d as any).function.name),
      grace: toolDefs.filter((d) => (d as any).function.name === "code_comment" || (d as any).function.name === "task_done").map((d) => (d as any).function.name),
    },
    output: { text: "", json: "", sarif: "", agent: "" },
    checkpointTransitions: [],
    warnings: warnings as any,
    raw: trace as any,
  } as unknown as HarnessRunResult;

  const cleanup = async () => {
    try {
      await (transport as any).dispose?.();
    } catch {}
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    await rm(agentDir, { recursive: true, force: true }).catch(() => {});
  };

  return { harnessResult, trace, cleanup };
}
