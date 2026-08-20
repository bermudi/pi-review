// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/agent_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Covers helper pure tests: BuildFilterCommentsJSON, ParseFilterResponse, ExtFromPath, FormatToolDefs, BuildToolDefs, FilterLargeDiffs, ReviewItemFingerprint etc.

import { describe, test, expect } from "bun:test";
import { Agent, hashFields, reviewItemFingerprint, buildFilterCommentsJSON, parseFilterResponse, BuildToolDefs } from "../../../src/ocr-v193/agent/agent.js";
import type { Diff } from "../../../src/ocr-v193/model/diff.js";
import { createDiff } from "../../../src/ocr-v193/model/diff.js";
import { countTokens } from "../../../src/ocr-v193/llmloop/compression.js";
import type { Template } from "../../../src/ocr-v193/template/template.js";

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
  // Generate string that countTokens reports as exactly n, using byte/4 fallback.
  // Since countTokens = floor(bytes/4), we need bytes in [4n, 4n+3].
  // Use "a".repeat(4*n) which is exactly 4n bytes => n tokens.
  if (n === 0) return "";
  const s = "a".repeat(4 * n);
  const got = countTokens(s);
  if (got !== n) throw new Error(`fixture drift: countTokens for ${n} => ${got}`);
  return s;
}

describe("ocr-v193 agent helpers (ported from internal/agent/agent_test.go)", () => {
  // OCR v1.9.3: TestBuildFilterCommentsJSON
  test("TestBuildFilterCommentsJSON", () => {
    const cases: Array<{ name: string; comments: Array<{ content: string; existingCode?: string }>; wantIDs: string[] | null }> = [
      { name: "empty slice", comments: [], wantIDs: [] },
      { name: "single comment", comments: [{ content: "fix this", existingCode: "old code" }], wantIDs: ["c-0"] },
      { name: "multiple comments sequential IDs", comments: [{ content: "issue A" }, { content: "issue B", existingCode: "existing" }, { content: "issue C" }], wantIDs: ["c-0", "c-1", "c-2"] },
    ];
    for (const tc of cases) {
      const input = tc.comments.map((c) => ({ path: "a.go", content: c.content, existingCode: c.existingCode } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment));
      // Use free function via Agent instance wrapper
      const agent = makeAgent();
      const got = (agent as unknown as { buildFilterCommentsJSON: (c: unknown[]) => string }).buildFilterCommentsJSON(input);
      const items = JSON.parse(got) as Array<{ id: string; content: string; existing_code?: string }>;
      expect(items.length).toBe(tc.comments.length);
      for (let i = 0; i < items.length; i++) {
        if (tc.wantIDs !== null) expect(items[i]!.id).toBe(tc.wantIDs[i]!);
        expect(items[i]!.content).toBe(tc.comments[i]!.content);
        expect(items[i]!.existing_code ?? "").toBe(tc.comments[i]!.existingCode ?? "");
      }
    }
    // Also test free function directly
    expect(buildFilterCommentsJSON([])).toBe("[]");
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
      const agent = makeAgent();
      const got = (agent as unknown as { parseFilterResponse: (raw: string, total: number) => Map<number, unknown> | null }).parseFilterResponse(tc.raw, tc.total);
      if (tc.wantSet === null) {
        expect(got).toBeNull();
        continue;
      }
      expect(got).not.toBeNull();
      expect(got!.size).toBe(tc.wantSet.size);
      for (const k of tc.wantSet.keys()) expect(got!.has(k)).toBe(true);
    }
    // Also test free function
    expect(parseFilterResponse(`["c-0"]`, 1)!.has(0)).toBe(true);
  });

  // OCR v1.9.3: TestExtFromPath
  test("TestExtFromPath", () => {
    const agent = makeAgent();
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
      const got = (agent as unknown as { extFromPath: (p: string) => string }).extFromPath(tc.path);
      expect(got).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestFormatToolDefs
  test("TestFormatToolDefs", () => {
    const agent = makeAgent();
    const format = (defs: unknown[]) => (agent as unknown as { formatToolDefs: (d: unknown[]) => string }).formatToolDefs(defs as never);

    // empty defs returns empty string
    expect(format([])).toBe("");

    // single tool with parameters
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

    // parameters preserve raw JSON order
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

    // fallback parameters are sorted when raw order is unavailable
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

    // tool without parameters
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

    // multiple tools
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

    // planOnly=true returns plan_task tools
    {
      const defs = BuildToolDefs(entries as unknown as never, true);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBe(2);
      const names = new Set(defs!.map((d) => d.function.name));
      expect(names.has("test_tool")).toBe(true);
    }

    // planOnly=false returns main_task tools
    {
      const defs = BuildToolDefs(entries as unknown as never, false);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBe(2);
    }

    // invalid definition JSON is skipped
    {
      const bad: Array<Record<string, unknown>> = [
        { Name: "bad", PlanTask: true, MainTask: true, Definition: `{invalid}` },
        { Name: "good", PlanTask: true, MainTask: true, Definition: funcDef },
      ];
      const defs = BuildToolDefs(bad as unknown as never, true);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBe(1);
    }

    // empty entries returns nil
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
    for (const [name, suffix] of Object.entries({ lf: "\n", crlf: "\r\n", "extra blank line": "\n\n" })) {
      const d = { ...base, diff: base.diff + suffix };
      const got = reviewItemFingerprint("range", d);
      expect(got).toBe(want);
    }
    const withContextLine = { ...base, diff: base.diff + "\n " };
    expect(reviewItemFingerprint("range", withContextLine)).not.toBe(want);
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

  // OCR v1.9.3: TestAgentGettersNil
  test("TestAgentGettersNil", () => {
    const nilAgent = null as unknown as Agent;
    expect((Agent.prototype as unknown as { SessionID: (this: unknown) => string }).SessionID.call(nilAgent)).toBe("");
    expect((Agent.prototype as unknown as { RunManifest: (this: unknown) => unknown }).RunManifest.call(nilAgent)).toBeNull();
    const empty = Object.create(Agent.prototype) as unknown as Agent;
    expect((empty as unknown as { SessionID: () => string }).SessionID()).toBe("");
    expect((empty as unknown as { RunManifest: () => unknown }).RunManifest()).toBeNull();
    expect((empty as unknown as { ResumeInfo: () => unknown }).ResumeInfo()).toBeNull();
  });

  // OCR v1.9.3: TestBuildChangeFilesExcept
  test("TestBuildChangeFilesExcept", () => {
    const a = makeAgent();
    (a as unknown as { diffs: Diff[] }).diffs = [
      createDiff({ newPath: "main.go", oldPath: "main.go" }),
      createDiff({ newPath: "helper.go", oldPath: "helper.go", isNew: true }),
      createDiff({ newPath: "removed.go", oldPath: "removed.go", isDeleted: true }),
      createDiff({ newPath: "renamed.go", oldPath: "old_name.go" }),
      createDiff({ newPath: "bin.dat", oldPath: "bin.dat", isBinary: true }),
    ];
    const got = (a as unknown as { buildChangeFilesExcept: (p: string) => string }).buildChangeFilesExcept("main.go");
    expect(got.includes("main.go")).toBe(false);
    expect(got.includes("ADDED")).toBe(true);
    expect(got.includes("DELETED")).toBe(true);
    expect(got.includes("RENAMED")).toBe(true);
    expect(got.includes("bin.dat")).toBe(false);
  });
});
