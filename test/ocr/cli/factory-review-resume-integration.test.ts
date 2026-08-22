// Production resume boundary: real factory, real Git, scripted transport only.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createReviewRunnerFactory, type RuntimeTransport } from "../../../src/ocr/cli/factory.js";
import { defaultReviewOptions } from "../../../src/ocr/cli/shared.js";
import { SessionFilePath } from "../../../src/ocr/session/persist.js";

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function scripted(calls: { value: number }, reject = false): RuntimeTransport {
  return {
    CompletionsWithCtx: async () => {
      calls.value += 1;
      if (reject) throw new Error("model must not be called");
      if (calls.value === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "comment",
            type: "function",
            function: { name: "code_comment", arguments: JSON.stringify({ path: "main.go", comments: [{ content: "real finding", existing_code: "package main" }] }) },
          }],
        };
      }
      return { content: "", toolCalls: [{ id: "done", type: "function", function: { name: "task_done", arguments: "{}" } }] };
    },
    dispose: async () => {},
    modelIdentity: () => ({ provider: "test-provider", model: "test-model" }),
  };
}

test("real review factory persists and reuses a completed range checkpoint", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-factory-resume-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-factory-resume-home-"));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "main.go"), "package main\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "base"]);
    fs.writeFileSync(path.join(repo, "main.go"), "package main\n// changed\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "head"]);
    const opts = { ...defaultReviewOptions(), repoDir: repo, from: "HEAD~1", to: "HEAD", concurrency: 1, noFilter: true };
    const parentCalls = { value: 0 };
    const parent = await createReviewRunnerFactory(opts, repo, { createTransport: async () => scripted(parentCalls) })();
    const parentComments = await parent.run();
    expect(parentComments).toHaveLength(1);
    expect(parent.manifest?.execution.provider).toBe("test-provider");
    expect(parent.manifest?.execution.model).toBe("test-model");
    const parentText = fs.readFileSync(SessionFilePath(repo, parent.sessionId), "utf8");
    expect(parentText).toContain('"type":"review_item_done"');
    expect(parentText).toContain('"type":"session_end"');

    const childCalls = { value: 0 };
    const child = await createReviewRunnerFactory(
      { ...opts, resume: parent.sessionId },
      repo,
      { createTransport: async () => scripted(childCalls, true) },
    )();
    const childComments = await child.run();
    expect(childCalls.value).toBe(0);
    expect(childComments).toHaveLength(1);
    expect(child.resumeInfo).toMatchObject({ resumedFrom: parent.sessionId, reusedFiles: 1, rerunFiles: 0 });
    expect(child.manifest?.parentRunId).toBe(parent.sessionId);
    const childText = fs.readFileSync(SessionFilePath(repo, child.sessionId), "utf8");
    expect(childText).toContain(`"resumedFrom":"${parent.sessionId}"`);
    expect((childText.match(/"type":"resume_lineage"/g) ?? [])).toHaveLength(1);
    expect(childText.indexOf('"type":"resume_lineage"')).toBeLessThan(childText.indexOf('"type":"review_item_reused"'));
  } finally {
    process.env.HOME = priorHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
