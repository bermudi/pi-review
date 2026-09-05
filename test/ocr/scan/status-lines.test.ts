// SPDX-License-Identifier: Apache-2.0
// Live status lines for scan dispatch: start line and done line with note
// count and done counter on the human stderr channel. pi-reviewer
// independent behavior, not OCR parity.

import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { NewAgent } from "../../../src/ocr/scan/scan.js";
import { loadDefaultScanTemplate, applyLanguageScan } from "../../../src/ocr/template/template.js";
import { mainTaskToolDefs } from "../../../src/ocr/tool/tools-config.js";
import { FileReader, FileReadProvider, CodeSearchProvider, FileFindProvider } from "../../../src/ocr/tool/filereader.js";
import { Registry } from "../../../src/ocr/tool/definitions.js";
import { ModeWorkspace } from "../../../src/ocr/diff/git.js";
import type { AnyLlmClient } from "../../../src/ocr/llmloop/types.js";
import type { ProgressSink } from "../../../src/ocr/progress.js";

async function makeRepo(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-scan-status-"));
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

describe("scan status lines", () => {
  it("emits start and done lines with the done counter", async () => {
    const repo = await makeRepo({
      "main.ts": "function add(a: number, b: number) {\n  return a + b;\n}\n",
    });
    try {
      const template = applyLanguageScan(loadDefaultScanTemplate(), "English");
      const mainToolDefs = mainTaskToolDefs().filter((t) => t.function.name !== "file_read_diff");
      const messages: string[] = [];
      const sink: ProgressSink = { emit: (e) => messages.push(e.message) };
      const agent = NewAgent({
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
        progress: sink,
      });
      const comments = await agent.run();
      expect(comments.length).toBe(1);
      expect(messages.some((m) => m === "[pi-review] Checking main.ts...")).toBe(true);
      expect(messages.some((m) => m === "[pi-review] main.ts done, 1 note (1/1 files done)")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
