// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/template/template_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { describe, expect, it } from "bun:test";

import {
  applyLanguage,
  applyLanguageMut,
  applyLanguageScanMut,
  completionTokenLimit,
  completionTokenLimitScan,
  loadDefaultScanTemplate,
  loadDefaultTemplate,
  validateScanTemplate,
  validateTemplate,
  type LlmConversation,
  type ScanTemplate,
  type Template,
} from "../../../src/ocr-v193/template/template.js";

const emptyConversation = (): LlmConversation => ({ messages: [] });

function templateFixture(overrides: Partial<Template> = {}): Template {
  return {
    MainTask: emptyConversation(),
    MemoryCompressionTask: emptyConversation(),
    MaxTokens: 0,
    MaxToolRequestTimes: 0,
    PlanModeLineThreshold: 0,
    ...overrides,
  };
}

function scanTemplateFixture(overrides: Partial<ScanTemplate> = {}): ScanTemplate {
  return {
    MainTask: emptyConversation(),
    MemoryCompressionTask: emptyConversation(),
    MaxTokens: 0,
    ToolRequestWaitTimeMs: 0,
    MaxToolRequestTimes: 0,
    MaxSubtaskExecMinutes: 0,
    ...overrides,
  };
}

const systemConversation = (content = "x"): LlmConversation => ({
  messages: [{ role: "system", content }],
});

