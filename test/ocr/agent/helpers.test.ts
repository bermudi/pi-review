// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/agent_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Covers helper pure tests: BuildFilterCommentsJSON, ParseFilterResponse, ExtFromPath, FormatToolDefs, BuildToolDefs, FilterLargeDiffs, ReviewItemFingerprint etc.

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, hashFields, reviewItemFingerprint } from "../../../src/ocr/agent/agent.js";
import { buildFilterCommentsJSON, parseFilterResponse, parseFilterToolCalls, REVIEW_FILTER_TOOLS } from "../../../src/ocr/agent/filter.js";
import { formatToolDefs, BuildToolDefs } from "../../../src/ocr/agent/format.js";
import { extFromPath } from "../../../src/ocr/agent/preview.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { createDiff } from "../../../src/ocr/model/diff.js";
import { parseDiffText } from "../../../src/ocr/diff/parser.js";
import { countTokens } from "../../../src/ocr/llmloop/compression.js";
import type { Template } from "../../../src/ocr/template/template.js";

function makeAgent(templateOverrides: Partial<Template> = {}): Agent {
  const fakeClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
  const base: Template = {
    MaxTokens: 100,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "user", content: "t" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
  } as unknown as Template;
  return new Agent({
    repoDir: "/tmp",
    model: "test",
    llmClient: fakeClient,
    template: { ...base, ...templateOverrides } as unknown as Template,
    mainToolDefs: [],
  } as unknown as never);
}

function exactNTokens(n: number): string {
  if (n === 0) return "";
  const s = "a".repeat(4 * n);
  const got = countTokens(s);
  if (got !== n) throw new Error(`fixture drift: countTokens for ${n} => ${got}`);
  return s;
}

