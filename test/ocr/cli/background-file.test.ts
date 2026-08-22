// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/background_file_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

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
  getCommitMessage,
  loadBackgroundFile,
  mergeBackground,
  processBackgroundContent,
  resolveBackgroundFilePath,
  sanitizeMarkdown,
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

// OCR v1.9.3: TestResolveBackgroundFilePath
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

// OCR v1.9.3: TestMergeBackgroundSanitizesInline
test("mergeBackground sanitizes inline", () => {
  // inline only
  const gotInline = mergeBackground("  \x00Inline\u200B context  ", "");
  expect(gotInline).toBe("Inline context");

  // inline combined with file
  const wrapped = BACKGROUND_OPEN_TAG + "\nfrom file\n" + BACKGROUND_CLOSE_TAG;
  const gotCombined = mergeBackground("\x07dirty\uFEFF inline\n\n\n\nend", wrapped);
  expect(gotCombined.includes("\x07")).toBe(false);
  expect(gotCombined.includes("\uFEFF")).toBe(false);
  expect(gotCombined.includes("\n\n\n")).toBe(false);
  expect(gotCombined.includes(wrapped)).toBe(true);
});

// OCR v1.9.3: TestMergeBackground
test("mergeBackground combines file and inline", () => {
  const wrapped = BACKGROUND_OPEN_TAG + "\nfrom file\n" + BACKGROUND_CLOSE_TAG;

  // both present are combined
  const gotBoth = mergeBackground("inline context", wrapped);
  const wantBoth = "inline context\n\n" + wrapped;
  expect(gotBoth).toBe(wantBoth);
  expect(gotBoth.includes("inline context")).toBe(true);
  expect(gotBoth.includes("from file")).toBe(true);

  // inline only
  expect(mergeBackground("inline only", "")).toBe("inline only");

  // file only
  expect(mergeBackground("", wrapped)).toBe(wrapped);
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
    // preview path will be taken, but background should already be merged via injected reader
    // For preview, runCli still merges background before calling previewFactory; we verify via captured? Instead check via direct run without preview using runner
    // Do a second run without preview to capture background via runnerFactory
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

// OCR v1.9.3: TestBackgroundFromCommitThenFile
test("background from commit then file", () => {
  const commitMsg = "Implement rate limiting on login";
  const { repo, hash } = initRepoWithCommit(commitMsg);
  try {
    let background = "";
    const msg = getCommitMessage(repo, hash);
    expect(msg).toBe(commitMsg);
    if (background === "") background = msg;

    const p = writeTempFile("Extra context from a file.");
    let fileBg: string;
    try {
      fileBg = loadBackgroundFile(p);
    } finally {
      cleanupTempFile(p);
    }
    background = mergeBackground(background, fileBg);

    expect(background.startsWith(commitMsg + "\n\n")).toBe(true);
    expect(background.includes("Extra context from a file.")).toBe(true);
    expect(background.includes(BACKGROUND_OPEN_TAG)).toBe(true);
    expect(background.includes(BACKGROUND_CLOSE_TAG)).toBe(true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
