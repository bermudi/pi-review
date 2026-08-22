// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/agent_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { Agent, NewAgent } from "../../../src/ocr/scan/scan.js";
import { loadDefaultScanTemplate, applyLanguageScan } from "../../../src/ocr/template/template.js";
import { mainTaskToolDefs } from "../../../src/ocr/tool/tools-config.js";
import { FileReader, FileReadProvider, CodeSearchProvider, FileFindProvider } from "../../../src/ocr/tool/filereader.js";
import { Registry } from "../../../src/ocr/tool/definitions.js";
import { ModeWorkspace } from "../../../src/ocr/diff/git.js";
import type { AnyLlmClient } from "../../../src/ocr/llmloop/types.js";

async function makeRepo(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-scan-test-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "harness@pi-reviewer.test"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "harness"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    await writeFile(p, content, "utf-8");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", `add ${name}`], { cwd: dir });
    await writeFile(p, content, "utf-8");
  }
  return { dir, cleanup };
}

function makeRegistry(repoDir: string): import("../../../src/ocr/llmloop/types.js").ToolRegistryLike {
  const fileReader = new FileReader({ RepoDir: repoDir, Mode: ModeWorkspace, Ref: "" });
  const registry = new Registry();
  registry.Register(new FileReadProvider(fileReader));
  registry.Register(new CodeSearchProvider(fileReader));
  registry.Register(new FileFindProvider(fileReader));
  registry.Freeze();
  return registry as unknown as import("../../../src/ocr/llmloop/types.js").ToolRegistryLike;
}

function fakeClient(comments: Array<{ path: string; content: string; existing_code: string }>): AnyLlmClient {
  return {
    complete: async () => ({
      content: "",
      toolCalls: [
        {
          id: "cc1",
          type: "function",
          function: {
            name: "code_comment",
            arguments: JSON.stringify({ comments }),
          },
        },
        {
          id: "td1",
          type: "function",
          function: {
            name: "task_done",
            arguments: JSON.stringify({ state: "DONE" }),
          },
        },
      ],
    }),
  };
}

describe("ocr scan Agent", () => {
  it("discovers, reviews, and resolves one file", async () => {
    const repo = await makeRepo({
      "main.ts": "function add(a: number, b: number) {\n  return a + b;\n}\n",
    });
    try {
      const template = applyLanguageScan(loadDefaultScanTemplate(), "English");
      const mainToolDefs = mainTaskToolDefs().filter((t) => t.function.name !== "file_read_diff");
      const agent: Agent = NewAgent({
        repoDir: repo.dir,
        template,
        llmClient: fakeClient([{
          path: "main.ts",
          content: "Add input validation.",
          existing_code: "function add(a: number, b: number) {",
        }]),
        tools: makeRegistry(repo.dir),
        mainToolDefs,
        model: "test-model",
        maxConcurrency: 1,
        concurrentTaskTimeoutMinutes: 1,
        skipPlan: true,
        skipDedup: true,
        skipSummary: true,
      });
      const comments = await agent.run();
      expect(comments.length).toBe(1);
      expect(comments[0]?.path).toBe("main.ts");
      expect(comments[0]?.content).toBe("Add input validation.");
      expect(comments[0]?.startLine).toBe(1);
      expect(comments[0]?.endLine).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  it("returns empty comments when no files pass filter", async () => {
    const repo = await makeRepo({
      "README.md": "# test\n",
    });
    try {
      const template = applyLanguageScan(loadDefaultScanTemplate(), "English");
      const agent = NewAgent({
        repoDir: repo.dir,
        template,
        llmClient: fakeClient([]),
        tools: makeRegistry(repo.dir),
        mainToolDefs: mainTaskToolDefs().filter((t) => t.function.name !== "file_read_diff"),
        model: "test-model",
        maxConcurrency: 1,
        concurrentTaskTimeoutMinutes: 1,
        skipPlan: true,
        skipDedup: true,
        skipSummary: true,
      });
      const comments = await agent.run();
      expect(comments.length).toBe(0);
      expect(agent.items.length).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});