describe("ocr agent helpers (ported from internal/agent/agent_test.go)", () => {
  // OCR v1.9.3: TestBuildFilterCommentsJSON
  test("TestBuildFilterCommentsJSON", () => {
    const cases: Array<{ name: string; comments: Array<{ content: string; existingCode?: string }>; wantIDs: string[] | null }> = [
      { name: "empty slice", comments: [], wantIDs: [] },
      { name: "single comment", comments: [{ content: "fix this", existingCode: "old code" }], wantIDs: ["c-0"] },
      { name: "multiple comments sequential IDs", comments: [{ content: "issue A" }, { content: "issue B", existingCode: "existing" }, { content: "issue C" }], wantIDs: ["c-0", "c-1", "c-2"] },
    ];
    for (const tc of cases) {
      const input = tc.comments.map((c) => ({ path: "a.go", content: c.content, existingCode: c.existingCode } as unknown as import("../../../src/ocr/model/review.js").LlmComment));
      const got = buildFilterCommentsJSON(input);
      const items = JSON.parse(got) as Array<{ id: string; content: string; existing_code?: string }>;
      expect(items.length).toBe(tc.comments.length);
      for (let i = 0; i < items.length; i++) {
        if (tc.wantIDs !== null) expect(items[i]!.id).toBe(tc.wantIDs[i]!);
        expect(items[i]!.content).toBe(tc.comments[i]!.content);
        expect(items[i]!.existing_code ?? "").toBe(tc.comments[i]!.existingCode ?? "");
      }
    }
    expect(buildFilterCommentsJSON([])).toBe("[]");
  });

  // OCR v1.9.9: TestParseFilterToolCalls
  test("TestParseFilterToolCalls", () => {
    const call = (name: string, argumentsText: string) => ({
      id: "call", type: "function", function: { name, arguments: argumentsText },
    });
    expect(parseFilterToolCalls([], 5)).toBeNull();
    expect([...parseFilterToolCalls([call("report_incorrect_comments", `{"comment_ids":["c-0","c-2"]}`)], 5)!.keys()]).toEqual([0, 2]);
    expect(parseFilterToolCalls([call("approve_all_comments", "{}")], 5)?.size).toBe(0);
    expect(parseFilterToolCalls([call("other_tool", `{"comment_ids":["c-0"]}`)], 5)).toBeNull();
    expect([...parseFilterToolCalls([call("report_incorrect_comments", `{"comment_ids":["c-0","c-10"]}`)], 5)!.keys()]).toEqual([0]);
    expect(parseFilterToolCalls([call("report_incorrect_comments", "{}")], 5)?.size).toBe(0);
    expect(parseFilterToolCalls([call("report_incorrect_comments", "not json")], 5)).toBeNull();
  });

  test("review filter tools retain OCR's complete ordered schema", () => {
    expect(REVIEW_FILTER_TOOLS).toEqual([
      {
        type: "function",
        function: {
          name: "report_incorrect_comments",
          description: "Report review comments that this diff proves to be factually wrong: either the code they target is absent from the diff, or one diff line literally contradicts their central claim. For every id listed you must be able to name that line. Do not use this for comments you merely find unconvincing, unverifiable, or low-value, nor for comments about memory safety, concurrency, linkage consistency, unused parameters, or behavioral changes.",
          parameters: {
            type: "object",
            properties: {
              analysis: { type: "array", description: "Work through every candidate comment BEFORE deciding. One entry per candidate: its id, whether its subject hits the protected-subject veto (Step 1) or the value veto (Step 2), the exact diff line that refutes it if any, and your final call. Only ids you conclude here as removable may appear in comment_ids.", items: { type: "string" } },
              comment_ids: { type: "array", description: "IDs concluded removable in analysis, e.g. [\"c-0\", \"c-2\"]. Must not be empty.", items: { type: "string" } },
            },
            required: ["analysis", "comment_ids"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "approve_all_comments",
          description: "Keep every review comment. Call this whenever no comment clears the removal bar — including when comments look doubtful, cannot be verified from the diff alone, or seem minor. This is the expected outcome for most files.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    const parameters = REVIEW_FILTER_TOOLS[0]?.function.parameters as { properties?: Record<string, unknown> };
    expect(Object.keys(parameters.properties ?? {})).toEqual(["analysis", "comment_ids"]);
  });

  // OCR v1.9.3: TestParseFilterResponse
  test("TestParseFilterResponse", () => {
    const cases: Array<{ name: string; raw: string; total: number; wantSet: Map<number, unknown> | null }> = [
      { name: "valid JSON array", raw: `["c-0","c-2","c-4"]`, total: 5, wantSet: new Map([[0, {}], [2, {}], [4, {}]]) },
      { name: "markdown fenced JSON", raw: "```json\n[\"c-1\"]\n```", total: 3, wantSet: new Map([[1, {}]]) },
      { name: "out-of-range indices ignored", raw: `["c-0","c-10","c-99"]`, total: 5, wantSet: new Map([[0, {}]]) },
      { name: "negative index ignored", raw: `["c--1","c-0"]`, total: 2, wantSet: new Map([[0, {}]]) },
      { name: "invalid ID format ignored", raw: `["x-0","c-abc","c-1"]`, total: 3, wantSet: new Map([[1, {}]]) },
      { name: "invalid JSON returns nil", raw: `not json`, total: 5, wantSet: null },
      { name: "empty array", raw: `[]`, total: 5, wantSet: new Map() },
    ];
    for (const tc of cases) {
      const got = parseFilterResponse(tc.raw, tc.total);
      if (tc.wantSet === null) {
        expect(got).toBeNull();
        continue;
      }
      expect(got).not.toBeNull();
      expect(got!.size).toBe(tc.wantSet.size);
      for (const k of tc.wantSet.keys()) expect(got!.has(k)).toBe(true);
    }
    expect(parseFilterResponse(`["c-0"]`, 1)!.has(0)).toBe(true);
  });

  // OCR v1.9.3: TestExtFromPath
  test("TestExtFromPath", () => {
    const cases: Array<{ path: string; want: string }> = [
      { path: "main.go", want: ".go" },
      { path: "src/app.tsx", want: ".tsx" },
      { path: "path/to/FILE.JSON", want: ".json" },
      { path: "Makefile", want: "" },
      { path: ".gitignore", want: "" },
      { path: "dir/.hidden", want: "" },
      { path: "archive.tar.gz", want: ".gz" },
      { path: "no-ext", want: "" },
      { path: "path/to/", want: "" },
    ];
    for (const tc of cases) {
      const got = extFromPath(tc.path);
      expect(got).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestFormatToolDefs
  test("TestFormatToolDefs", () => {
    const format = (defs: unknown[]) => formatToolDefs(defs as never);

    expect(format([])).toBe("");

    {
      const defs = [
        {
          type: "function",
          function: {
            name: "file_read",
            description: "Read a file from the repository",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path to read" },
                start_line: { type: "integer", description: "Starting line number" },
              },
              required: ["path"],
            },
          },
        },
      ];
      const got = format(defs);
      expect(got.includes("### Available Tools")).toBe(true);
      expect(got.includes("**file_read**")).toBe(true);
      expect(got.includes("Read a file from the repository")).toBe(true);
      expect(got.includes("path")).toBe(true);
      expect(got.includes("(required)")).toBe(true);
    }

    {
      const raw = `{\n      \"name\":\"code_search\",\n      \"description\":\"Search code\",\n      \"parameters\":{\n        \"type\":\"object\",\n        \"properties\":{\n          \"query\":{\"description\":\"Query string\"},\n          \"path_glob\":{\"description\":\"Path glob\"},\n          \"case_sensitive\":{\"description\":\"Match case\"},\n          \"max_results\":{\"description\":\"Maximum results\"}\n        },\n        \"required\":[\"query\"]\n      }\n    }` as unknown as string;
      const defs = [
        {
          type: "function",
          function: {
            name: "code_search",
            description: "Search code",
            RawDefinition: raw,
            parameters: {
              type: "object",
              properties: {
                query: { description: "Query string" },
                path_glob: { description: "Path glob" },
                case_sensitive: { description: "Match case" },
                max_results: { description: "Maximum results" },
              },
              required: ["query"],
            },
          },
        },
      ];
      const got = format(defs);
      const wantLines = [
        "  - query: Query string (required)",
        "  - path_glob: Path glob",
        "  - case_sensitive: Match case",
        "  - max_results: Maximum results",
      ];
      let last = -1;
      for (const line of wantLines) {
        const idx = got.indexOf(line);
        expect(idx).not.toBe(-1);
        expect(idx).toBeGreaterThan(last);
        last = idx;
      }
    }

    {
      const defs = [
        {
          type: "function",
          function: {
            name: "code_search",
            description: "Search code",
            parameters: {
              type: "object",
              properties: {
                query: { description: "Query string" },
                case_sensitive: { description: "Match case" },
                path_glob: { description: "Path glob" },
                max_results: { description: "Maximum results" },
              },
              required: ["query"],
            },
          },
        },
      ];
      const got = format(defs);
      const wantLines = [
        "  - case_sensitive: Match case",
        "  - max_results: Maximum results",
        "  - path_glob: Path glob",
        "  - query: Query string (required)",
      ];
      let last = -1;
      for (const line of wantLines) {
        const idx = got.indexOf(line);
        expect(idx).not.toBe(-1);
        expect(idx).toBeGreaterThan(last);
        last = idx;
      }
    }

    {
      const defs = [
        {
          type: "function",
          function: {
            name: "task_done",
            description: "Signal task completion",
            parameters: {},
          },
        },
      ];
      const got = format(defs);
      expect(got.includes("**task_done**")).toBe(true);
      expect(got.includes("Parameters:")).toBe(false);
    }

    {
      const defs = [
        { type: "function", function: { name: "tool_a", description: "desc a" } },
        { type: "function", function: { name: "tool_b", description: "desc b" } },
      ];
      const got = format(defs);
      expect(got.includes("tool_a")).toBe(true);
      expect(got.includes("tool_b")).toBe(true);
    }
  });

  // OCR v1.9.3: TestBuildToolDefs
  test("TestBuildToolDefs", () => {
    const funcDef = `{"name":"test_tool","description":"a tool","parameters":{}}`;
    const entries: Array<Record<string, unknown>> = [
      { Name: "plan_only", PlanTask: true, MainTask: false, Definition: funcDef },
      { Name: "main_only", PlanTask: false, MainTask: true, Definition: funcDef },
      { Name: "both", PlanTask: true, MainTask: true, Definition: funcDef },
      { Name: "neither", PlanTask: false, MainTask: false, Definition: funcDef },
    ];

    {
      const defs = BuildToolDefs(entries as unknown as never, true);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBe(2);
      const names = new Set(defs!.map((d) => d.function.name));
      expect(names.has("test_tool")).toBe(true);
    }

    {
      const defs = BuildToolDefs(entries as unknown as never, false);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBe(2);
    }

    {
      const bad: Array<Record<string, unknown>> = [
        { Name: "bad", PlanTask: true, MainTask: true, Definition: `{invalid}` },
        { Name: "good", PlanTask: true, MainTask: true, Definition: funcDef },
      ];
      const defs = BuildToolDefs(bad as unknown as never, true);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBe(1);
    }

    {
      const defs = BuildToolDefs(null as unknown as never, true);
      expect(defs).toBeNull();
    }
  });

  // OCR v1.9.3: TestFilterLargeDiffs
  test("TestFilterLargeDiffs", () => {
    const a = makeAgent({ MaxTokens: 100 } as unknown as Template);
    const diffs: Diff[] = [
      createDiff({ newPath: "small.go", diff: "short diff" }),
      createDiff({ newPath: "large.go", diff: "word ".repeat(500) }),
    ];
    const kept = (a as unknown as { filterLargeDiffs: (d: Diff[]) => Diff[] }).filterLargeDiffs(diffs);
    expect(kept.length).toBe(1);
    expect(kept[0]!.newPath).toBe("small.go");
  });

  // OCR v1.9.3: TestFilterLargeDiffs_Boundary
  test("TestFilterLargeDiffs_Boundary", () => {
    const a = makeAgent({ MaxTokens: 100 } as unknown as Template);
    const diffs: Diff[] = [
      createDiff({ newPath: "at-limit.go", diff: exactNTokens(80) }),
      createDiff({ newPath: "over-limit.go", diff: exactNTokens(81) }),
    ];
    const kept = (a as unknown as { filterLargeDiffs: (d: Diff[]) => Diff[] }).filterLargeDiffs(diffs);
    expect(kept.length).toBe(1);
    expect(kept[0]!.newPath).toBe("at-limit.go");
  });

  // OCR v1.9.3: TestFilterLargeDiffs_ZeroMaxTokens
  test("TestFilterLargeDiffs_ZeroMaxTokens", () => {
    const a = makeAgent({ MaxTokens: 0 } as unknown as Template);
    const diffs: Diff[] = [createDiff({ newPath: "a.go", diff: "some diff" })];
    const kept = (a as unknown as { filterLargeDiffs: (d: Diff[]) => Diff[] }).filterLargeDiffs(diffs);
    expect(kept.length).toBe(1);
  });

  // OCR v1.9.3: TestReviewItemFingerprintIgnoresTrailingLineEndings
  test("TestReviewItemFingerprintIgnoresTrailingLineEndings", () => {
    const base = createDiff({ oldPath: "main.go", newPath: "main.go", diff: "@@ -1 +1 @@\n-old\n+new" });
    const want = reviewItemFingerprint("range", base);
    for (const suffix of ["\n", "\r\n", "\n\n"]) {
      const d = { ...base, diff: base.diff + suffix };
      const got = reviewItemFingerprint("range", d);
      expect(got).toBe(want);
    }
    const withContextLine = { ...base, diff: base.diff + "\n " };
    expect(reviewItemFingerprint("range", withContextLine)).not.toBe(want);
  });

  // OCR v1.9.9: TestReviewItemFingerprintStableAcrossPatchPosition
  test("TestReviewItemFingerprintStableAcrossPatchPosition", async () => {
    const target = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\n";
    const other = "diff --git a/z.go b/z.go\n--- a/z.go\n+++ b/z.go\n@@ -1 +1 @@\n-x\n+y\n";
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fingerprint-"));
    try {
      fs.writeFileSync(path.join(repo, "a.go"), "new\n");
      fs.writeFileSync(path.join(repo, "z.go"), "y\n");
      const fingerprintOfA = async (patch: string): Promise<string> => {
        const diffs = await parseDiffText(patch, repo, "", null);
        const targetDiff = diffs.find((diff) => diff.newPath === "a.go");
        if (targetDiff === undefined) throw new Error("a.go missing from parsed diffs");
        return reviewItemFingerprint("range", targetDiff);
      };
      expect(await fingerprintOfA(other + target)).toBe(await fingerprintOfA(target + other));
      expect(await fingerprintOfA(other + "\n\n" + target + "\n\n")).toBe(
        await fingerprintOfA(target + "\n\n" + other + "\n\n"),
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestCountReviewable
  test("TestCountReviewable", () => {
    const a = makeAgent();
    const diffs: Diff[] = [
      createDiff({ newPath: "main.go", insertions: 10, deletions: 2 }),
      createDiff({ newPath: "deleted.go", isDeleted: true, deletions: 20 }),
      createDiff({ newPath: "binary.bin", isBinary: true }),
      createDiff({ newPath: "helper.go", insertions: 5 }),
    ];
    const count = (a as unknown as { countReviewable: (d: Diff[]) => number }).countReviewable(diffs);
    expect(count).toBe(2);
  });

  // Go nil-receiver is not applicable in TypeScript (upstream TestAgentGettersNil is marked not_applicable in inventory).
  test("TestAgentGettersNil", () => {
    const empty = Object.create(Agent.prototype) as unknown as Agent;
    // Empty agent without initialization should have safe defaults via normal construction paths
    const a = makeAgent();
    expect(a.sessionId()).toBe("");
    expect(a.RunManifest()).toBeNull();
    expect(a.ResumeInfo()).toBeNull();
    expect(empty.RunManifest()).toBeNull();
  });

  // OCR v1.9.3: TestBuildChangeFilesExcept; churn suffix (+N/-M) adopted from
  // OCR commit 43ef414 (v1.11.0, PRs #1078/#1082).
  test("TestBuildChangeFilesExcept", () => {
    const a = makeAgent();
    (a as unknown as { diffs: Diff[] }).diffs = [
      createDiff({ newPath: "main.go", oldPath: "main.go", insertions: 7, deletions: 2 }),
      createDiff({ newPath: "helper.go", oldPath: "helper.go", isNew: true, insertions: 5 }),
      createDiff({ newPath: "removed.go", oldPath: "removed.go", isDeleted: true, deletions: 20 }),
      createDiff({ newPath: "renamed.go", oldPath: "old_name.go", insertions: 3, deletions: 4 }),
      createDiff({ newPath: "bin.dat", oldPath: "bin.dat", isBinary: true }),
    ];
    const got = (a as unknown as { buildChangeFilesExcept: (p: string) => string }).buildChangeFilesExcept("main.go");
    expect(got.includes("main.go")).toBe(false);
    expect(got.includes("ADDED")).toBe(true);
    expect(got.includes("DELETED")).toBe(true);
    expect(got.includes("RENAMED")).toBe(true);
    expect(got.includes("bin.dat")).toBe(false);
    // Exact shape: STATUS   path (+N/-M), one per line. The trailing newline
    // mirrors the Go original's index-based separator (the skipped binary
    // entry is the final element of a.diffs).
    expect(got).toBe(
      "ADDED   helper.go (+5/-0)\nDELETED   removed.go (+0/-20)\nRENAMED   renamed.go (+3/-4)\n",
    );
  });

  // Churn stats reflect each file's own insertions/deletions and default to
  // (+0/-0) when the diff carries no counts (adopted from OCR commit 43ef414).
  test("TestBuildChangeFilesExcept_ChurnDefaults", () => {
    const a = makeAgent();
    (a as unknown as { diffs: Diff[] }).diffs = [
      createDiff({ newPath: "only.go", oldPath: "only.go" }),
    ];
    const got = (a as unknown as { buildChangeFilesExcept: (p: string) => string }).buildChangeFilesExcept("other.go");
    expect(got).toBe("MODIFIED   only.go (+0/-0)");
  });
});
