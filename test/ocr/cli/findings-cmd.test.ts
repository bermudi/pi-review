// SPDX-License-Identifier: GPL-3.0-or-later
// Independent pi-reviewer tests for the `findings` command — not ported
// from Open Code Review. The command is a pure local read of recorded
// session JSONL, so every test runs without a model, network, or (for the
// repository itself) even Git.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../../../src/ocr/cli/index.js";
import { JsonlWriter } from "../../../src/ocr/session/persist.js";
import type { RunManifest } from "../../../src/ocr/session/manifest.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";
import type { Summary } from "../../../src/ocr/session/resume.js";
import {
  selectFindingsSession,
  findingsStatus,
  findingsRange,
  findingsHeaderText,
  findingsJsonEnvelope,
  findingsMessage,
} from "../../../src/ocr/cli/findings.js";
import type { CliIoOverrides } from "../../../src/ocr/cli/shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-findings-home-"));
  const orig = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (orig === undefined) delete process.env.HOME;
    else process.env.HOME = orig;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function mkRepoDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-findings-repo-"));
}

function captureIo(cwd: string): { io: CliIoOverrides; stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      cwd: () => cwd,
      env: () => ({ TERM: "dumb" }),
      stdout: (t: string) => { out += t; },
      stderr: (t: string) => { err += t; },
      stdoutIsTTY: () => false,
    },
    stdout: () => out,
    stderr: () => err,
  };
}

function comment(path: string, content: string, extra: Partial<LlmComment> = {}): LlmComment {
  return { path, content, startLine: 3, endLine: 5, severity: "high", category: "bug", ...extra };
}

function makeManifest(terminalState: RunManifest["terminalState"], selected: number, completed: number, failed = 0): RunManifest {
  const paths = Array.from({ length: selected }, (_, i) => `file-${i}.ts`);
  const items = paths.map((p) => ({ itemId: `id-${p}`, path: p, fingerprint: `fp-${p}` }));
  return {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-1",
    operation: "review",
    terminalState,
    repository: {},
    input: { mode: "range" },
    execution: {},
    coverage: {
      selected: items,
      completed: items.slice(0, completed),
      reused: [],
      failed: failed > 0 ? items.slice(completed, completed + failed).map((it) => ({ ...it, classification: "provider" })) : [],
      waived: [],
    },
    elapsedMs: 1000,
  };
}

type SessionItem =
  | { type: "done"; path: string; fingerprint: string; comments: LlmComment[] }
  | { type: "reused"; path: string; fingerprint: string; sourceSessionId: string; comments: LlmComment[] }
  | { type: "failed"; path: string; fingerprint: string; error: string };

interface SessionSpec {
  sessionId: string;
  started: Date;
  reviewMode?: string;
  diffFrom?: string;
  diffTo?: string;
  diffCommit?: string;
  scanPaths?: string[];
  model?: string;
  items: SessionItem[];
  manifest?: RunManifest | null;
  /** false leaves the session without a session_end record (aborted). */
  end?: boolean;
}

function writeSession(repoDir: string, spec: SessionSpec): void {
  const w = new JsonlWriter(spec.sessionId, repoDir, "main", spec.model ?? "test-model", {
    reviewMode: spec.reviewMode ?? "",
    diffFrom: spec.diffFrom ?? "",
    diffTo: spec.diffTo ?? "",
    diffCommit: spec.diffCommit ?? "",
    scanPaths: spec.scanPaths,
  });
  w.open();
  w.WriteSessionStart(spec.started);
  for (const item of spec.items) {
    if (item.type === "done") {
      w.WriteReviewItemDone(item.path, item.path, item.path, item.fingerprint, item.comments);
    } else if (item.type === "reused") {
      w.WriteReviewItemReused(item.path, item.path, item.path, item.fingerprint, item.sourceSessionId, item.comments);
    } else {
      w.WriteReviewItemFailed(item.path, item.path, item.path, item.fingerprint, item.error);
    }
  }
  if (spec.end !== false) {
    const err = w.WriteSessionEnd(1500, spec.items.filter((i) => i.type !== "failed").map((i) => i.path), 0, spec.manifest ?? null);
    expect(err).toBeNull();
  } else {
    w.close();
  }
}

function baseSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    sessionId: "s1",
    filePath: "/session/s1.jsonl",
    repoDir: "/repo",
    gitBranch: "main",
    model: "test-model",
    reviewMode: "range",
    diffFrom: "main",
    diffTo: "feature",
    diffCommit: "",
    resumedFrom: "",
    startTime: new Date("2026-01-02T10:00:00Z"),
    endTime: new Date("2026-01-02T10:00:30Z"),
    durationMs: 30000,
    selectedFiles: 2,
    completedFiles: 2,
    failedFiles: 0,
    reusedFiles: 0,
    waivedFiles: 0,
    totalComments: 2,
    llmFailures: 0,
    aborted: false,
    legacy: false,
    runManifest: makeManifest("complete", 2, 2),
    resumeLineage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("selectFindingsSession defaults to the first (newest) summary", () => {
  const a = baseSummary({ sessionId: "a" });
  const b = baseSummary({ sessionId: "b" });
  expect(selectFindingsSession([a, b], "")).toBe(a);
  expect(selectFindingsSession([], "")).toBeNull();
});

test("selectFindingsSession resolves a named session exactly", () => {
  const a = baseSummary({ sessionId: "a" });
  const b = baseSummary({ sessionId: "b" });
  expect(selectFindingsSession([a, b], "b")).toBe(b);
  expect(selectFindingsSession([a, b], "nope")).toBeNull();
});

test("findingsStatus maps aborted, manifest, and legacy sessions", () => {
  expect(findingsStatus(baseSummary({ aborted: true }))).toBe("aborted");
  expect(findingsStatus(baseSummary({ runManifest: makeManifest("partial", 2, 1, 1) }))).toBe("partial");
  expect(findingsStatus(baseSummary({ runManifest: makeManifest("failed", 1, 0, 1) }))).toBe("failed");
  expect(findingsStatus(baseSummary({ runManifest: null, aborted: false }))).toBe("legacy");
});

test("findingsRange derives range, commit, and null for other modes", () => {
  expect(findingsRange(baseSummary({ reviewMode: "range", diffFrom: "main", diffTo: "feature" }))).toBe("main..feature");
  expect(findingsRange(baseSummary({ reviewMode: "commit", diffCommit: "abc123", diffFrom: "", diffTo: "" }))).toBe("abc123");
  expect(findingsRange(baseSummary({ reviewMode: "workspace", diffFrom: "", diffTo: "" }))).toBeNull();
  expect(findingsRange(baseSummary({ reviewMode: "full_scan", diffFrom: "", diffTo: "" }))).toBeNull();
  expect(findingsRange(baseSummary({ reviewMode: "range", diffFrom: "", diffTo: "" }))).toBeNull();
});

test("findingsJsonEnvelope carries session metadata and snake_case comments", () => {
  const summary = baseSummary();
  const comments = [comment("a.ts", "off-by-one")];
  const env = findingsJsonEnvelope(summary, comments);
  expect(env.status).toBe("complete");
  expect(env.session_id).toBe("s1");
  expect(env.review_mode).toBe("range");
  expect(env.range).toBe("main..feature");
  expect(env.started_at).toBe("2026-01-02T10:00:00.000Z");
  expect(env.ended_at).toBe("2026-01-02T10:00:30.000Z");
  expect(env.message).toBe("Review complete: 1 finding(s) across 2 selected item(s).");
  expect(env.comments).toHaveLength(1);
  expect(env.comments[0]).toMatchObject({ path: "a.ts", content: "off-by-one", start_line: 3, end_line: 5, severity: "high", category: "bug" });
});

test("findingsMessage covers manifest, empty, and recorded-without-manifest cases", () => {
  expect(findingsMessage(baseSummary(), 2)).toBe("Review complete: 2 finding(s) across 2 selected item(s).");
  expect(findingsMessage(baseSummary({ runManifest: null, aborted: true }), 0)).toBe("No comments generated. Looks good to me.");
  expect(findingsMessage(baseSummary({ runManifest: null, aborted: true }), 3)).toBe("3 finding(s) recorded.");
});

test("findingsHeaderText discloses mode, range, status, and counts", () => {
  const text = findingsHeaderText(baseSummary(), 2);
  expect(text).toContain("Findings from session s1");
  expect(text).toContain("Mode:      range");
  expect(text).toContain("Range:     main..feature");
  expect(text).toContain("Status:    complete");
  expect(text).toContain("Findings:  2");
  expect(text).not.toContain("Range:     -");
});

// ---------------------------------------------------------------------------
// CLI — session selection
// ---------------------------------------------------------------------------

