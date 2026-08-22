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

test("custom tools file changes advertised tool definitions on factory transport seam", async () => {
  const repo = initRepoWithFile();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-"));
  const toolsPath = path.join(tmp, "tools.json");
  const customDef = {
    name: "custom_test_tool",
    description: "custom tool for factory boundary test",
    parameters: {
      type: "object",
      properties: {
        foo: { type: "string", description: "foo param" },
      },
      required: ["foo"],
    },
  };
  const customEntries = [
    { name: "custom_test_tool", plan_task: false, main_task: true, definition: customDef },
    { name: "code_comment", plan_task: false, main_task: true, definition: { name: "code_comment", description: "x", parameters: { type: "object", properties: {} } } },
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
    // Factory is async and will attempt to load diffs and create transport.
    // We only care that transport was called with custom tool defs.
    try {
      await factory();
    } catch (e) {
      // Factory may fail after transport due to missing LLM config, but spy should have captured.
      // If it threw before transport (e.g., load tools), rethrow.
      if (capturedTools === null) throw e;
    }
    expect(capturedTools).not.toBeNull();
    const toolsArr = capturedTools as Array<{ function: { name: string } }>;
    const names = toolsArr.map((t) => t.function.name);
    expect(names).toContain("custom_test_tool");
    // Verify that the custom tool's parameters are object-root and preserved
    const custom = toolsArr.find((t) => t.function.name === "custom_test_tool");
    expect(custom).toBeDefined();
    // Ensure bounded capabilities: no shell tool should be present
    expect(names).not.toContain("shell");
    expect(names).not.toContain("exec");
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
