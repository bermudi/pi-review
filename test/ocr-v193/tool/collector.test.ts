// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/comment_collector_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import { CommentCollector, NewCommentCollector } from "../../../src/ocr-v193/tool/collector.js";
import type { LlmComment } from "../../../src/ocr-v193/model/types.js";

function cm(path: string, content: string): LlmComment {
  return { path, content };
}

describe("ocr-v193 CommentCollector (ported)", () => {
  // OCR v1.9.3: TestCommentCollector_AddAndComments
  test("Add and Comments", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "issue 1"));
    c.Add(cm("b.go", "issue 2"));
    const got = c.Comments();
    expect(got.length).toBe(2);
    expect(got[0]!.path).toBe("a.go");
    expect(got[1]!.path).toBe("b.go");
  });

  // OCR v1.9.3: TestCommentCollector_CommentsReturnsDefensiveCopy
  test("Comments returns defensive copy", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "x"));
    const got = c.Comments();
    got[0]!.content = "mutated";
    expect(c.Comments()[0]!.content).toBe("x");
  });

  // OCR v1.9.3: TestCommentCollector_CommentsForPath
  test("CommentsForPath", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "1"));
    c.Add(cm("b.go", "2"));
    c.Add(cm("a.go", "3"));
    const got = c.CommentsForPath("a.go");
    expect(got.length).toBe(2);
    expect(got[0]!.content).toBe("1");
    expect(got[1]!.content).toBe("3");
    expect(c.CommentsForPath("nonexist.go").length).toBe(0);
  });

  // OCR v1.9.3: TestCommentCollector_SnapshotAndSince
  test("Snapshot and Since", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "old"));
    const snap = c.Snapshot();
    expect(snap).toBe(1);
    c.Add(cm("b.go", "new1"));
    c.Add(cm("c.go", "new2"));
    const since = c.Since(snap);
    expect(since!.length).toBe(2);
    expect(since![0]!.path).toBe("b.go");
    expect(since![1]!.path).toBe("c.go");
  });

  // OCR v1.9.3: TestCommentCollector_SinceEdgeCases
  test("Since edge cases", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "x"));
    expect(c.Since(-1)!.length).toBe(1);
    expect(c.Since(100)).toBeNull();
  });

  // OCR v1.9.3: TestCommentCollector_ReplaceSince
  test("ReplaceSince", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "keep"));
    const snap = c.Snapshot();
    c.Add(cm("b.go", "raw1"));
    c.Add(cm("c.go", "raw2"));
    c.ReplaceSince(snap, [cm("merged.go", "deduped")]);
    const got = c.Comments();
    expect(got.length).toBe(2);
    expect(got[0]!.path).toBe("a.go");
    expect(got[1]!.path).toBe("merged.go");
  });

  // OCR v1.9.3: TestCommentCollector_ReplaceSinceOutOfBounds
  test("ReplaceSince out of bounds no-op", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "x"));
    c.ReplaceSince(100, [cm("z.go", "nope")]);
    expect(c.Comments().length).toBe(1);
  });

  // OCR v1.9.3: TestCommentCollector_RemoveByPathAndIndices
  test("RemoveByPathAndIndices", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "a0"));
    c.Add(cm("b.go", "b0"));
    c.Add(cm("a.go", "a1"));
    c.Add(cm("a.go", "a2"));
    c.Add(cm("b.go", "b1"));
    c.RemoveByPathAndIndices("a.go", new Map([[0, {}], [2, {}]]));
    const got = c.Comments();
    expect(got.length).toBe(3);
    const paths = got.map((g) => `${g.path}:${g.content}`);
    expect(paths).toEqual(["b.go:b0", "a.go:a1", "b.go:b1"]);
  });

  // OCR v1.9.3: TestCommentCollector_RemoveByPathAndIndices_NoMatch
  test("RemoveByPathAndIndices no match", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "x"));
    c.RemoveByPathAndIndices("b.go", new Map([[0, {}]]));
    expect(c.Comments().length).toBe(1);
  });

  // OCR v1.9.3: TestCommentCollector_ReplaceSince_NegativeSnap
  test("ReplaceSince negative snap", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "keep"));
    c.ReplaceSince(-1, [cm("new.go", "replaced")]);
    const got = c.Comments();
    expect(got.length).toBe(1);
    expect(got[0]!.path).toBe("new.go");
  });

  // OCR v1.9.3: TestCommentCollector_ReplaceSince_Zero
  test("ReplaceSince zero", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "x"));
    c.Add(cm("b.go", "y"));
    c.ReplaceSince(0, [cm("only.go", "z")]);
    const got = c.Comments();
    expect(got.length).toBe(1);
    expect(got[0]!.path).toBe("only.go");
  });

  test("RemoveByPath (convenience) removes all for path", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "1"));
    c.Add(cm("b.go", "2"));
    c.Add(cm("a.go", "3"));
    c.RemoveByPath("a.go");
    expect(c.Comments().length).toBe(1);
    expect(c.Comments()[0]!.path).toBe("b.go");
  });

  test("deterministic ordering preserved", () => {
    const c = NewCommentCollector();
    for (let i = 0; i < 5; i++) c.Add(cm(`file${i}.go`, `issue ${i}`));
    const got = c.Comments();
    for (let i = 0; i < 5; i++) expect(got[i]!.path).toBe(`file${i}.go`);
  });

  test("Since negative returns all", () => {
    const c = NewCommentCollector();
    c.Add(cm("a.go", "x"));
    c.Add(cm("b.go", "y"));
    const s = c.Since(-10);
    expect(s).not.toBeNull();
    expect(s!.length).toBe(2);
  });
});