test("findings shows the most recent session by default", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-old",
        started: new Date("2026-01-01T10:00:00Z"),
        reviewMode: "range",
        diffFrom: "main",
        diffTo: "feature",
        items: [{ type: "done", path: "old.ts", fingerprint: "fp-old", comments: [comment("old.ts", "older finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      writeSession(repo, {
        sessionId: "session-new",
        started: new Date("2026-01-02T10:00:00Z"),
        reviewMode: "range",
        diffFrom: "main",
        diffTo: "feature",
        items: [{ type: "done", path: "new.ts", fingerprint: "fp-new", comments: [comment("new.ts", "newer finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Findings from session session-new");
      expect(cap.stdout()).toContain("newer finding");
      expect(cap.stdout()).not.toContain("older finding");
      expect(cap.stdout()).toContain("Status:    complete");
      expect(cap.stderr()).toBe("");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings --session replays the named session", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-old",
        started: new Date("2026-01-01T10:00:00Z"),
        items: [{ type: "done", path: "old.ts", fingerprint: "fp-old", comments: [comment("old.ts", "older finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      writeSession(repo, {
        sessionId: "session-new",
        started: new Date("2026-01-02T10:00:00Z"),
        items: [{ type: "done", path: "new.ts", fingerprint: "fp-new", comments: [comment("new.ts", "newer finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings", "--session", "session-old"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Findings from session session-old");
      expect(cap.stdout()).toContain("older finding");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings --repo reads another repository's sessions", async () => {
  const repo = mkRepoDir();
  const elsewhere = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-a",
        started: new Date("2026-01-01T10:00:00Z"),
        items: [{ type: "done", path: "a.ts", fingerprint: "fp-a", comments: [comment("a.ts", "repo a finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(elsewhere);
      const code = await runCli(["findings", "--repo", repo], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("repo a finding");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI — failure boundaries
// ---------------------------------------------------------------------------

test("findings with no sessions exits 1 with a hint on stderr", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(1);
      expect(cap.stdout()).toBe("");
      expect(cap.stderr()).toContain("No previous review or scan sessions found");
      expect(cap.stderr()).toContain("pi-review review");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings with an unknown session id exits 1", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-a",
        started: new Date("2026-01-01T10:00:00Z"),
        items: [],
        manifest: makeManifest("skipped", 0, 0),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings", "--session", "nope"], { io: cap.io });
      expect(code).toBe(1);
      expect(cap.stderr()).toContain('unknown session "nope"');
      expect(cap.stdout()).toBe("");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings surfaces an empty HOME as an error, not a crash", async () => {
  const repo = mkRepoDir();
  const orig = process.env.HOME;
  process.env.HOME = "";
  try {
    const cap = captureIo(repo);
    const code = await runCli(["findings"], { io: cap.io });
    expect(code).toBe(1);
    expect(cap.stderr()).toContain("Error:");
    expect(cap.stderr()).toContain("home");
    expect(cap.stdout()).toBe("");
  } finally {
    process.env.HOME = orig;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings rejects unknown flags and invalid formats as usage errors", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      const cap1 = captureIo(repo);
      const code1 = await runCli(["findings", "--severity", "high"], { io: cap1.io });
      expect(code1).toBe(1);
      expect(cap1.stderr()).toContain("unknown flag");
      expect(cap1.stderr()).toContain("pi-review");

      const cap2 = captureIo(repo);
      const code2 = await runCli(["findings", "--format", "yaml"], { io: cap2.io });
      expect(code2).toBe(1);
      expect(cap2.stderr()).toContain("invalid --format value \"yaml\"");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI — session semantics
// ---------------------------------------------------------------------------

test("findings labels aborted sessions and still shows recorded findings", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-aborted",
        started: new Date("2026-01-01T10:00:00Z"),
        reviewMode: "range",
        diffFrom: "main",
        diffTo: "feature",
        items: [{ type: "done", path: "a.ts", fingerprint: "fp-a", comments: [comment("a.ts", "recorded before cancel")] }],
        end: false,
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Status:    aborted");
      expect(cap.stdout()).toContain("recorded before cancel");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings excludes comments from files that later failed", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-mixed",
        started: new Date("2026-01-01T10:00:00Z"),
        items: [
          { type: "done", path: "kept.ts", fingerprint: "fp-kept", comments: [comment("kept.ts", "kept finding")] },
          { type: "done", path: "gone.ts", fingerprint: "fp-gone", comments: [comment("gone.ts", "retracted finding")] },
          { type: "failed", path: "gone.ts", fingerprint: "fp-gone", error: "provider blew up" },
        ],
        manifest: makeManifest("partial", 2, 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("kept finding");
      expect(cap.stdout()).not.toContain("retracted finding");
      expect(cap.stdout()).toContain("Findings:  1");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings includes comments reused from a parent session", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-resumed",
        started: new Date("2026-01-01T10:00:00Z"),
        items: [
          { type: "reused", path: "a.ts", fingerprint: "fp-a", sourceSessionId: "parent", comments: [comment("a.ts", "reused finding")] },
        ],
        manifest: makeManifest("complete", 1, 0),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("reused finding");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings reports a zero-findings session as a clean result", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-clean",
        started: new Date("2026-01-01T10:00:00Z"),
        items: [],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Findings:  0");
      expect(cap.stdout()).toContain("No comments generated. Looks good to me.");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings labels scan sessions without inventing a range", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-scan",
        started: new Date("2026-01-01T10:00:00Z"),
        reviewMode: "full_scan",
        scanPaths: ["src"],
        items: [{ type: "done", path: "src/a.ts", fingerprint: "fp-a", comments: [comment("src/a.ts", "scan finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("Mode:      full_scan");
      expect(cap.stdout()).not.toContain("Range:");
      expect(cap.stdout()).toContain("scan finding");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI — output formats
// ---------------------------------------------------------------------------

test("findings --format json emits one ANSI-free envelope document", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-json",
        started: new Date("2026-01-02T10:00:00Z"),
        reviewMode: "range",
        diffFrom: "main",
        diffTo: "feature",
        items: [
          { type: "done", path: "a.ts", fingerprint: "fp-a", comments: [comment("a.ts", "json finding one"), comment("b.ts", "json finding two")] },
        ],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings", "--format", "json"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).not.toContain("\u001b[");
      const doc = JSON.parse(cap.stdout()) as {
        status: string;
        session_id: string;
        review_mode: string;
        range: string;
        started_at: string;
        ended_at: string;
        message: string;
        comments: Array<Record<string, unknown>>;
      };
      expect(doc.status).toBe("complete");
      expect(doc.session_id).toBe("session-json");
      expect(doc.review_mode).toBe("range");
      expect(doc.range).toBe("main..feature");
      expect(doc.started_at).toBe("2026-01-02T10:00:00.000Z");
      // ended_at is the session_end record's own wall-clock timestamp.
      expect(doc.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(doc.message).toBe("Review complete: 2 finding(s) across 1 selected item(s).");
      expect(doc.comments).toHaveLength(2);
      expect(doc.comments[0]).toMatchObject({ path: "a.ts", content: "json finding one", start_line: 3, end_line: 5, severity: "high", category: "bug" });
      expect(cap.stderr()).toBe("");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings --format sarif emits a valid ANSI-free SARIF report", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-sarif",
        started: new Date("2026-01-02T10:00:00Z"),
        items: [{ type: "done", path: "a.ts", fingerprint: "fp-a", comments: [comment("a.ts", "sarif finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });
      const cap = captureIo(repo);
      const code = await runCli(["findings", "--format", "sarif"], { io: cap.io });
      expect(code).toBe(0);
      expect(cap.stdout()).not.toContain("\u001b[");
      const doc = JSON.parse(cap.stdout()) as {
        version: string;
        runs: Array<{ results: Array<Record<string, unknown>>; invocations: Array<{ executionSuccessful: boolean }> }>;
      };
      expect(doc.version).toBe("2.1.0");
      expect(doc.runs).toHaveLength(1);
      expect(doc.runs[0]!.results).toHaveLength(1);
      expect(doc.runs[0]!.results[0]).toMatchObject({ ruleId: "bug", level: "error" });
      expect(doc.runs[0]!.invocations[0]!.executionSuccessful).toBe(true);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findings text honors --color; machine formats never emit ANSI", async () => {
  const repo = mkRepoDir();
  try {
    await withTempHome(async () => {
      writeSession(repo, {
        sessionId: "session-color",
        started: new Date("2026-01-02T10:00:00Z"),
        items: [{ type: "done", path: "a.ts", fingerprint: "fp-a", comments: [comment("a.ts", "colored finding")] }],
        manifest: makeManifest("complete", 1, 1),
      });

      const capAlways = captureIo(repo);
      const codeAlways = await runCli(["findings", "--color", "always"], { io: capAlways.io });
      expect(codeAlways).toBe(0);
      expect(capAlways.stdout()).toContain("\u001b[");
      expect(capAlways.stdout()).toContain("colored finding");

      const capNever = captureIo(repo);
      const codeNever = await runCli(["findings", "--color", "never"], { io: capNever.io });
      expect(codeNever).toBe(0);
      expect(capNever.stdout()).not.toContain("\u001b[");

      const capJson = captureIo(repo);
      const codeJson = await runCli(["findings", "--color", "always", "--format", "json"], { io: capJson.io });
      expect(codeJson).toBe(0);
      expect(capJson.stdout()).not.toContain("\u001b[");
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