describe("ocr-v193 template", () => {
  // OCR v1.9.3: TestLoadScanDefault_BudgetParsed
  it("loads the scan budget and main task", () => {
    const tpl = loadDefaultScanTemplate();

    expect(tpl.MaxToolRequestTimes).toBeGreaterThanOrEqual(60);
    expect(tpl.MainTask.messages.length).toBeGreaterThan(0);
    expect(tpl.MaxFileSizeBytes ?? 0).toBeGreaterThan(0);
  });

  // OCR v1.9.3: TestApplyLanguage_ScanTemplate
  it("applies language to scan MainTask system messages", () => {
    const tpl = loadDefaultScanTemplate();
    applyLanguageScanMut(tpl, "Spanish");

    for (const message of tpl.MainTask.messages) {
      if (message.role !== "system") continue;
      expect(message.content).toContain("Always respond in Spanish.");
    }
  });

  // OCR v1.9.3: TestLoadDefault_HasNoScanFields
  it("loads the review template's populated main task and tool budget", () => {
    const tpl = loadDefaultTemplate();

    expect(tpl.MainTask.messages.length).toBeGreaterThan(0);
    expect(tpl.MaxToolRequestTimes).toBeGreaterThan(0);
  });

  // OCR v1.9.3: TestCompletionTokenLimit
  it("uses runtime completion limits and falls back to max tokens", () => {
    const review = templateFixture({ MaxTokens: 200_000 });
    expect(completionTokenLimit(review)).toBe(200_000);

    const limitedReview = { ...review, MaxCompletionTokens: 58_888 };
    expect(completionTokenLimit(limitedReview)).toBe(58_888);

    const scan = scanTemplateFixture({
      MaxTokens: 128_000,
      MaxCompletionTokens: 4_096,
    });
    expect(completionTokenLimitScan(scan)).toBe(4_096);
  });

  // OCR v1.9.3: TestLoadDefault_FieldsPopulated
  it("loads all expected default review fields", () => {
    const tpl = loadDefaultTemplate();

    expect(tpl.MainTask.messages).toHaveLength(2);
    for (const message of tpl.MainTask.messages) {
      expect(message.content).not.toBe("");
    }
    expect(tpl.PlanTask).toBeDefined();
    expect(tpl.PlanTask?.messages).toHaveLength(2);
    expect(tpl.ReLocationTask).toBeDefined();
    expect(tpl.ReviewFilterTask).toBeDefined();
    expect(tpl.MaxTokens).toBe(58_888);
    expect(tpl.MaxToolRequestTimes).toBe(30);
    expect(tpl.PlanModeLineThreshold).toBe(50);
  });

  // OCR v1.9.3: TestLoadDefault_PlaceholdersPresent
  it("preserves placeholders in the default review prompts", () => {
    const tpl = loadDefaultTemplate();
    const cases = [
      ["MainTask user has current_file_path", tpl.MainTask.messages[1]?.content, "{{current_file_path}}"],
      ["MainTask user has diff", tpl.MainTask.messages[1]?.content, "{{diff}}"],
      ["PlanTask system has plan_tools", tpl.PlanTask?.messages[0]?.content, "{{plan_tools}}"],
      [
        "MemoryCompression user has context",
        tpl.MemoryCompressionTask.messages[1]?.content,
        "{{context}}",
      ],
      [
        "ReviewFilter user has comments",
        tpl.ReviewFilterTask?.messages[1]?.content,
        "{{comments}}",
      ],
      [
        "ReLocation user has diff (single brace)",
        tpl.ReLocationTask?.messages[1]?.content,
        "{diff}",
      ],
    ] as const;

    for (const [name, content, placeholder] of cases) {
      expect(content, name).toContain(placeholder);
    }
  });

  // OCR v1.9.3: TestValidate_PassesOnDefault
  it("validates the default review template", () => {
    const tpl = loadDefaultTemplate();
    expect(() => validateTemplate(tpl)).not.toThrow();
  });

  // OCR v1.9.3: TestApplyLanguage
  it("appends language to review system messages", () => {
    const tpl = loadDefaultTemplate();
    applyLanguageMut(tpl, "Chinese");
    const suffix = "\n\nAlways respond in Chinese.";

    expect(tpl.MainTask.messages[0]?.content).toEndWith(suffix);
    expect(tpl.PlanTask?.messages[0]?.content).toEndWith(suffix);
    expect(tpl.MemoryCompressionTask.messages[0]?.content).toEndWith(suffix);
  });

  // OCR v1.9.3: TestApplyLanguage_DefaultEnglish
  // OCR v1.9.3: TestApplyLanguage_EmptyLang
  it("defaults an empty language to English", () => {
    const tpl = loadDefaultTemplate();
    applyLanguageMut(tpl, "");
    const suffix = "\n\nAlways respond in English.";

    expect(tpl.MainTask.messages[0]?.content).toEndWith(suffix);
  });

  // OCR v1.9.3: TestValidate_Template_Errors
  it("rejects invalid review templates with the expected errors", () => {
    const cases: ReadonlyArray<readonly [string, Template, string]> = [
      [
        "zero MaxTokens",
        templateFixture({
          MaxTokens: 0,
          MaxToolRequestTimes: 1,
          MainTask: systemConversation(),
        }),
        "max_tokens must be positive",
      ],
      [
        "negative MaxTokens",
        templateFixture({
          MaxTokens: -1,
          MaxToolRequestTimes: 1,
          MainTask: systemConversation(),
        }),
        "max_tokens must be positive",
      ],
      [
        "zero MaxToolRequestTimes",
        templateFixture({
          MaxTokens: 100,
          MaxToolRequestTimes: 0,
          MainTask: systemConversation(),
        }),
        "max_tool_request_times must be positive",
      ],
      [
        "empty MainTask messages",
        templateFixture({
          MaxTokens: 100,
          MaxToolRequestTimes: 1,
          MainTask: emptyConversation(),
        }),
        "main_task.messages must not be empty",
      ],
    ];

    for (const [name, tpl, wanted] of cases) {
      expect(() => validateTemplate(tpl), name).toThrow(wanted);
    }
  });

  // OCR v1.9.3: TestValidate_ScanTemplate
  it("validates scan templates and rejects invalid fields", () => {
    const valid = scanTemplateFixture({
      MaxTokens: 100,
      MaxToolRequestTimes: 1,
      MainTask: systemConversation(),
    });
    expect(() => validateScanTemplate(valid)).not.toThrow();

    const cases: ReadonlyArray<readonly [string, ScanTemplate, string]> = [
      [
        "zero MaxTokens",
        scanTemplateFixture({
          MaxTokens: 0,
          MaxToolRequestTimes: 1,
          MainTask: systemConversation(),
        }),
        "scan: max_tokens must be positive",
      ],
      [
        "zero MaxToolRequestTimes",
        scanTemplateFixture({
          MaxTokens: 100,
          MaxToolRequestTimes: 0,
          MainTask: systemConversation(),
        }),
        "scan: max_tool_request_times must be positive",
      ],
      [
        "empty MainTask messages",
        scanTemplateFixture({
          MaxTokens: 100,
          MaxToolRequestTimes: 1,
          MainTask: emptyConversation(),
        }),
        "scan: main_task.messages must not be empty",
      ],
    ];

    for (const [name, tpl, wanted] of cases) {
      expect(() => validateScanTemplate(tpl), name).toThrow(wanted);
    }
  });

  // OCR v1.9.3: TestLoadScanDefault_Validate
  it("validates the loaded default scan template", () => {
    const tpl = loadDefaultScanTemplate();
    expect(() => validateScanTemplate(tpl)).not.toThrow();
  });

  // OCR v1.9.3: TestApplyLanguage_ScanTemplate_AllOptionalTasks
  it("applies language to every scan task", () => {
    const tpl = loadDefaultScanTemplate();
    expect(tpl.DedupTask).toBeDefined();
    expect(tpl.ProjectSummaryTask).toBeDefined();

    applyLanguageScanMut(tpl, "Japanese");
    const suffix = "Always respond in Japanese.";
    const tasks: ReadonlyArray<readonly [string, LlmConversation | undefined]> = [
      ["MainTask", tpl.MainTask],
      ["PlanTask", tpl.PlanTask],
      ["DedupTask", tpl.DedupTask],
      ["ProjectSummaryTask", tpl.ProjectSummaryTask],
      ["MemoryCompressionTask", tpl.MemoryCompressionTask],
    ];

    for (const [name, conversation] of tasks) {
      if (conversation === undefined) continue;
      for (const message of conversation.messages) {
        if (message.role === "system") {
          expect(message.content, name).toContain(suffix);
        }
      }
    }
  });

  // OCR v1.9.3: TestApplyLanguage_ScanTemplate_NilOptionalTasks
  it("applies scan language when optional tasks are absent", () => {
    const tpl = scanTemplateFixture({
      MainTask: systemConversation("base"),
      MemoryCompressionTask: systemConversation("compress"),
    });
    applyLanguageScanMut(tpl, "Korean");
    const suffix = "Always respond in Korean.";

    expect(tpl.MainTask.messages[0]?.content).toContain(suffix);
    expect(tpl.MemoryCompressionTask.messages[0]?.content).toContain(suffix);
  });

  // OCR v1.9.3: TestApplyLanguage_SkipsNonSystemMessages
  it("does not apply language to non-system messages", () => {
    const tpl = templateFixture({
      MainTask: {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "usr" },
        ],
      },
      MemoryCompressionTask: systemConversation("sys"),
    });
    applyLanguageMut(tpl, "French");

    expect(tpl.MainTask.messages[1]?.content).not.toContain("French");
  });

  // OCR v1.9.3: TestResolveLang
  it("resolves empty and explicit languages", () => {
    // Module-boundary adaptation: exercise OCR's private resolveLang helper
    // through the public ApplyLanguage behavior that consumes its result.
    const tpl = templateFixture({
      MainTask: systemConversation(),
      MemoryCompressionTask: systemConversation(),
    });

    expect(applyLanguage(tpl, "").MainTask.messages[0]?.content).toEndWith(
      "Always respond in English.",
    );
    expect(applyLanguage(tpl, "German").MainTask.messages[0]?.content).toEndWith(
      "Always respond in German.",
    );
  });
});
