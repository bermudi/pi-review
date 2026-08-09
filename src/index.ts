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

export type {
	CandidateFinding,
	ChangedFile,
	DiffHunk,
	DiffLine,
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
