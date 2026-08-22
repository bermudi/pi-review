// Production-boundary test for --tools wiring (not OCR-annotated)
// Proves that a custom tools.json changes the definitions advertised on the
// real factory/transport seam, not merely that JSON can be parsed.

import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as PiTransport from "../../../src/ocr-v193/pi-adapter/pi-transport.js";
import { createReviewRunnerFactory } from "../../../src/ocr-v193/cli/factory.js";

function initRepoWithFile(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-factory-"));
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial"]);
  // Create a working-tree change so diff is non-empty
  fs.writeFileSync(path.join(repo, "file.txt"), "hello modified\n", "utf8");
  return repo;
}

test("custom tools file customizes safe built-in schema and reaches transport", async () => {
  const repo = initRepoWithFile();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-"));
  const toolsPath = path.join(tmp, "tools.json");
  const customDesc = "CUSTOM_CODE_COMMENT_FOR_TEST_" + Math.random().toString(36).slice(2);
  const customDef = {
    name: "code_comment",
    description: customDesc,
    parameters: {
      type: "object",
      properties: {
        comments: { type: "array", description: "custom" },
      },
      required: ["comments"],
    },
  };
  // Override code_comment and keep task_done to prove reorder/subset works; order is custom first
  const customEntries = [
    { name: "code_comment", plan_task: false, main_task: true, definition: customDef },
    { name: "task_done", plan_task: false, main_task: true, definition: { name: "task_done", description: "done", parameters: { type: "object", properties: { state: { type: "string" } }, required: ["state"] } } },
  ];
  fs.writeFileSync(toolsPath, JSON.stringify(customEntries), "utf8");

  let capturedTools: unknown = null;
  const spy = spyOn(PiTransport as unknown as Record<string, unknown> & { createPiTransportForFile: (...a: unknown[]) => Promise<unknown> }, "createPiTransportForFile").mockImplementation(async (opts: unknown) => {
    const o = opts as { tools?: unknown };
    capturedTools = o.tools;
    return {
      dispose: async () => {},
      complete: async () => ({ content: "", toolCalls: [], usage: undefined }),
    } as unknown as never;
  });

  try {
    const factory = createReviewRunnerFactory(
      {
        toolConfigPath: toolsPath,
        rulePath: "",
        repoDir: repo,
        from: "",
        to: "",
        commit: "",
        resume: "",
        excludes: "",
        outputFormat: "text",
        audience: "human",
        background: "",
        backgroundFile: "",
        provider: "",
        model: "",
        concurrency: 1,
        perFileTimeout: 10,
        maxTools: 0,
        maxGitProcs: 2,
        maxTokens: 0,
        maxTokensBudget: 0,
        noFilter: false,
        preview: false,
      } as never,
      repo,
    );
    try {
      await factory();
    } catch (e) {
      if (capturedTools === null) throw e;
    }
    expect(capturedTools).not.toBeNull();
    const toolsArr = capturedTools as Array<{ function: { name: string; description?: string } }>;
    const names = toolsArr.map((t) => t.function.name);
    // Custom file reorders/subsets: only the two safe tools should be advertised, in file order
    expect(names).toEqual(["code_comment", "task_done"]);
    const cc = toolsArr.find((t) => t.function.name === "code_comment");
    expect(cc).toBeDefined();
    expect(cc!.function.description).toBe(customDesc);
  } finally {
    spy.mockRestore();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("arbitrary and shell-like definitions never reach transport", async () => {
  const repo = initRepoWithFile();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-"));
  const toolsPath = path.join(tmp, "tools.json");
  const customEntries = [
    { name: "shell", plan_task: false, main_task: true, definition: { name: "shell", description: "run shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
    { name: "custom_test_tool", plan_task: false, main_task: true, definition: { name: "custom_test_tool", description: "x", parameters: { type: "object", properties: {} } } },
    { name: "code_comment", plan_task: false, main_task: true, definition: { name: "code_comment", description: "keep", parameters: { type: "object", properties: {} } } },
  ];
  fs.writeFileSync(toolsPath, JSON.stringify(customEntries), "utf8");

  let capturedTools: unknown = null;
  const spy = spyOn(PiTransport as unknown as Record<string, unknown> & { createPiTransportForFile: (...a: unknown[]) => Promise<unknown> }, "createPiTransportForFile").mockImplementation(async (opts: unknown) => {
    const o = opts as { tools?: unknown };
    capturedTools = o.tools;
    return {
      dispose: async () => {},
      complete: async () => ({ content: "", toolCalls: [], usage: undefined }),
    } as unknown as never;
  });

  try {
    const factory = createReviewRunnerFactory(
      {
        toolConfigPath: toolsPath,
        rulePath: "",
        repoDir: repo,
        from: "",
        to: "",
        commit: "",
        resume: "",
        excludes: "",
        outputFormat: "text",
        audience: "human",
        background: "",
        backgroundFile: "",
        provider: "",
        model: "",
        concurrency: 1,
        perFileTimeout: 10,
        maxTools: 0,
        maxGitProcs: 2,
        maxTokens: 0,
        maxTokensBudget: 0,
        noFilter: false,
        preview: false,
      } as never,
      repo,
    );
    try {
      await factory();
    } catch (e) {
      if (capturedTools === null) throw e;
    }
    expect(capturedTools).not.toBeNull();
    const toolsArr = capturedTools as Array<{ function: { name: string } }>;
    const names = toolsArr.map((t) => t.function.name);
    expect(names).not.toContain("shell");
    expect(names).not.toContain("custom_test_tool");
    expect(names).toContain("code_comment");
    // Only allowlisted safe tools should be advertised; arbitrary ones are dropped
    expect(names.every((n) => ["task_done", "code_comment", "file_read", "code_search", "file_read_diff", "file_find"].includes(n))).toBe(true);
  } finally {
    spy.mockRestore();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("factory rejects invalid tools file with load tools error", async () => {
  const repo = initRepoWithFile();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-"));
  const badPath = path.join(tmp, "bad.json");
  fs.writeFileSync(badPath, "not json", "utf8");
  try {
    const factory = createReviewRunnerFactory(
      {
        toolConfigPath: badPath,
        rulePath: "",
        repoDir: repo,
        from: "",
        to: "",
        commit: "",
        resume: "",
        excludes: "",
        outputFormat: "text",
        audience: "human",
        background: "",
        backgroundFile: "",
        provider: "",
        model: "",
        concurrency: 1,
        perFileTimeout: 10,
        maxTools: 0,
        maxGitProcs: 2,
        maxTokens: 0,
        maxTokensBudget: 0,
        noFilter: false,
        preview: false,
      } as never,
      repo,
    );
    let threw = false;
    try {
      await factory();
    } catch (e) {
      threw = true;
      expect(String((e as Error).message)).toContain("load tools");
    }
    expect(threw).toBe(true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
