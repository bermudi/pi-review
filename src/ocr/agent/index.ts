// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/* at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Barrel for the OCR v1.9.3 diff-review agent port.
 *
 * No import from legacy `src/reviewer.ts` policy — this is the parity engine.
 * Keep file selection, exclude, budget, preview, concurrency, and per-file loop
 * dispatch semantics aligned with Go where feasible; model calls flow through
 * the `LlmTransport` seam in `src/ocr/llmloop`.
 */

// Core orchestration — internal/agent/agent.go
export {
  Agent,
  newAgent,
  New,
  hashFields,
  reviewItemFingerprint,
  manifestItemID,
  manifestPaths,
  NewCommentWorkerPool,
  newCommentWorkerPool,
  errMainTaskEmpty,
  ErrMainTaskEmpty,
  errDeadlineExceeded,
  ErrDeadlineExceeded,
  errCanceled,
  ErrCanceled,
  classifyItemError,
  ClassifyItemError,
  normalizeDiff,
} from "./agent.js";
export type { Args, RuntimeConfig, SystemRuleResolver, ToolRegistryLike, CommentCollectorLike } from "./agent.js";

// Identity — internal/agent/identity.go
export { resolveIdentity, ResolveIdentity, sourceArtifactSHA256For } from "./identity.js";
export type { InputResolution, RunIdentity, SealedInput, ResolveIdentityArgs } from "./identity.js";

// Estimate — internal/agent/estimate.go
export {
  promptOverheadTokens,
  avgMainRoundsPerFile,
  avgOutputTokensPerRound,
  estimateDiffFileTokens,
  estimateDiffCost,
  humanTokens,
  estimateToString,
  createEstimate,
} from "./estimate.js";
export type { Estimate } from "./estimate.js";

// Preview — internal/agent/preview.go
export { whyExcluded, effectivePath, diffStatus, previewDiffs } from "./preview.js";
export type { PreviewDeps } from "./preview.js";
export {
  ExcludeNone,
  ExcludeUserRule,
  ExcludeExtension,
  ExcludeDefaultPath,
  ExcludeDeleted,
  ExcludeBinary,
} from "./preview.js";
export type { ExcludeReason } from "./preview.js";

// Util — internal/agent/util.go
export {
  planBlockPattern,
  stripEmptyPlanBlock,
  StripMarkdownFences,
  stripMarkdownFences,
  buildMessageXML,
  copyMessages,
  countMessagesTokens,
  CountMessagesTokens,
  ReviewModeWorkspace,
  ReviewModeRange,
  ReviewModeCommit,
  reviewModeString,
  ReviewModeString,
  detectGitBranch,
} from "./util.js";
export type { ReviewMode } from "./util.js";
