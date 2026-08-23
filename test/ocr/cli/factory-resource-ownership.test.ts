// No-network production factory ownership tests.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createReviewRunnerFactory,
  createScanRunnerFactory,
  type RuntimeTransport,
} from "../../../src/ocr/cli/factory.js";
import { defaultReviewOptions, defaultScanOptions } from "../../../src/ocr/cli/shared.js";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-owned-"));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]] as const) {
    if (spawnSync("git", args, { cwd: dir }).status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  fs.writeFileSync(path.join(dir, "main.go"), "package main\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "main.go"), "package main\n// changed\n");
  return dir;
}

function scripted(dispose: () => Promise<void>): RuntimeTransport {
  return {
    CompletionsWithCtx: async () => ({
      content: "",
      toolCalls: [{ id: "done", type: "function", function: { name: "task_done", arguments: "{}" } }],
    }),
    dispose,
    modelIdentity: () => ({ provider: "test", model: "model" }),
  };
}

test("review and scan factories dispose exactly once on success", async () => {
  const dir = repo();
  try {
    for (const operation of ["review", "scan"] as const) {
      let disposed = 0;
      const factory = operation === "review"
        ? createReviewRunnerFactory({ ...defaultReviewOptions(), repoDir: dir, concurrency: 1 }, dir, { createTransport: async () => scripted(async () => { disposed += 1; }) })
        : createScanRunnerFactory({ ...defaultScanOptions(), repoDir: dir, concurrency: 1 }, dir, undefined, { createTransport: async () => scripted(async () => { disposed += 1; }) });
      const runner = await factory();
      await runner.run();
      expect(disposed).toBe(1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review factory retains run and dispose failures", async () => {
  const dir = repo();
  try {
    let disposed = 0;
    const runner = await createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: dir, concurrency: 1 },
      dir,
      { createTransport: async () => ({
        ...scripted(async () => { disposed += 1; throw new Error("dispose failure"); }),
        CompletionsWithCtx: async () => { throw new Error("run failure"); },
      }) },
    )();
    let thrown: unknown;
    try { await runner.run(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((item) => (item as Error).message)).toEqual([
      "all 1 file review(s) failed — check your LLM configuration and API key",
      "dispose failure",
    ]);
    expect(disposed).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent review files use isolated Pi transports", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-owned-concurrent-"));
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]] as const) {
      if (spawnSync("git", args, { cwd: dir }).status !== 0) throw new Error(`git ${args.join(" ")} failed`);
    }
    fs.writeFileSync(path.join(dir, "a.go"), "package main\n");
    fs.writeFileSync(path.join(dir, "b.go"), "package main\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.go"), "package main\n// a\n");
    fs.writeFileSync(path.join(dir, "b.go"), "package main\n// b\n");

    let created = 0;
    const disposed: number[] = [];
    const filesByTransport = new Map<number, Set<string>>();
    const runner = await createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: dir, concurrency: 2, noFilter: true },
      dir,
      {
        createTransport: async () => {
          const id = created++;
          const files = new Set<string>();
          filesByTransport.set(id, files);
          return {
            CompletionsWithCtx: async (_signal, request) => {
              const file = request.requestMeta?.filePath;
              if (file === undefined) throw new Error("missing request file affinity");
              files.add(file);
              await Bun.sleep(20);
              return {
                content: "",
                toolCalls: [{ id: `done-${id}`, type: "function", function: { name: "task_done", arguments: "{}" } }],
              };
            },
            dispose: async () => { disposed.push(id); },
            modelIdentity: () => ({ provider: "test", model: "model" }),
          };
        },
      },
    )();

    expect(await runner.run()).toEqual([]);
    expect(runner.filesReviewed).toBe(2);
    expect(created).toBe(2);
    expect([...filesByTransport.values()].every((files) => files.size === 1)).toBe(true);
    expect([...filesByTransport.values()].flatMap((files) => [...files]).sort()).toEqual(["a.go", "b.go"]);
    expect(disposed.sort((a, b) => a - b)).toEqual([0, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent scan files use isolated Pi transports", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-owned-scan-concurrent-"));
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]] as const) {
      if (spawnSync("git", args, { cwd: dir }).status !== 0) throw new Error(`git ${args.join(" ")} failed`);
    }
    fs.writeFileSync(path.join(dir, "a.go"), "package main\n");
    fs.writeFileSync(path.join(dir, "b.go"), "package main\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });

    let created = 0;
    const disposed: number[] = [];
    const sessionsByTransport = new Map<number, Set<string>>();
    const runner = await createScanRunnerFactory(
      {
        ...defaultScanOptions(),
        repoDir: dir,
        concurrency: 2,
        noPlan: true,
        noDedup: true,
        noSummary: true,
      },
      dir,
      undefined,
      {
        createTransport: async () => {
          const id = created++;
          const sessions = new Set<string>();
          sessionsByTransport.set(id, sessions);
          return {
            CompletionsWithCtx: async (_signal, request) => {
              if (request.sessionId === undefined) throw new Error("missing request session affinity");
              sessions.add(request.sessionId);
              await Bun.sleep(20);
              return {
                content: "",
                toolCalls: [{ id: `done-${id}`, type: "function", function: { name: "task_done", arguments: "{}" } }],
              };
            },
            dispose: async () => { disposed.push(id); },
            modelIdentity: () => ({ provider: "test", model: "model" }),
          };
        },
      },
    )();

    expect(await runner.run()).toEqual([]);
    expect(runner.filesReviewed).toBe(2);
    expect(created).toBe(2);
    expect([...sessionsByTransport.values()].every((sessions) => sessions.size === 1)).toBe(true);
    expect(disposed.sort((a, b) => a - b)).toEqual([0, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid model creates no factory transport", async () => {
  const dir = repo();
  try {
    let created = 0;
    await expect(createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: dir, model: "missing/model" },
      dir,
      { createTransport: async () => { created += 1; return scripted(async () => {}); } },
    )()).rejects.toThrow("unknown model");
    expect(created).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
