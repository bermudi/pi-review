// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/background_file_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27; selected cases updated at
// OCR v1.9.9 commit 4b6874bd23106b5c68bea6d230bb60303b9f0961.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BACKGROUND_CLOSE_TAG,
  BACKGROUND_HARD_LIMIT,
  BACKGROUND_OPEN_TAG,
  BACKGROUND_SOFT_LIMIT,
  MAX_BACKGROUND_FILE_BYTES,
  loadBackgroundFile,
  processBackgroundContent,
  resolveBackground,
  resolveBackgroundFilePath,
  sanitizeMarkdown,
  selectBackground,
} from "../../../src/ocr/cli/background.js";
import { runCli } from "../../../src/ocr/cli/index.js";

function writeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-bg-"));
  const p = path.join(dir, "background.md");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function cleanupTempFile(p: string): void {
  try {
    const dir = path.dirname(p);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function initRepoWithCommit(message: string): { repo: string; hash: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-commit-repo-"));
  const run = (args: string[]): string => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    return (res.stdout as string) ?? "";
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-q", "-m", message]);
  const hash = run(["rev-parse", "HEAD"]).trim();
  return { repo, hash };
}

// OCR v1.9.3: TestLoadBackgroundFileNotFound
test("loadBackgroundFile not found", () => {
  const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  expect(() => loadBackgroundFile(missing)).toThrow();
});

// OCR v1.9.9: TestResolveBackgroundFilePath
test("resolveBackgroundFilePath handles repo-relative, absolute, empty and fallback", () => {
  const repo = path.join("/path", "to", "repo");

  // relative anchored at repo
  const gotRel = resolveBackgroundFilePath(repo, path.join(".", "docs", "context.md"));
  const wantRel = path.join(repo, "docs", "context.md");
  expect(gotRel).toBe(wantRel);

  // absolute unchanged
  const abs = path.join("/etc", "context.md");
  expect(resolveBackgroundFilePath(repo, abs)).toBe(abs);

  // empty unchanged
  expect(resolveBackgroundFilePath(repo, "")).toBe("");

  // empty repoDir falls back to the relative path
  const rel = path.join(".", "docs", "context.md");
  const gotFallback = resolveBackgroundFilePath("", rel);
  const wantFallback = path.join("docs", "context.md");
  expect(gotFallback).toBe(wantFallback);
});

// OCR v1.9.3: TestLoadBackgroundFileRelativeToRepo
test("loadBackgroundFile relative to repo", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
  try {
    const docs = path.join(repo, "docs");
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, "context.md"), "Repo-relative context.", "utf8");
    const resolved = resolveBackgroundFilePath(repo, path.join(".", "docs", "context.md"));
    const got = loadBackgroundFile(resolved);
    expect(got).toContain("Repo-relative context.");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestLoadBackgroundFileEmpty
test("loadBackgroundFile empty cases", () => {
  const cases: Record<string, string> = {
    "zero bytes": "",
    "whitespace only": "   \n\t \n  ",
    "invisible only": "\u200B\u200E\u00AD\uFEFF",
  };
  for (const [name, content] of Object.entries(cases)) {
    const p = writeTempFile(content);
    try {
      let threw = false;
      try {
        loadBackgroundFile(p);
      } catch (e) {
        threw = true;
        expect(String((e as Error).message).toLowerCase()).toContain("empty");
      }
      expect(threw, `expected error for ${name}`).toBe(true);
    } finally {
      cleanupTempFile(p);
    }
  }
});

// OCR v1.9.3: TestLoadBackgroundFileControlCharRemoval
test("loadBackgroundFile control char removal", () => {
  const content = "Hello\x00\x07world\x7f\u0085!\u200B\uFEFF\u200E";
  const p = writeTempFile(content);
  try {
    const got = loadBackgroundFile(p);
    for (const bad of ["\x00", "\x07", "\x7f", "\u0085", "\u200B", "\uFEFF", "\u200E"]) {
      expect(got.includes(bad), `still contains ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(got).toContain("Helloworld!");
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.3: TestSanitizeMarkdownPreservesNewlinesAndTabs
test("sanitizeMarkdown preserves newlines and tabs", () => {
  const got = sanitizeMarkdown("line1\n\tindented\nline3");
  const want = "line1\n\tindented\nline3";
  expect(got).toBe(want);
});

// OCR v1.9.3: TestSanitizeMarkdownCollapsesNewlines
test("sanitizeMarkdown collapses newlines", () => {
  const got = sanitizeMarkdown("a\n\n\n\n\nb");
  const want = "a\n\nb";
  expect(got).toBe(want);
});

// OCR v1.9.3: TestSanitizeMarkdownNormalizesCRLF
test("sanitizeMarkdown normalizes CRLF", () => {
  const got = sanitizeMarkdown("a\r\nb\r\nc");
  const want = "a\nb\nc";
  expect(got).toBe(want);
});

// OCR v1.9.3: TestSanitizeMarkdownTrims
test("sanitizeMarkdown trims", () => {
  const got = sanitizeMarkdown("   \n  hello  \n   ");
  expect(got).toBe("hello");
});

// OCR v1.9.3: TestLoadBackgroundFileDelimiters
test("loadBackgroundFile delimiters wrapping", () => {
  const p = writeTempFile("Some requirement context.");
  try {
    const got = loadBackgroundFile(p);
    expect(got.startsWith(BACKGROUND_OPEN_TAG + "\n")).toBe(true);
    expect(got.endsWith("\n" + BACKGROUND_CLOSE_TAG)).toBe(true);
    const want = BACKGROUND_OPEN_TAG + "\nSome requirement context.\n" + BACKGROUND_CLOSE_TAG;
    expect(got).toBe(want);
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.3: TestLoadBackgroundFileRejectsReservedDelimiters
test("loadBackgroundFile rejects reserved delimiters", () => {
  for (const tag of [BACKGROUND_OPEN_TAG, BACKGROUND_CLOSE_TAG]) {
    const content = "Some context " + tag + " and more text.";
    const p = writeTempFile(content);
    try {
      expect(() => loadBackgroundFile(p)).toThrow(/reserved delimiters/i);
      try {
        loadBackgroundFile(p);
      } catch (e) {
        expect(String((e as Error).message).toLowerCase()).toContain("reserved delimiters");
      }
    } finally {
      cleanupTempFile(p);
    }
  }
});

// OCR v1.9.9: TestSelectBackground
test("selectBackground makes a supplied file authoritative", () => {
  const wrapped = BACKGROUND_OPEN_TAG + "\nfrom file\n" + BACKGROUND_CLOSE_TAG;
  let stderr = "";
  expect(selectBackground("inline context", wrapped, { stderr: (message) => { stderr += message; } })).toBe(wrapped);
  expect(stderr).toBe(
    "[pi-review] both --background and --background-file were provided; " +
    "--background-file takes precedence and --background is ignored\n",
  );
  expect(selectBackground("inline only", "")).toBe("inline only");
  expect(selectBackground("", wrapped)).toBe(wrapped);
  expect(selectBackground("", "")).toBe("");
});

// OCR v1.9.3: TestLoadBackgroundFileSoftLimit
test("loadBackgroundFile soft limit continues", () => {
  const content = "a".repeat(BACKGROUND_SOFT_LIMIT + 100);
  const p = writeTempFile(content);
  let stderr = "";
  try {
    const got = loadBackgroundFile(p, { stderr: (m) => { stderr += m; } });
    expect(got.includes(content)).toBe(true);
    expect(stderr.toLowerCase()).toContain("exceeding the recommended");
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.3: TestLoadBackgroundFileOversized
test("loadBackgroundFile oversized", () => {
  const content = "a".repeat(MAX_BACKGROUND_FILE_BYTES + 1);
  const p = writeTempFile(content);
  try {
    expect(() => loadBackgroundFile(p)).toThrow(/maximum/i);
    try {
      loadBackgroundFile(p);
    } catch (e) {
      expect(String((e as Error).message).toLowerCase()).toContain("maximum");
    }
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.3: TestLoadBackgroundFileDirectory
test("loadBackgroundFile directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-bg-dir-"));
  try {
    expect(() => loadBackgroundFile(dir)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestLoadBackgroundFileHardLimit
test("loadBackgroundFile hard limit", () => {
  const content = "a".repeat(BACKGROUND_HARD_LIMIT + 1);
  const p = writeTempFile(content);
  try {
    expect(() => loadBackgroundFile(p)).toThrow(/hard limit/i);
    try {
      loadBackgroundFile(p);
    } catch (e) {
      expect(String((e as Error).message).toLowerCase()).toContain("hard limit");
    }
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.3: TestLoadBackgroundFileHardLimitExcludesWrapper
test("loadBackgroundFile hard limit excludes wrapper", () => {
  const content = "a".repeat(BACKGROUND_HARD_LIMIT);
  const p = writeTempFile(content);
  try {
    const got = loadBackgroundFile(p);
    expect(got).toBeTruthy();
    expect(got.length).toBeGreaterThan(BACKGROUND_HARD_LIMIT);
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.3: TestLoadBackgroundFileMultiByteRuneCount
test("loadBackgroundFile multi-byte rune count", () => {
  const content = "\u00E9".repeat(BACKGROUND_HARD_LIMIT);
  const p = writeTempFile(content);
  try {
    const got = loadBackgroundFile(p);
    expect(got.includes(content)).toBe(true);
  } finally {
    cleanupTempFile(p);
  }
});

// Regression: soft-limit warning must use [pi-review] branding, not [ocr]
test("soft-limit warning uses pi-review branding", () => {
  const content = "a".repeat(BACKGROUND_SOFT_LIMIT + 5);
  let stderr = "";
  const got = processBackgroundContent(content, "/tmp/fake.md", { stderr: (m) => { stderr += m; } });
  expect(got.includes(content)).toBe(true);
  expect(stderr).toContain("[pi-review] --background-file");
  expect(stderr).not.toContain("[ocr] --background-file");
  // exact prefix check
  expect(stderr.startsWith("[pi-review] --background-file content is")).toBe(true);

  // also verify filesystem path emits same branding
  const p = writeTempFile(content);
  try {
    let fsStderr = "";
    const got2 = loadBackgroundFile(p, { stderr: (m) => { fsStderr += m; } });
    expect(got2.includes(content)).toBe(true);
    expect(fsStderr).toContain("[pi-review] --background-file");
    expect(fsStderr).not.toContain("[ocr] --background-file");
  } finally {
    cleanupTempFile(p);
  }
});

// Regression: injected reader is authoritative over filesystem when supplied
test("injected readFile boundary is authoritative", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-reader-auth-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
    const docs = path.join(repo, "docs");
    fs.mkdirSync(docs, { recursive: true });
    const hostPath = path.join(docs, "context.md");
    fs.writeFileSync(hostPath, "host content should be ignored", "utf8");
    // ensure git top-level is repo
    let capturedBackground: string | undefined;
    const io = {
      stdout: () => {},
      stderr: () => {},
      cwd: () => repo,
      env: () => ({}),
      onSignal: () => {},
      offSignal: () => {},
    };
    const fakeReader = async (p: string, _enc: "utf8") => {
      // only serve the resolved background path
      if (p.endsWith(path.join("docs", "context.md"))) return "injected content authoritative";
      throw new Error(`unexpected read ${p}`);
    };
    const runnerFactory = async (opts: { background: string }) => {
      capturedBackground = opts.background;
      return {
        run: async () => [],
        manifest: { terminalState: "complete", coverage: { selected: [], completed: [], failed: [], reused: [], waived: [] } } as unknown as never,
        warnings: [],
        filesReviewed: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: {},
        sessionId: "test",
        budgetExceeded: false,
        projectSummary: "",
        resumeInfo: undefined,
        diffs: [],
      } as unknown as never;
    };
    const code = await runCli(["review", "--repo", repo, "--background-file", "./docs/context.md", "--preview"], {
      io,
      readFile: fakeReader as unknown as never,
      reviewPreviewFactory: async () => ({ entries: [], totalInsertions: 0, totalDeletions: 0, totalFiles: 0, reviewableCount: 0, excludedCount: 0 } as never),
      reviewRunnerFactory: runnerFactory as unknown as never,
    });
    // Resolve once before either preview or runner creation; run a normal review
    // to observe the value passed through the production runner boundary.
    capturedBackground = undefined;
    const code2 = await runCli(["review", "--repo", repo, "--background-file", "./docs/context.md"], {
      io,
      readFile: fakeReader as unknown as never,
      reviewRunnerFactory: runnerFactory as unknown as never,
    });
    expect(capturedBackground).toBeDefined();
    expect(capturedBackground!).toContain("injected content authoritative");
    expect(capturedBackground!).not.toContain("host content should be ignored");
    expect(capturedBackground!).toContain(BACKGROUND_OPEN_TAG);
    // ensure we did not accidentally read host file via filesystem (would contain host content)
    void code;
    void code2;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.9: TestResolveBackground_FilePrecedenceOverCommit
test("resolveBackground does not query commit text when a file is supplied", async () => {
  const p = writeTempFile("Extra context from a file.");
  try {
    let commitLookups = 0;
    const background = await resolveBackground("/unused", "", p, "HEAD", {
      getCommitMessage: () => {
        commitLookups++;
        return "commit message must not be read";
      },
    });
    expect(commitLookups).toBe(0);
    expect(background).toContain("Extra context from a file.");
    expect(background).not.toContain("commit message must not be read");
  } finally {
    cleanupTempFile(p);
  }
});

// OCR v1.9.9: TestResolveBackground_AllCases
test("resolveBackground applies file, inline, and commit fallback precedence", async () => {
  const p = writeTempFile("File-based context.");
  try {
    let commitLookups = 0;
    const getCommit = (): string => {
      commitLookups++;
      return "Add rate limiting";
    };

    let stderr = "";
    const fileWins = await resolveBackground("/unused", "inline", p, "HEAD", {
      getCommitMessage: getCommit,
      stderr: (message) => { stderr += message; },
    });
    expect(fileWins).toContain("File-based context.");
    expect(fileWins).not.toContain("inline");
    expect(commitLookups).toBe(0);
    expect(stderr).toContain("[pi-review] both --background");

    expect(await resolveBackground("/unused", "", "", "HEAD", { getCommitMessage: getCommit })).toBe("Add rate limiting");
    expect(commitLookups).toBe(1);
    expect(await resolveBackground("/unused", "just inline", "", "HEAD", { getCommitMessage: getCommit })).toBe("just inline");
    expect(commitLookups).toBe(1);
    expect(await resolveBackground("/unused", "", p, "", { getCommitMessage: getCommit })).toContain("File-based context.");
    expect(await resolveBackground("/unused", "", "", "", { getCommitMessage: getCommit })).toBe("");
    expect(await resolveBackground("/unused", "", "", "HEAD", {
      getCommitMessage: () => { throw new Error("git unavailable"); },
    })).toBe("");
  } finally {
    cleanupTempFile(p);
  }
});

test("CLI resolves file background once, skips commit lookup, and passes only file content", async () => {
  const { repo, hash } = initRepoWithCommit("Commit text that must not appear");
  try {
    fs.writeFileSync(path.join(repo, "context.md"), "File context wins", "utf8");
    let capturedBackground = "";
    let commitLookups = 0;
    let stderr = "";
    const code = await runCli(
      ["review", "--repo", repo, "--commit", hash, "--background", "inline loses", "--background-file", "context.md"],
      {
        io: {
          stdout: () => {},
          stderr: (message) => { stderr += message; },
          cwd: () => repo,
        },
        getCommitMessage: () => {
          commitLookups++;
          return "Commit text that must not appear";
        },
        reviewRunnerFactory: async (opts) => {
          capturedBackground = opts.background;
          return {
            run: async () => [],
            manifest: { terminalState: "complete", coverage: { selected: [], completed: [], failed: [], reused: [], waived: [] } } as unknown as never,
            warnings: [],
            filesReviewed: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: {},
            sessionId: "test",
            budgetExceeded: false,
            projectSummary: "",
            resumeInfo: undefined,
            diffs: [],
          } as unknown as never;
        },
      },
    );
    expect(code).toBe(0);
    expect(commitLookups).toBe(0);
    expect(capturedBackground).toContain("File context wins");
    expect(capturedBackground).not.toContain("inline loses");
    expect(capturedBackground).not.toContain("Commit text that must not appear");
    expect(stderr).toContain("[pi-review] both --background");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
