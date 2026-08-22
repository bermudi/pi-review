// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/* at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Barrel for the OCR v1.9.3 scan parity engine.
 *
 * Per-file provenance:
 * - `batch.ts`    <- `internal/scan/batch.go`
 * - `estimate.ts` <- `internal/scan/estimate.go`
 * - `provider.ts` <- `internal/scan/provider.go`
 * - `preview.ts`  <- `internal/scan/preview.go`
 * - `scan.ts`     <- `internal/scan/agent.go` (orchestrator)
 *
 * No legacy `src/scan.ts` import; this is the parity path.
 */

// Batch
export {
  type BatchStrategy,
  BatchNone,
  BatchByLanguage,
  BatchByDirectory,
  parseBatchStrategy,
  ParseBatchStrategy,
  groupBatches,
  GroupBatches,
} from "./batch.js";

// Estimate
export {
  type Estimate,
  PROMPT_OVERHEAD_TOKENS,
  AVG_MAIN_ROUNDS_PER_FILE,
  AVG_OUTPUT_TOKENS_PER_ROUND,
  promptOverheadTokens,
  avgMainRoundsPerFile,
  avgOutputTokensPerRound,
  estimateFileTokens,
  EstimateFileTokens,
  estimateCost,
  EstimateCost,
  humanTokens,
  HumanTokens,
  estimateToString,
  EstimateString,
} from "./estimate.js";

// Provider
export {
  type ProviderOptions,
  Provider,
  NewProvider,
  newProvider,
  BINARY_SNIFF_WINDOW,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  binarySniffWindow,
  DefaultMaxFileSizeBytes,
} from "./provider.js";

// Preview
export {
  type PreviewArgs,
  previewScan,
  PreviewFn,
  preview,
} from "./preview.js";
export type { PreviewEntry } from "./preview.js";

// Scan orchestrator
export {
  type ScanArgs,
  Agent,
  NewAgent,
  newAgent,
  CHANGE_FILES_SCAN_LITERAL,
  changeFilesScanLiteral,
  scanItemFingerprint,
  resumedFromSession,
} from "./scan.js";
