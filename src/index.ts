/**
 * Deliberately small package boundary.
 *
 * Pi sessions, runner adapters, prompts, and model-visible tool definitions
 * remain implementation details. Consumers get the review domain plus the
 * deterministic Git/diff/selection/placement seams that are useful without
 * importing Pi.
 */
export { DiffParseError, parseUnifiedDiff } from "./diff.js";
export { buildChangeMap, renderChangeMapSlice } from "./change-map.js";
export { createReviewTarget } from "./git.js";
export { resolveFinding } from "./resolver.js";
export { selectFiles } from "./selection.js";
export { Reviewer, createReviewer, review } from "./reviewer.js";

// Parity engine (experimental) — Pi SDK adapter is public and exercised by spikes + harness.
// The legacy Reviewer above remains the default CLI engine until cutover per docs/ocr-v1.9.3-port-plan.md Phase 9.
export { PiTransport, createPiTransportForFile } from "./ocr-v193/pi-adapter/pi-transport.js";
export type { CreatePiTransportForFileOptions } from "./ocr-v193/pi-adapter/pi-transport.js";
export { Runner as OcrRunner } from "./ocr-v193/llmloop/loop.js";
export { runCli as runOcrCli } from "./ocr-v193/cli/index.js";

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

export type {
	SelectionDecision,
	SelectionOptions,
	SelectionReason,
	SelectionResult,
} from "./selection.js";

export type {
	ChangeEdge,
	ChangeFact,
	ChangeMap,
	ChangeMapOptions,
	ChangeMapRenderOptions,
	DeclarationCategory,
	ReferenceSide,
} from "./change-map.js";
