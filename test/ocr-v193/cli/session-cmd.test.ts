// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/session_cmd_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { JsonlWriter, SessionFilePath } from "../../../src/ocr-v193/session/persist.js";
import {
  truncate,
  displayMode,
  describeFiles,
  describeStatus,
  printSessionDetail,
  runSessionListCompat,
  runSessionShowCompat,
  runSessionCommentsCompat,
  runSession,
} from "../../../src/ocr-v193/cli/session.js";
import type { Summary } from "../../../src/ocr-v193/session/resume.js";
import type { RunManifest } from "../../../src/ocr-v193/session/manifest.js";

function attachTestWriter(sh: SessionHistory): void {
  if (sh.HasPersistence()) return;
  const w = new JsonlWriter(sh.sessionId, sh.repoDir, sh.gitBranch, sh.model, {
    reviewMode: sh.reviewMode,
    diffFrom: sh.diffFrom,
    diffTo: sh.diffTo,
    diffCommit: sh.diffCommit,
    scanPaths: sh.scanPaths,
    resumedFrom: sh.resumedFrom,
  });
  w.open();
  w.WriteSessionStart(sh.startTime);
  const handle = {
    writeReviewItemDone: (...a: Parameters<JsonlWriter["WriteReviewItemDone"]>) => { w.WriteReviewItemDone(...a); },
    writeReviewItemReused: (...a: Parameters<JsonlWriter["WriteReviewItemReused"]>) => { w.WriteReviewItemReused(...a); },
    writeReviewItemFailed: (...a: Parameters<JsonlWriter["WriteReviewItemFailed"]>) => { w.WriteReviewItemFailed(...a); },
    writeResumeLineage: (l: import("../../../src/ocr-v193/session/resume.ts").ResumeLineage) => { w.WriteResumeLineage(l); },
    writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
    writeLLMRequest: (...a: Parameters<JsonlWriter["WriteLLMRequest"]>) => { (w as unknown as { WriteLLMRequest: (...a: unknown[]) => void }).WriteLLMRequest(...(a as unknown[])); },
    writeLLMResponse: (...a: Parameters<JsonlWriter["WriteLLMResponse"]>) => { (w as unknown as { WriteLLMResponse: (...a: unknown[]) => void }).WriteLLMResponse(...(a as unknown[])); },
    writeLLMError: (...a: Parameters<JsonlWriter["WriteLLMError"]>) => { (w as unknown as { WriteLLMError: (...a: unknown[]) => void }).WriteLLMError(...(a as unknown[])); },
    writeToolCall: (...a: Parameters<JsonlWriter["WriteToolCall"]>) => { (w as unknown as { WriteToolCall: (...a: unknown[]) => void }).WriteToolCall(...(a as unknown[])); },
  } as unknown as import("../../../src/ocr-v193/session/history.ts").PersistHandle;
  (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
}

function captureStdout(fn: () => void): string {
  let out = "";
  const orig = process.stdout.write;
  const captureWrite = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  Object.defineProperty(process.stdout, "write", { configurable: true, value: captureWrite });
  try {
    fn();
  } finally {
    Object.defineProperty(process.stdout, "write", { configurable: true, value: orig });
  }
  return out;
}

function withTempHome<T>(fn: () => T): T {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
  const orig = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.HOME;
    else process.env.HOME = orig;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
}

// OCR v1.9.3: TestRunSessionList_TextIncludesSessionID
test("runSessionList text includes session ID", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [{ path: "a.go", content: "note" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment]);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionListCompat(["--repo", repoDir]);
      });

      expect(got).toContain(sh.sessionId);
      expect(got).toContain("abc123");
      expect(got).toContain("SESSION ID");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionList_JSON
test("runSessionList JSON", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", []);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionListCompat(["--repo", repoDir, "--json"]);
      });

      const decoded = JSON.parse(got) as Summary[];
      expect(decoded.length).toBe(1);
      const first = decoded[0] as unknown as Record<string, unknown>;
      const sid = (first["sessionId"] as string) ?? (first["SessionID"] as string) ?? (first["session_id"] as string);
      expect(sid).toBe(sh.sessionId);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionList_EmptyRepo
test("runSessionList empty repo", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const got = captureStdout(() => {
        runSessionListCompat(["--repo", repoDir]);
      });
      expect(got).toContain("No sessions found");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionShow_Text
test("runSessionShow text", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [{ path: "a.go", content: "note" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment]);
      sh.RecordReviewItemFailed("bad.go", "bad.go", "bad.go", "fp-bad", "boom");
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionShowCompat(["--repo", repoDir, sh.sessionId]);
      });

      for (const want of [sh.sessionId, "abc123", "a.go", "bad.go", "boom", "Files:"]) {
        expect(got).toContain(want);
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionShow_JSON
test("runSessionShow JSON", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", []);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionShowCompat(["--repo", repoDir, "--json", sh.sessionId]);
      });

      const payload = JSON.parse(got) as { summary: Summary; items: Array<{ filePath: string }> };
      const sid = (payload.summary as unknown as Record<string, unknown>)["sessionId"] as string
        ?? (payload.summary as unknown as Record<string, unknown>)["SessionID"] as string;
      expect(sid).toBe(sh.sessionId);
      expect(payload.items.length).toBe(1);
      expect(payload.items[0]!.filePath).toBe("a.go");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionComments_TextRendersLikeReview
