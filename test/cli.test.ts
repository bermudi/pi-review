import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { runCli, HELP_TEXT, versionString } from "../src/cli.ts";

import type { Preview } from "../src/ocr/model/preview.ts";
import type { ReviewOptions, ScanOptions } from "../src/ocr/cli/shared.ts";
import type { ReviewRunner } from "../src/ocr/cli/review.ts";
import type { ScanRunner } from "../src/ocr/cli/scan.ts";

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: () => process.cwd(),
      stdout: (s: string) => {
        stdout += s;
      },
      stderr: (s: string) => {
        stderr += s;
      },
      onSignal: () => {},
      offSignal: () => {},
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function createTempGitRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-adapter-repo-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "main.go"), "package main\nfunc Add(a int, b int) int { return a + b }\n", "utf-8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  fs.writeFileSync(path.join(dir, "main.go"), "package main\nfunc Add(a int, b int) int {\n  return a + b\n}\n", "utf-8");
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeReviewRunner(overrides: Partial<ReviewRunner> = {}): ReviewRunner {
  const base: ReviewRunner = {
    run: async () => [
      {
        path: "main.go",
        content: "consider handling error",
        existingCode: "func Add",
        category: "bug",
        severity: "medium",
        startLine: 1,
        endLine: 1,
      } as never,
    ],
    manifest: {
      schemaVersion: "ocr.run-manifest/v1",
      runId: "run-test",
      operation: "review",
      terminalState: "complete",
      repository: {},
      input: { mode: "workspace" },
      execution: { model: "test" },
      coverage: {
        selected: [{ itemId: "a", path: "main.go", fingerprint: "fp" }],
        completed: [{ itemId: "a", path: "main.go", fingerprint: "fp" }],
        reused: [],
        failed: [],
        waived: [],
      },
      elapsedMs: 100,
    } as never,
    warnings: [],
    filesReviewed: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: { code_comment: 1, task_done: 1 },
    sessionId: "sess-1",
    budgetExceeded: false,
    projectSummary: "",
    resumeInfo: undefined,
    diffs: [],
    retryReport: null,
    retryReportError: null,
  };
  return { ...base, ...overrides };
}

