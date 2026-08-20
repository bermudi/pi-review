// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/dedup_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/dedup.test.ts -> internal/scan/dedup_test.go

import { describe, test, expect } from "bun:test";
import type { LlmComment } from "../../../src/ocr-v193/model/review.js";

// Access free functions via typed cast to avoid adding test-only exports prematurely;
// if they become exported for runtime callers, import directly.
import * as ScanModule from "../../../src/ocr-v193/scan/scan.js";
type ScanDedup = {
  applyDedupGroups(raw: string, originals: LlmComment[]): LlmComment[] | null;
  buildDedupCommentsJSON(comments: LlmComment[]): string;
};
// Fallback: if not exported, the cast will still work if we export them; otherwise we use the private via any workaround
// We will rely on exports being present; ensure scan.ts exports them.
const { applyDedupGroups, buildDedupCommentsJSON } = ScanModule as unknown as ScanDedup;

function cmt(path: string, content: string): LlmComment {
  return { path, content } as LlmComment;
}

describe("ocr-v193 scan dedup (ported from internal/scan/dedup_test.go)", () => {
  // OCR v1.9.3: TestApplyDedupGroups_MergeAndKeep
  test("TestApplyDedupGroups_MergeAndKeep", () => {
    const originals: LlmComment[] = [
      cmt("a.go", "missing nil check"),
      cmt("b.go", "missing nil check"),
      cmt("c.go", "race on shared map"),
      cmt("d.go", "missing nil check"),
    ];
    const raw = `{
	  "groups": [
	    {"members": ["c-0", "c-1", "c-3"], "merged_content": "missing nil check (3 files)"},
	    {"members": ["c-2"]}
	  ]
	}`;
    const got = applyDedupGroups(raw, originals);
    expect(got).not.toBeNull();
    expect(got?.length).toBe(2);
    expect(got?.[0]?.path).toBe("a.go");
    expect(got?.[0]?.content).toBe("missing nil check (3 files)");
    expect(got?.[1]?.path).toBe("c.go");
    expect(got?.[1]?.content).toBe("race on shared map");
  });

  // OCR v1.9.3: TestApplyDedupGroups_KeepCanonicalContentWhenNoMergedContent
  test("TestApplyDedupGroups_KeepCanonicalContentWhenNoMergedContent", () => {
    const originals: LlmComment[] = [cmt("a.go", "original A"), cmt("b.go", "original B")];
    const raw = `{"groups": [{"members": ["c-0", "c-1"]}]}`;
    const got = applyDedupGroups(raw, originals);
    expect(got).not.toBeNull();
    expect(got?.length).toBe(1);
    expect(got?.[0]?.content).toBe("original A");
  });

  // OCR v1.9.3: TestApplyDedupGroups_RejectsBadShapes
  test("TestApplyDedupGroups_RejectsBadShapes", () => {
    const originals: LlmComment[] = [cmt("a.go", "x"), cmt("b.go", "y")];
    const cases: Record<string, string> = {
      "empty input": ``,
      "non-json": `not json at all`,
      "missing id": `{"groups": [{"members": ["c-0"]}]}`,
      "duplicate id": `{"groups": [{"members": ["c-0", "c-0"]}, {"members": ["c-1"]}]}`,
      "unknown id": `{"groups": [{"members": ["c-0"]}, {"members": ["c-99"]}]}`,
      "empty members": `{"groups": [{"members": []}, {"members": ["c-0", "c-1"]}]}`,
      "missing one": `{"groups": [{"members": ["c-1"]}]}`,
    };
    for (const [name, raw] of Object.entries(cases)) {
      const got = applyDedupGroups(raw, originals);
      expect(got).toBeNull();
      // keep name for debugging
      expect(name).toBeDefined();
    }
  });

  // OCR v1.9.3: TestApplyDedupGroups_AcceptsMarkdownFences
  test("TestApplyDedupGroups_AcceptsMarkdownFences", () => {
    const originals: LlmComment[] = [cmt("a.go", "x"), cmt("b.go", "y")];
    const raw = "```json\n" + `{"groups":[{"members":["c-0","c-1"],"merged_content":"merged"}]}` + "\n```";
    const got = applyDedupGroups(raw, originals);
    expect(got).not.toBeNull();
    expect(got?.length).toBe(1);
    expect(got?.[0]?.content).toBe("merged");
  });

  // OCR v1.9.3: TestBuildDedupCommentsJSON_IncludesIDsAndKeyFields
  test("TestBuildDedupCommentsJSON_IncludesIDsAndKeyFields", () => {
    const cs: LlmComment[] = [
      { path: "a.go", content: "first", existingCode: "x := nil" } as LlmComment,
      { path: "b.go", content: "second" } as LlmComment,
    ];
    const got = buildDedupCommentsJSON(cs);
    for (const want of [`"id":"c-0"`, `"id":"c-1"`, `"path":"a.go"`, `"content":"first"`, `"existing_code":"x := nil"`]) {
      expect(got.includes(want)).toBe(true);
    }
    expect(got.includes(`"existing_code":""`)).toBe(false);
  });
});
