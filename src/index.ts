/**
 * Public package boundary — OCR v1.9.3 port only.
 * The legacy precision-oriented engine has been removed by explicit user
 * approval; the OCR tree under src/ocr is now the sole engine.
 * Pi sessions, runner adapters, prompts, and model-visible tool definitions
 * remain implementation details.
 */

export { review, createReviewer, Reviewer } from "./ocr/reviewer.js";

export { PiTransport, createPiTransportForFile } from "./ocr/pi-adapter/pi-transport.js";
export type { CreatePiTransportForFileOptions } from "./ocr/pi-adapter/pi-transport.js";
export { Runner as OcrRunner } from "./ocr/llmloop/loop.js";
export { runCli as runOcrCli } from "./ocr/cli/index.js";

export type {
  CandidateFinding,
  ChangedFile,
  DiffHunk,
  DiffLine,
  ExcludedFile,
  FailedFile,
  Finding,
  FindingCategory,
  FindingSeverity,
  ReviewCoverage,
  ReviewEvent,
  ReviewInput,
  ReviewMode,
  ReviewOptions,
  ReviewResult,
  ReviewStatus,
  ReviewTarget,
  ReviewUsage,
  SkippedFile,
  ThinkingLevel,
} from "./types.js";
