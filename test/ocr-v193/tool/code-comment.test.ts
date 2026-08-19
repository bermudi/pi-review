// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/code_comment_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";
import {
  CodeCommentProvider,
  ParseComments,
} from "../../../src/ocr-v193/tool/code-comment.js";
import { NewCommentCollector } from "../../../src/ocr-v193/tool/collector.js";
import { CodeComment, CommentSucceed } from "../../../src/ocr-v193/tool/types.js";
import type { LlmComment } from "../../../src/ocr-v193/model/types.js";

// OCR v1.9.3: TestParseComments
test("ParseComments accepts OCR inputs and rejects missing comment arrays", () => {
  const cases: readonly {
    name: string;
    args: Record<string, unknown>;
    wantCount?: number;
    wantErr?: boolean;
  }[] = [
    {
      name: "valid comments array",
      args: {
        path: "main.go",
        comments: [
          { content: "issue 1", existing_code: "old" },
          { content: "issue 2", suggestion_code: "new" },
        ],
      },
      wantCount: 2,
    },
    {
      name: "comments as JSON string",
      args: { path: "main.go", comments: `[{"content":"from string"}]` },
      wantCount: 1,
    },
    {
      name: "missing path skips comment",
      args: { comments: [{ content: "no path" }] },
      wantCount: 0,
    },
    {
      name: "missing content skips comment",
      args: { path: "file.go", comments: [{ existing_code: "has no content" }] },
      wantCount: 0,
    },
    {
      name: "empty comments array returns error",
      args: { path: "x.go", comments: [] },
      wantErr: true,
    },
    {
      name: "no comments key returns error",
      args: { path: "x.go" },
      wantErr: true,
    },
    {
      name: "invalid JSON string returns error",
      args: { path: "x.go", comments: "not json" },
      wantErr: true,
    },
    {
      name: "thinking field preserved",
      args: { path: "a.go", comments: [{ content: "c", thinking: "my reasoning" }] },
      wantCount: 1,
    },
  ];

  for (const item of cases) {
    const { comments, errorMsg } = ParseComments(item.args);
    if (item.wantErr === true) {
      expect(errorMsg, item.name).not.toBe("");
      continue;
    }
    expect(errorMsg, item.name).toBe("");
    expect(comments.length, item.name).toBe(item.wantCount!);
  }
});

// OCR v1.9.3: TestParseComments_Fields
test("ParseComments preserves all OCR comment fields", () => {
  const { comments, errorMsg } = ParseComments({
    path: "src/app.ts",
    comments: [
      {
        content: "fix null check",
        existing_code: "if (x == null)",
        suggestion_code: "if (x === null)",
        thinking: "strict equality is safer",
      },
    ],
  });

  expect(errorMsg).toBe("");
  expect(comments.length).toBe(1);
  const comment = comments[0]!;
  expect(comment.path).toBe("src/app.ts");
  expect(comment.content).toBe("fix null check");
  expect(comment.existingCode).toBe("if (x == null)");
  expect(comment.suggestionCode).toBe("if (x === null)");
  expect(comment.thinking).toBe("strict equality is safer");
});

// OCR v1.9.3: TestParseComments_CategorySeverity
test("ParseComments reads, omits, and normalizes category and severity", () => {
  const present = ParseComments({
    path: "main.go",
    comments: [
      {
        content: "Potential nil pointer dereference.",
        existing_code: "x := *p",
        category: "bug",
        severity: "high",
      },
    ],
  });
  expect(present.errorMsg).toBe("");
  expect(present.comments.length).toBe(1);
  expect(present.comments[0]!.category).toBe("bug");
  expect(present.comments[0]!.severity).toBe("high");

  const absent = ParseComments({
    path: "main.go",
    comments: [{ content: "Consider renaming for clarity.", existing_code: "a := 1" }],
  });
  expect(absent.errorMsg).toBe("");
  expect(absent.comments.length).toBe(1);
  expect(absent.comments[0]!.category ?? "").toBe("");
  expect(absent.comments[0]!.severity ?? "").toBe("");

  const normalized = ParseComments({
    path: "main.go",
    comments: [
      {
        content: "Potential nil pointer dereference.",
        existing_code: "x := *p",
        category: "Security",
        severity: "Critical",
      },
    ],
  });
  expect(normalized.errorMsg).toBe("");
  expect(normalized.comments.length).toBe(1);
  expect(normalized.comments[0]!.category).toBe("security");
  expect(normalized.comments[0]!.severity).toBe("critical");
});

// OCR v1.9.3: TestParseComments_CategorySeveritySchemaDrift
test("ParseComments applies OCR metadata fallbacks for schema drift", () => {
  const { comments, errorMsg } = ParseComments({
    path: "main.go",
    comments: [
      {
        content: "Use the canonical metadata fallback.",
        existing_code: "value := compute()",
        category: "correctness",
        severity: "info",
      },
    ],
  });

  expect(errorMsg).toBe("");
  expect(comments.length).toBe(1);
  expect(comments[0]!.category).toBe("other");
  expect(comments[0]!.severity).toBe("low");
  expect(comments[0]!.content).toBe("Use the canonical metadata fallback.");
});

// OCR v1.9.3: TestLlmComment_JSONCategorySeverity
test("LlmComment JSON omits empty metadata and serializes set metadata", () => {
  const withoutMetadata: LlmComment = { path: "main.go", content: "no metadata" };
  const omitted = JSON.stringify(withoutMetadata);
  expect(omitted).not.toContain("category");
  expect(omitted).not.toContain("severity");

  const withMetadata: LlmComment = {
    path: "main.go",
    content: "sql injection",
    category: "security",
    severity: "critical",
  };
  const serialized = JSON.stringify(withMetadata);
  expect(serialized).toContain(`"category":"security"`);
  expect(serialized).toContain(`"severity":"critical"`);
});

// OCR v1.9.3: TestCodeCommentProvider_Execute
test("CodeCommentProvider executes OCR success and error paths", async () => {
  const collector = NewCommentCollector();
  const provider = new CodeCommentProvider(collector);
  const result = await provider.Execute(undefined, {
    path: "main.go",
    comments: [{ content: "issue 1" }, { content: "issue 2" }],
  });
  expect(result).toBe(CommentSucceed);
  expect(collector.Comments().length).toBe(2);

  const withoutCollector = new CodeCommentProvider(null);
  const noCollectorResult = await withoutCollector.Execute(undefined, {
    path: "main.go",
    comments: [{ content: "x" }],
  });
  expect(noCollectorResult).not.toBe(CommentSucceed);

  const invalidCollector = NewCommentCollector();
  const invalidProvider = new CodeCommentProvider(invalidCollector);
  expect(await invalidProvider.Execute(undefined, {})).not.toBe(CommentSucceed);

  expect(new CodeCommentProvider().Tool()).toBe(CodeComment);
});
