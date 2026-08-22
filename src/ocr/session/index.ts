// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/session/* at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Barrel for the OCR v1.9.3 session parity engine.
 *
 * Per-file provenance:
 * - `history.ts`  <- `internal/session/history.go`
 * - `manifest.ts` <- `internal/session/manifest.go`
 * - `persist.ts`  <- `internal/session/persist.go`
 * - `resume.ts`   <- `internal/session/resume.go`,
 *                    `resume_identity.go`, `list.go`, `comments.go`
 *
 * No legacy `src/session.ts` import; this is the parity path.
 */

// History
export {
  type TaskType,
  PlanTask,
  MainTask,
  MemoryCompressionTask,
  ReLocationTask,
  ReviewFilterTask,
  ReviewModeWorkspace,
  ReviewModeRange,
  ReviewModeCommit,
  ReviewModeFullScan,
  type TokenUsage as HistoryTokenUsage,
  type ResponseRecord,
  type ToolResultRecord,
  type Message as HistoryMessage,
  type SessionOptions,
  type ResumeInfo,
  SessionHistory,
  New,
  NewSessionHistory,
  FileSession,
  TaskRecord,
  generateUUID,
  type PersistHandle,
} from "./history.js";

// Manifest
export {
  MANIFEST_SCHEMA_VERSION,
  ManifestSchemaVersion,
  OPERATION_REVIEW,
  OperationReview,
  INPUT_MODE_RANGE,
  INPUT_MODE_COMMIT,
  INPUT_MODE_WORKSPACE,
  InputModeRange,
  InputModeCommit,
  InputModeWorkspace,
  validInputMode,
  type FailureClass,
  FailureProvider,
  FailureTimeout,
  FailureCancelled,
  FailureConfiguration,
  FailureInput,
  FailureBudget,
  FailurePanic,
  FailureUnknown,
  isValidFailureClass,
  type RunFailureClass,
  RunFailureInput,
  RunFailureConfiguration,
  RunFailureTimeout,
  RunFailureCancelled,
  RunFailureBudget,
  RunFailureInternal,
  RunFailureUnknown,
  isValidRunFailureClass,
  itemFailureForRunClass,
  type RunFailure,
  type TerminalState,
  StateComplete,
  StatePartial,
  StateFailed,
  StateSkipped,
  type CoverageItem,
  type Coverage,
  type ManifestRepository,
  type ManifestInput,
  type ManifestExecution,
  type RunManifest,
  normalizePath,
  ItemID,
  ManifestError,
  errNilBuilder,
  errFrozen,
  errSealed,
  errEmptyID,
  ManifestBuilder,
  NewManifestBuilder,
  emptyManifest,
} from "./manifest.js";

// Persist
export {
  sessionSubDir,
  encodeRepoPath,
  SessionsDir,
  SessionFilePath,
  type TokenUsage as PersistTokenUsage,
  JsonlWriter,
  newJSONLWriter,
  createMemoryWriter,
} from "./persist.js";

// Resume / listing / comments
export {
  ResumeLineageSchemaVersion,
  resumeHint,
  type ResumeItem,
  ResumeState,
  type RunIdentity,
  type ResumeRequest,
  explicitFlagHint,
  type ResumeLineage,
  NewResumeLineage,
  isResumeTransition,
  LoadResumeState,
  LoadReviewResumeState,
  type Summary,
  type ItemDetail,
  ListSessions,
  LoadSummary,
  LoadDetail,
  LoadComments,
} from "./resume.js";