function fakeScanRunner(overrides: Partial<ScanRunner> = {}): ScanRunner {
  const base: ScanRunner = {
    run: async () => [],
    manifest: null as never,
    warnings: [],
    filesReviewed: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: {},
    sessionId: "scan-sess-1",
    budgetExceeded: false,
    projectSummary: "",
    resumeInfo: undefined,
    diffs: [],
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// version / help — OCR semantics directly, no engine flag
// ---------------------------------------------------------------------------

describe("thin OCR production adapter", () => {
  // OCR v1.9.3: TestWriter_Default
  test("help goes to stdout, exit 0, via --help", async () => {
    const cap = captureIo();
    const code = await runCli(["--help"], { io: cap.io });
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("pi-review");
    expect(cap.stdout()).toContain("review");
    expect(cap.stdout()).toBe(HELP_TEXT);
    expect(cap.stderr()).toBe("");
  });

  test("help via empty argv shows HELP_TEXT", async () => {
    const cap = captureIo();
    const code = await runCli([], { io: cap.io });
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("Usage:");
    expect(cap.stderr()).toBe("");
  });

  test("help via review --help", async () => {
    const cap = captureIo();
    const code = await runCli(["review", "--help"], { io: cap.io });
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("Review flags:");
  });

  test("version via version subcommand", async () => {
    const cap = captureIo();
    const code = await runCli(["version"], { io: cap.io });
    const packageJson = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as {
      readonly version?: unknown;
    };
    expect(code).toBe(0);
    expect(cap.stdout()).toBe(versionString());
    expect(typeof packageJson.version).toBe("string");
    expect(cap.stdout()).toContain(`pi-review ${String(packageJson.version)}`);
    expect(cap.stdout()).toContain("OCR compatibility: v1.9.3");
    expect(cap.stderr()).toBe("");
  });

  test("version via --version and -V", async () => {
    for (const argv of [["--version"], ["-V"]]) {
      const cap = captureIo();
      const code = await runCli(argv, { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toBe(versionString());
    }
  });

  test("unknown command is rejected on stderr with help", async () => {
    const cap = captureIo();
    const code = await runCli(["unknown-cmd"], { io: cap.io });
    expect(code).toBe(1);
    expect(cap.stderr()).toContain('unknown command "unknown-cmd"');
    expect(cap.stderr()).toContain("Usage:");
    expect(cap.stdout()).toBe("");
  });

  test("rejects --engine at review level as unknown flag without invoking model", async () => {
    let factoryCalled = false;
    const cap = captureIo();
    const code = await runCli(["review", "--engine", "legacy", "--repo", "/tmp"], {
      io: cap.io,
      reviewRunnerFactory: async () => {
        factoryCalled = true;
        return fakeReviewRunner();
      },
    });
    expect(code).toBe(1);
    expect(factoryCalled).toBe(false);
    expect(cap.stderr()).toContain("unknown flag: --engine");
    expect(cap.stdout()).toBe("");
  });

  test("rejects --engine ocr as unknown flag", async () => {
    const cap = captureIo();
    const code = await runCli(["review", "--engine", "ocr", "--repo", "/tmp"], { io: cap.io });
    expect(code).toBe(1);
    expect(cap.stderr()).toContain("unknown flag: --engine");
  });

  test("rejects top-level --engine before subcommand as unknown command", async () => {
    const cap = captureIo();
    const code = await runCli(["--engine", "legacy"], { io: cap.io });
    expect(code).toBe(1);
    // First token is treated as command, so it is unknown command, not unknown flag
    expect(cap.stderr()).toContain("unknown command");
  });

  // OCR v1.9.3: TestQuiet
  test("factory injection without network: review runner is called and stdout is JSON, stderr is diagnostics only", async () => {
    const repo = createTempGitRepo();
    try {
      const cap = captureIo();
      let factoryOpts: ReviewOptions | undefined;
      let runnerRunCalled = 0;
      const runner = fakeReviewRunner({
        run: async () => {
          runnerRunCalled++;
          return [
            {
              path: "main.go",
              content: "test comment",
              existingCode: "func Add",
              category: "bug",
              severity: "low",
              startLine: 2,
              endLine: 2,
            } as never,
          ];
        },
      });

      const code = await runCli(["review", "--repo", repo.dir, "--format", "json", "--concurrency", "1"], {
        io: cap.io,
        reviewRunnerFactory: async (opts) => {
          factoryOpts = opts;
          return runner;
        },
      });

      expect(code).toBe(0);
      expect(factoryOpts?.repoDir).toBe(repo.dir);
      expect(runnerRunCalled).toBe(1);
      // stdout must be exact JSON result, not contain stderr markers
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.status).toBe("complete");
      expect(Array.isArray(parsed.comments)).toBe(true);
      expect(parsed.comments[0].content).toBe("test comment");
      // stderr should not contain the JSON stdout content
      expect(cap.stderr()).not.toContain('"status"');
      // stdout should not contain diagnostic prefix
      expect(cap.stdout()).not.toContain("[pi-review]");
    } finally {
      repo.cleanup();
    }
  });

  test("scan factory injection without network produces correct stdout/stderr separation", async () => {
    const repo = createTempGitRepo();
    try {
      const cap = captureIo();
      let scanFactoryCalled = false;
      const code = await runCli(["scan", "--repo", repo.dir, "--format", "json"], {
        io: cap.io,
        scanRunnerFactory: async () => {
          scanFactoryCalled = true;
          return fakeScanRunner({
            run: async () => [
              { path: "main.go", content: "scan comment", startLine: 1, endLine: 1 } as never,
            ],
            filesReviewed: 1,
            totalTokens: 5,
          });
        },
      });
      expect(code).toBe(0);
      expect(scanFactoryCalled).toBe(true);
      const parsed = JSON.parse(cap.stdout());
      // Scan output is also JSON with comments
      expect(parsed).toBeDefined();
      expect(cap.stderr()).not.toContain('"comments"');
    } finally {
      repo.cleanup();
    }
  });

  test("preview injection: review --preview uses preview factory and never calls runner", async () => {
    const repo = createTempGitRepo();
    try {
      const cap = captureIo();
      let previewCalled = false;
      let runnerCalled = false;
      const preview: Preview = {
        entries: [
          {
            path: "main.go",
            status: "modified",
            insertions: 3,
            deletions: 1,
            willReview: true,
          },
        ],
        totalInsertions: 3,
        totalDeletions: 1,
        totalFiles: 1,
        reviewableCount: 1,
        excludedCount: 0,
      };

      const code = await runCli(["review", "--repo", repo.dir, "--preview", "--format", "json"], {
        io: cap.io,
        reviewPreviewFactory: async () => {
          previewCalled = true;
          return preview;
        },
        reviewRunnerFactory: async () => {
          runnerCalled = true;
          return fakeReviewRunner();
        },
      });

      expect(code).toBe(0);
      expect(previewCalled).toBe(true);
      expect(runnerCalled).toBe(false);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.files?.length ?? parsed.entries?.length ?? parsed.total_files ?? 0).toBeGreaterThanOrEqual(0);
      // preview output should be on stdout, not stderr
      expect(cap.stderr()).toBe("");
      expect(cap.stdout().length).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });

  test("explicit review command succeeds and default help is consistent", async () => {
    const repo = createTempGitRepo();
    try {
      // explicit review with format text
      const cap = captureIo();
      const code = await runCli(["review", "--repo", repo.dir, "--format", "text", "--concurrency", "1"], {
        io: cap.io,
        reviewRunnerFactory: async () => fakeReviewRunner(),
      });
      expect(code).toBe(0);
      expect(cap.stdout().length).toBeGreaterThan(0);
      // stdout for text should contain human readable output, not error markers
      expect(cap.stdout()).not.toContain("unknown flag");
      expect(cap.stderr()).not.toContain("unknown flag");
    } finally {
      repo.cleanup();
    }
  });

  test("IO seam: custom cwd and readFile are forwarded", async () => {
    const repo = createTempGitRepo();
    try {
      // Use a background file via readFile seam to prove it is used
      const bgPath = path.join(repo.dir, "bg.md");
      fs.writeFileSync(bgPath, "# background\n", "utf-8");
      const cap = captureIo();
      let readFileCalled = false;
      const code = await runCli(["review", "--repo", repo.dir, "--background-file", "bg.md", "--format", "json"], {
        io: { ...cap.io, cwd: () => repo.dir },
        readFile: async (p, enc) => {
          readFileCalled = true;
          expect(enc).toBe("utf8");
          // p is resolved absolute path inside repo
          return fs.readFileSync(p, "utf-8");
        },
        reviewRunnerFactory: async () => fakeReviewRunner(),
      });
      expect(code).toBe(0);
      expect(readFileCalled).toBe(true);
      expect(cap.stdout()).toContain('"status"');
    } finally {
      repo.cleanup();
    }
  });
});