test("runSessionComments text renders like review", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [
        { path: "a.go", content: "possible nil deref", startLine: 3, endLine: 5, severity: "high", category: "bug" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment,
      ]);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionCommentsCompat(["--repo", repoDir, sh.sessionId]);
      });

      for (const want of ["a.go:3-5", "[bug · high]", "possible nil deref"]) {
        expect(got).toContain(want);
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionComments_SeverityFilter
test("runSessionComments severity filter", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [
        { path: "a.go", content: "keep me", severity: "high" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment,
        { path: "a.go", content: "drop me", severity: "low" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment,
      ]);
      sh.Finalize();

      let got = captureStdout(() => {
        runSessionCommentsCompat(["--repo", repoDir, "--severity", "HIGH", sh.sessionId]);
      });
      expect(got).toContain("keep me");
      expect(got).not.toContain("drop me");

      got = captureStdout(() => {
        runSessionCommentsCompat(["--repo", repoDir, "--severity", "critical", sh.sessionId]);
      });
      expect(got).toContain("No comments match the given filters");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionComments_JSON
test("runSessionComments JSON", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [
        { path: "a.go", content: "note", severity: "medium", category: "style" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment,
      ]);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionCommentsCompat(["--repo", repoDir, "--json", sh.sessionId]);
      });

      const decoded = JSON.parse(got) as Array<{ content: string; severity: string }>;
      expect(decoded.length).toBe(1);
      expect(decoded[0]!.content).toBe("note");
      expect(decoded[0]!.severity).toBe("medium");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionComments_JSONEmptyIsArray
test("runSessionComments JSON empty is array", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", []);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionCommentsCompat(["--repo", repoDir, "--json", sh.sessionId]);
      });
      expect(got.trim()).toBe("[]");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionComments_NoCommentsMessage
test("runSessionComments no comments message", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", []);
      sh.Finalize();

      const got = captureStdout(() => {
        runSessionCommentsCompat(["--repo", repoDir, sh.sessionId]);
      });
      expect(got).toContain("No comments recorded in session");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// OCR v1.9.3: TestRunSessionShow_MissingID
test("runSessionShow missing ID", () => {
  withTempHome(() => {
    expect(() => {
      runSessionShowCompat([]);
    }).toThrow();
  });
});

// OCR v1.9.3: TestTruncateUnicode
test("truncate unicode", () => {
  const got = truncate("错误原因：超过限制", 6);
  expect(got.endsWith("…")).toBe(true);
  expect(got).toContain("错误");
});

// OCR v1.9.3: TestTruncate
test("truncate branches", () => {
  const cases: Array<{ name: string; s: string; n: number; want: string }> = [
    { name: "shorter than limit is unchanged", s: "abc", n: 10, want: "abc" },
    { name: "newlines and tabs become spaces", s: "a\nb\tc", n: 10, want: "a b c" },
    { name: "n of one collapses to ellipsis", s: "abcdef", n: 1, want: "…" },
    { name: "n of zero collapses to ellipsis", s: "abcdef", n: 0, want: "…" },
    { name: "exact length is unchanged", s: "abcd", n: 4, want: "abcd" },
  ];
  for (const tc of cases) {
    const got = truncate(tc.s, tc.n);
    expect(got, tc.name).toBe(tc.want);
  }
});

// OCR v1.9.3: TestRunSession_UnknownSubcommand
test("runSession unknown subcommand", () => {
  expect(() => {
    runSession(["bogus"]);
  }).toThrow();
});

// OCR v1.9.3: TestSessionDisplayUsesManifestStatusAndCoverage
test("session display uses manifest status and coverage", () => {
  const summary = {
    sessionId: "run-1",
    selectedFiles: 4,
    completedFiles: 1,
    reusedFiles: 1,
    failedFiles: 1,
    waivedFiles: 1,
    runManifest: {
      terminalState: "partial",
      schemaVersion: "ocr.run-manifest/v1",
      runId: "run-1",
      operation: "review",
      repository: {},
      input: { mode: "workspace" },
      execution: {},
      coverage: {
        selected: [{ itemId: "1", path: "a" }, { itemId: "2", path: "b" }, { itemId: "3", path: "c" }, { itemId: "4", path: "d" }],
        completed: [{ itemId: "1", path: "a" }],
        reused: [{ itemId: "2", path: "b" }],
        failed: [{ itemId: "3", path: "c", classification: "provider" }],
        waived: [{ itemId: "4", path: "d", reason: "x" }],
      },
      elapsedMs: 0,
    } as unknown as RunManifest,
  } as unknown as Summary;

  expect(describeStatus(summary as unknown as Record<string, unknown> & Summary)).toBe("partial");
  const files = describeFiles(summary as unknown as Record<string, unknown> & Summary);
  expect(files).toContain("4");
  expect(files).toContain("failed 1");
  expect(files).toContain("waived 1");

  let out = "";
  const w = { write: (s: string) => { out += s; } };
  printSessionDetail(summary, [], w);
  expect(out).toContain("4 selected = 1 completed + 1 reused + 1 failed + 1 waived");
});

// OCR v1.9.3: TestSessionDisplayUsesUnknownForInvalidManifestStatus
test("session display uses unknown for invalid manifest status", () => {
  for (const state of ["", "bogus"] as const) {
    const summary = {
      runManifest: { terminalState: state } as unknown as RunManifest,
    } as unknown as Summary;
    const got = describeStatus(summary as unknown as Record<string, unknown> & Summary);
    expect(got).toBe("unknown");
  }
});

// OCR v1.9.3: TestSessionDisplayDoesNotInferLegacyComplete
test("session display does not infer legacy complete", () => {
  const summary1 = { completedFiles: 2, legacy: true, failedFiles: 0, reusedFiles: 0 } as unknown as Summary;
  expect(describeStatus(summary1 as unknown as Record<string, unknown> & Summary)).toBe("legacy");
  const summary2 = { completedFiles: 2, legacy: true, aborted: true } as unknown as Summary;
  expect(describeStatus(summary2 as unknown as Record<string, unknown> & Summary)).toBe("aborted");
});
