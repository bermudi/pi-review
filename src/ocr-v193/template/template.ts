// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/template/template.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * OCR v1.9.3 template loader — TypeScript port of internal/config/template/template.go.
 *
 * Responsibilities:
 * - Loads the embedded task and scan prompt templates (verbatim imports of
 *   task_template.json / scan_template.json + prompts/*.md per the hash-frozen
 *   reference manifest).
 * - Validates required fields (MaxTokens, MaxToolRequestTimes, MainTask).
 * - Applies language directives to system messages (ApplyLanguage).
 * - Exposes CompletionTokenLimit logic and hash-frozen provenance checks.
 *
 * No import from legacy src/prompts.ts — this is the parity path.
 *
 * Prompt files are verbatim copies of the upstream markdown; their provenance
 * is recorded in the adjacent PROVENANCE.json / prompts/PROVENANCE.json and
 * this file's frozen hash table — not inside the prompt bytes (model input must
 * stay byte-identical).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Frozen hashes — must match the pinned v1.9.3 checkout (4d796ae..., c35ddd...)
// computed via `sha256sum` on the original files. The loader verifies them
// on every LoadDefault call; `bun test` must fail if any prompt/template byte
// diverges.
// ---------------------------------------------------------------------------

export const EXPECTED_TASK_TEMPLATE_HASH =
  "1f54f497084962fb6584314fb33790a029fcaa363cffe47ba3631fd13b2a5b9f";

export const EXPECTED_SCAN_TEMPLATE_HASH =
  "19801e31f020751a30d4fc0d8dcf7657081312a79f612ce9bc67dcd874682a5d";

/**
 * SHA-256 of each verbatim prompt file as shipped in
 * internal/config/template/prompts/*.md at v1.9.3.
 *
 * Generation:
 *   sha256sum ../open-code-review/internal/config/template/prompts/*.md
 */
export const EXPECTED_PROMPT_HASHES: Readonly<Record<string, string>> = {
  "main_task_system.md":
    "0c347f143a928bfc87962b3a6c19743e59e6873c0441ec0b6776c35b035f924d",
  "main_task_user.md":
    "7f18be6a39269b694b7f692fb8bb657f731a3284c8f8a895ff00a424eec6d2a3",
  "memory_compression_task_system.md":
    "8af8c89594af3221e49154bb9ca7ee82be3550eec9bb033354e9d084f2c90b5e",
  "memory_compression_task_user.md":
    "d17923ad1281238a759f39dfcf2951d75b3893a494646b1164f7b903f840f56f",
  "plan_task_system.md":
    "94cc42ed55dac16fbfa166e91b747c34b7a1dde441614b8ddf1f6b171317219a",
  "plan_task_user.md":
    "3421c18fffbf1734e19c5cc8b1a31eaa5ea26f96e212472c9dd88a402689c8e5",
  "re_location_task_system.md":
    "4a7956f379ff49cac4251582931e35836516162edacac0ce74e81d9e48fa783f",
  "re_location_task_user.md":
    "a931857542a500c733dedd1090528e986c9bf1d4924d762645f79512411d2685",
  "review_filter_task_system.md":
    "5082e90fd7a6a78fae4d12c5e7ab26da95d937f7771670d78821576eb5facded",
  "review_filter_task_user.md":
    "2421fe5859e7a5f0b81b1c1497b0ed0108e401e4d879fb3b37548489908b33d5",
} as const;

// ---------------------------------------------------------------------------
// Domain types — mirror Go's Template / ScanTemplate / LlmConversation /
// ChatMessage with JSON-compatible field names. Go json tags use UPPER_SNAKE;
// we expose PascalCase (MainTask etc.) to match both the Go struct field
// names and the existing loop adapter (`deps.template.MaxTokens`).
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface LlmConversation {
  readonly messages: readonly ChatMessage[];
}

// Kept as interface with readonly fields; mirrors Go's Template struct.
// Field names match Go's exported fields (PascalCase) for compatibility with
// src/ocr-v193/llmloop/types.ts's minimal Template shape.
export interface Template {
  readonly MainTask: LlmConversation;
  readonly PlanTask?: LlmConversation | undefined;
  readonly MemoryCompressionTask: LlmConversation;
  readonly ReLocationTask?: LlmConversation | undefined;
  readonly ReviewFilterTask?: LlmConversation | undefined;
  readonly MaxTokens: number;
  /** Runtime-only output cap — when >0 overrides MaxTokens (mirrors Go's json:"-" field). */
  readonly MaxCompletionTokens?: number | undefined;
  readonly MaxToolRequestTimes: number;
  readonly PlanModeLineThreshold: number;
}

export interface ScanTemplate {
  readonly MainTask: LlmConversation;
  readonly PlanTask?: LlmConversation | undefined;
  readonly MemoryCompressionTask: LlmConversation;
  readonly ReLocationTask?: LlmConversation | undefined;
  readonly DedupTask?: LlmConversation | undefined;
  readonly ProjectSummaryTask?: LlmConversation | undefined;
  readonly MaxTokens: number;
  readonly MaxCompletionTokens?: number | undefined;
  readonly ToolRequestWaitTimeMs: number;
  readonly MaxToolRequestTimes: number;
  readonly MaxSubtaskExecMinutes: number;
  readonly MaxFileSizeBytes?: number | undefined;
  readonly MaxTokensBudget?: number | undefined;
  readonly BatchStrategy?: string | undefined;
  readonly BatchSize?: number | undefined;
  readonly DedupMinComments?: number | undefined;
}

// ---------------------------------------------------------------------------
// CompletionTokenLimit — mirrors Go (Template|ScanTemplate).CompletionTokenLimit()
// ---------------------------------------------------------------------------

export function completionTokenLimit(t: Template): number {
  if (t.MaxCompletionTokens !== undefined && t.MaxCompletionTokens > 0) {
    return t.MaxCompletionTokens;
  }
  return t.MaxTokens;
}

export function completionTokenLimitScan(t: ScanTemplate): number {
  if (t.MaxCompletionTokens !== undefined && t.MaxCompletionTokens > 0) {
    return t.MaxCompletionTokens;
  }
  return t.MaxTokens;
}

// Backwards aliases matching Go method names on the structs
export const CompletionTokenLimit = completionTokenLimit;
export const CompletionTokenLimitScan = completionTokenLimitScan;

// ---------------------------------------------------------------------------
// Language helpers — mirror Go's applyLanguage / resolveLang / ApplyLanguage
// ---------------------------------------------------------------------------

function resolveLang(lang: string): string {
  if (lang === "") return "English";
  return lang;
}

function applyLanguageToConversation(
  conv: LlmConversation,
  instruction: string,
): LlmConversation {
  return {
    messages: conv.messages.map((m) =>
      m.role === "system" ? { ...m, content: m.content + instruction } : m,
    ),
  };
}

export function applyLanguage(t: Template, lang: string): Template {
  const instruction = `\n\nAlways respond in ${resolveLang(lang)}.`;
  return {
    ...t,
    MainTask: applyLanguageToConversation(t.MainTask, instruction),
    PlanTask: t.PlanTask
      ? applyLanguageToConversation(t.PlanTask, instruction)
      : undefined,
    MemoryCompressionTask: applyLanguageToConversation(
      t.MemoryCompressionTask,
      instruction,
    ),
  };
}

export function applyLanguageScan(t: ScanTemplate, lang: string): ScanTemplate {
  const instruction = `\n\nAlways respond in ${resolveLang(lang)}.`;
  return {
    ...t,
    MainTask: applyLanguageToConversation(t.MainTask, instruction),
    PlanTask: t.PlanTask
      ? applyLanguageToConversation(t.PlanTask, instruction)
      : undefined,
    DedupTask: t.DedupTask
      ? applyLanguageToConversation(t.DedupTask, instruction)
      : undefined,
    ProjectSummaryTask: t.ProjectSummaryTask
      ? applyLanguageToConversation(t.ProjectSummaryTask, instruction)
      : undefined,
    MemoryCompressionTask: applyLanguageToConversation(
      t.MemoryCompressionTask,
      instruction,
    ),
  };
}

// Mutating variants that match Go's pointer-receiver ApplyLanguage semantics
// (Go mutates in place). We provide both functional (above) and mutating
// helpers for callers that hold a mutable object.

export function applyLanguageMut(t: Template, lang: string): void {
  const updated = applyLanguage(t, lang);
  // Mutate the original object's nested conversations in place to mimic Go.
  // Since Template fields are readonly we cast to mutable for this helper.
  const mut = t as unknown as {
    MainTask: LlmConversation;
    PlanTask?: LlmConversation;
    MemoryCompressionTask: LlmConversation;
  };
  mut.MainTask = updated.MainTask;
  mut.PlanTask = updated.PlanTask;
  mut.MemoryCompressionTask = updated.MemoryCompressionTask;
}

export function applyLanguageScanMut(t: ScanTemplate, lang: string): void {
  const updated = applyLanguageScan(t, lang);
  const mut = t as unknown as {
    MainTask: LlmConversation;
    PlanTask?: LlmConversation;
    DedupTask?: LlmConversation;
    ProjectSummaryTask?: LlmConversation;
    MemoryCompressionTask: LlmConversation;
  };
  mut.MainTask = updated.MainTask;
  mut.PlanTask = updated.PlanTask;
  mut.DedupTask = updated.DedupTask;
  mut.ProjectSummaryTask = updated.ProjectSummaryTask;
  mut.MemoryCompressionTask = updated.MemoryCompressionTask;
}

// ---------------------------------------------------------------------------
// Validation — mirrors Go (Template).Validate() / (ScanTemplate).Validate()
// ---------------------------------------------------------------------------

export function validateTemplate(t: Template): void {
  if (t.MaxTokens <= 0) {
    throw new Error("max_tokens must be positive");
  }
  if (t.MaxToolRequestTimes <= 0) {
    throw new Error("max_tool_request_times must be positive");
  }
  if (t.MainTask.messages.length === 0) {
    throw new Error("main_task.messages must not be empty");
  }
}

export function validateScanTemplate(t: ScanTemplate): void {
  if (t.MaxTokens <= 0) {
    throw new Error("scan: max_tokens must be positive");
  }
  if (t.MaxToolRequestTimes <= 0) {
    throw new Error("scan: max_tool_request_times must be positive");
  }
  if (t.MainTask.messages.length === 0) {
    throw new Error("scan: main_task.messages must not be empty");
  }
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Uint8Array | Buffer): string {
  const h = crypto.createHash("sha256");
  if (typeof data === "string") h.update(Buffer.from(data, "utf-8"));
  else h.update(data);
  return h.digest("hex");
}

function sha256HexFile(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return sha256Hex(bytes);
}

function verifyFileHash(filePath: string, expected: string, label: string): void {
  const actual = sha256HexFile(filePath);
  if (actual !== expected) {
    throw new Error(
      `hash mismatch for ${label}: expected ${expected}, got ${actual} (file: ${filePath})`,
    );
  }
}

export function verifyAllPromptHashes(promptsDir: string): void {
  for (const [name, expected] of Object.entries(EXPECTED_PROMPT_HASHES)) {
    const full = path.join(promptsDir, name);
    if (!fs.existsSync(full)) {
      throw new Error(`missing prompt file ${name} at ${full}`);
    }
    verifyFileHash(full, expected, `prompt ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Internal manifest types for task_template.json — mirrors Go's
// templateManifest / manifestMessage / manifestConversation which reference
// prompt files by name.
// ---------------------------------------------------------------------------

interface ManifestMessage {
  role: string;
  prompt_file: string;
}

interface ManifestConversation {
  messages: ManifestMessage[];
}

interface TaskTemplateManifest {
  MAIN_TASK: ManifestConversation;
  PLAN_TASK?: ManifestConversation;
  MEMORY_COMPRESSION_TASK: ManifestConversation;
  RE_LOCATION_TASK?: ManifestConversation;
  REVIEW_FILTER_TASK?: ManifestConversation;
  MAX_TOKENS: number;
  MAX_TOOL_REQUEST_TIMES: number;
  PLAN_MODE_LINE_THRESHOLD: number;
}

function trimTrailingCRLF(s: string): string {
  // Mirrors Go strings.TrimRight(string(data), "\r\n")
  return s.replace(/[\r\n]+$/g, "");
}

function resolveConversation(
  m: ManifestConversation,
  promptsDir: string,
): LlmConversation {
  const messages: ChatMessage[] = m.messages.map((mm) => {
    const filePath = path.join(promptsDir, mm.prompt_file);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (e) {
      throw new Error(
        `read prompt file ${JSON.stringify(mm.prompt_file)}: ${String((e as Error).message)}`,
      );
    }
    // Verify hash over raw bytes exactly (byte-identical import).
    const expected = (EXPECTED_PROMPT_HASHES as Record<string, string>)[mm.prompt_file];
    if (expected !== undefined) {
      const actualBytesHash = sha256Hex(bytes);
      if (actualBytesHash !== expected) {
        throw new Error(
          `hash mismatch for prompt ${mm.prompt_file}: expected ${expected}, got ${actualBytesHash}`,
        );
      }
    }
    const raw = bytes.toString("utf-8");
    return {
      role: mm.role,
      content: trimTrailingCRLF(raw),
    };
  });
  return { messages };
}

function resolveOptionalConversation(
  m: ManifestConversation | undefined,
  promptsDir: string,
  name: string,
): LlmConversation | undefined {
  if (m === undefined || m === null) return undefined;
  try {
    return resolveConversation(m, promptsDir);
  } catch (e) {
    throw new Error(`${name}: ${String((e as Error).message)}`);
  }
}

// ---------------------------------------------------------------------------
// Task template loader
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /** Override directory containing task-template.json (default: directory of this file). */
  templateDir?: string;
  /** Override directory containing prompts/*.md (default: templateDir/prompts). */
  promptsDir?: string;
  /** When false, skip hash verification (useful for tests with fixtures). */
  verifyHashes?: boolean;
}

function resolveTemplateDir(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const candidates: string[] = [];
  const maybeDir = (import.meta as unknown as { dir?: string }).dir;
  if (maybeDir !== undefined) candidates.push(maybeDir);
  // When running from dist (bundled), the prompts live in src/ocr-v193/template
  candidates.push(path.join(process.cwd(), "src/ocr-v193/template"));
  // Also try relative to this file's cwd fallback
  candidates.push(path.resolve("src/ocr-v193/template"));

  for (const c of candidates) {
    const probe = path.join(c, "task-template.json");
    if (fs.existsSync(probe)) return c;
  }
  // Default to first candidate or cwd src path
  return candidates[0] ?? path.join(process.cwd(), "src/ocr-v193/template");
}

export function loadDefaultTemplate(opts: LoadOptions = {}): Template {
  const templateDir = resolveTemplateDir(opts.templateDir);
  const promptsDir = opts.promptsDir ?? path.join(templateDir, "prompts");
  const verifyHashes = opts.verifyHashes ?? true;

  const manifestPath = path.join(templateDir, "task-template.json");
  let rawJson: string;
  try {
    rawJson = fs.readFileSync(manifestPath, "utf-8");
  } catch (e) {
    throw new Error(`read embedded task-template.json: ${String((e as Error).message)}`);
  }

  if (verifyHashes) {
    verifyFileHash(manifestPath, EXPECTED_TASK_TEMPLATE_HASH, "task-template.json");
    verifyAllPromptHashes(promptsDir);
  }

  return parseTaskTemplateManifest(rawJson, promptsDir, verifyHashes);
}

export function parseTaskTemplateManifest(
  jsonText: string,
  promptsDir: string,
  verifyHashes = true,
): Template {
  let m: TaskTemplateManifest;
  try {
    m = JSON.parse(jsonText) as TaskTemplateManifest;
  } catch (e) {
    throw new Error(`unmarshal task_template manifest: ${String((e as Error).message)}`);
  }

  const tpl: Template = {
    MaxTokens: m.MAX_TOKENS,
    MaxToolRequestTimes: m.MAX_TOOL_REQUEST_TIMES,
    PlanModeLineThreshold: m.PLAN_MODE_LINE_THRESHOLD,
    MainTask: resolveConversation(m.MAIN_TASK, promptsDir),
    PlanTask: resolveOptionalConversation(m.PLAN_TASK, promptsDir, "PLAN_TASK"),
    MemoryCompressionTask: resolveConversation(m.MEMORY_COMPRESSION_TASK, promptsDir),
    ReLocationTask: resolveOptionalConversation(m.RE_LOCATION_TASK, promptsDir, "RE_LOCATION_TASK"),
    ReviewFilterTask: resolveOptionalConversation(
      m.REVIEW_FILTER_TASK,
      promptsDir,
      "REVIEW_FILTER_TASK",
    ),
  };

  if (verifyHashes) {
    // Also ensure any prompt referenced but not in expected table is at least present
    // (allows future prompts to be added with an updated table).
  }

  return tpl;
}

// ---------------------------------------------------------------------------
// Scan template loader — mirrors Go LoadScanDefault() which unmarshals
// scan_template.json directly (no prompt_file indirection; content is inline).
// ---------------------------------------------------------------------------

/** Internal raw shape of scan_template.json as written upstream. */
interface ScanRawConversation {
  messages: Array<{ role: string; content: string; timeout?: number }>;
  timeout?: number;
}

interface ScanTemplateRaw {
  MAIN_TASK: ScanRawConversation;
  PLAN_TASK?: ScanRawConversation;
  DEDUP_TASK?: ScanRawConversation;
  PROJECT_SUMMARY_TASK?: ScanRawConversation;
  MEMORY_COMPRESSION_TASK: ScanRawConversation;
  RE_LOCATION_TASK?: ScanRawConversation;
  MAX_TOKENS: number;
  MAX_TOOL_REQUEST_TIMES: number;
  TOOL_REQUEST_WAIT_TIME_MS: number;
  MAX_SUBTASK_EXECUTION_TIME_MINUTES: number;
  MAX_FILE_SIZE_BYTES?: number;
  MAX_TOKENS_BUDGET?: number;
  BATCH_STRATEGY?: string;
  BATCH_SIZE?: number;
  DEDUP_MIN_COMMENTS?: number;
}

function toConversation(raw: ScanRawConversation | undefined): LlmConversation | undefined {
  if (raw === undefined) return undefined;
  return {
    messages: raw.messages.map((mm) => ({
      role: mm.role,
      content: mm.content,
    })),
  };
}

export function parseScanTemplate(jsonText: string): ScanTemplate {
  let raw: ScanTemplateRaw;
  try {
    raw = JSON.parse(jsonText) as ScanTemplateRaw;
  } catch (e) {
    throw new Error(`unmarshal default scan template: ${String((e as Error).message)}`);
  }

  const tpl: ScanTemplate = {
    MaxTokens: raw.MAX_TOKENS,
    MaxToolRequestTimes: raw.MAX_TOOL_REQUEST_TIMES,
    ToolRequestWaitTimeMs: raw.TOOL_REQUEST_WAIT_TIME_MS,
    MaxSubtaskExecMinutes: raw.MAX_SUBTASK_EXECUTION_TIME_MINUTES,
    MaxFileSizeBytes: raw.MAX_FILE_SIZE_BYTES,
    MaxTokensBudget: raw.MAX_TOKENS_BUDGET,
    BatchStrategy: raw.BATCH_STRATEGY,
    BatchSize: raw.BATCH_SIZE,
    DedupMinComments: raw.DEDUP_MIN_COMMENTS,
    MainTask: toConversation(raw.MAIN_TASK)!,
    PlanTask: toConversation(raw.PLAN_TASK),
    MemoryCompressionTask: toConversation(raw.MEMORY_COMPRESSION_TASK)!,
    ReLocationTask: toConversation(raw.RE_LOCATION_TASK),
    DedupTask: toConversation(raw.DEDUP_TASK),
    ProjectSummaryTask: toConversation(raw.PROJECT_SUMMARY_TASK),
  };

  return tpl;
}

export function loadDefaultScanTemplate(opts: LoadOptions = {}): ScanTemplate {
  const templateDir = resolveTemplateDir(opts.templateDir);
  const verifyHashes = opts.verifyHashes ?? true;
  const manifestPath = path.join(templateDir, "scan-template.json");

  let rawJson: string;
  try {
    rawJson = fs.readFileSync(manifestPath, "utf-8");
  } catch (e) {
    throw new Error(`read embedded scan-template.json: ${String((e as Error).message)}`);
  }

  if (verifyHashes) {
    verifyFileHash(manifestPath, EXPECTED_SCAN_TEMPLATE_HASH, "scan-template.json");
  }

  return parseScanTemplate(rawJson);
}

// ---------------------------------------------------------------------------
// Convenience re-exports for callers that prefer the Go-style names
// (LoadDefault / LoadScanDefault).
// ---------------------------------------------------------------------------

export const LoadDefault = loadDefaultTemplate;
export const LoadScanDefault = loadDefaultScanTemplate;
export const Validate = validateTemplate;
export const ValidateScan = validateScanTemplate;
export const ApplyLanguage = applyLanguage;
export const ApplyLanguageScan = applyLanguageScan;
