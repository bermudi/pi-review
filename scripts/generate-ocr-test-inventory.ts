// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates the exhaustive OCR v1.9.9 upstream-test inventory. The upstream
// tree is read only through the pinned Git object; its working tree is ignored.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { extractGoTestDeclarations } from "../test/ocr/support/go-test-declarations.js";
import {
  activeReference,
  deltaByActiveTestId,
  generateOcrTestDelta,
  previousReference,
  type DeltaKind,
  type OcrTestDelta,
} from "./generate-ocr-test-delta.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRepo = resolve(repoRoot, "../open-code-review");
const inventoryPath = resolve(repoRoot, "docs/ocr-upstream-test-inventory.json");

const reference = activeReference;

type Area =
  | "agent"
  | "cli-output"
  | "diff"
  | "git"
  | "llmloop"
  | "model"
  | "pi-adapter"
  | "rules"
  | "scan"
  | "session"
  | "template"
  | "tool";

interface Scope {
  readonly kind: "in_scope" | "out_of_scope" | "needs_decision";
  readonly area: string;
  readonly reason?: string;
}

export type OcrEvidenceVersion = "v1.9.3" | "v1.9.9";

export interface Evidence {
  readonly kind: "bun-test-annotation";
  readonly path: string;
  readonly title: string;
  /** OCR baseline whose semantics this directly attached test proves. */
  readonly ocrVersion: OcrEvidenceVersion;
}

interface LegacyEvidence {
  readonly kind: "bun-test-annotation";
  readonly path: string;
  readonly title: string;
}

type Disposition = "covered" | "equivalent" | "not_applicable" | "pending" | "pending_scope" | "out_of_scope";

interface InventoryTest {
  readonly name: string;
  readonly delta: Exclude<DeltaKind, "removed">;
  readonly disposition: Disposition;
  readonly evidence?: readonly Evidence[];
  readonly reason?: string;
}

interface InventoryFile {
  readonly path: string;
  readonly blob: string;
  readonly scope: Scope;
  readonly tests: readonly InventoryTest[];
}

interface Inventory {
  readonly schemaVersion: 3;
  readonly reference: typeof reference;
  readonly previousReference: typeof previousReference;
  readonly delta: {
    readonly path: "docs/ocr-upstream-test-delta.json";
    readonly totals: OcrTestDelta["totals"];
  };
  readonly files: readonly InventoryFile[];
}

interface LocalCoverage {
  readonly localPath: string;
  readonly upstreamPaths: readonly string[];
}

// Explicit per-test overrides for honest, machine-checked dispositions.
// Every entry must have an exact rationale or evidence; the generator
// validates that the key matches a real pinned test and that the
// disposition is allowed for the file's scope.
//
// - equivalent: covered by a specifically named existing unit or
//   packed black-box assertion (evidence path + title required).
// - not_applicable: Pi replaces the mechanism (reason must contain
//   "Pi replaces" or "not applicable" with concrete justification).
//
// Keep this table explicit — hidden source-code rules are not allowed
// to silently decide these categories.
const equivalentTests: ReadonlyMap<string, readonly LegacyEvidence[]> = new Map<string, readonly LegacyEvidence[]>([
  [
    "internal/llm/protocol_test.go::TestNormalizeProtocol",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/protocol.test.ts", title: "normalizeProtocol canonicalizes known protocols case-insensitively and trims" }],
  ],
  [
    "internal/llm/protocol_test.go::TestValidateProtocol",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/protocol.test.ts", title: "validateProtocol accepts canonical names and rejects others" }],
  ],
  [
    "internal/llm/protocol_test.go::TestValidateProtocol_ErrorMessageListsAllProtocols",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/protocol.test.ts", title: "validateProtocol error message enumerates every canonical protocol" }],
  ],
  [
    "internal/llm/client_test.go::TestStripThinkTags",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/strip-think-tags.test.ts", title: "stripThinkTags removes think wrapper tags globally" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_StripsThinkTags",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/strip-think-tags.test.ts", title: "ChatResponse content strips think tags before trimming" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_FallbackToReasoning",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/strip-think-tags.test.ts", title: "content empty falls back to reasoning content" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildToolInputSchema",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/tool-schema.test.ts", title: "buildToolInputSchema preserves object-root guarantees and filters required" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildToolInputSchema_Empty",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/tool-schema.test.ts", title: "buildToolInputSchema empty input stays empty" }],
  ],
  [
    "internal/llm/message_test.go::TestNewTextMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "newTextMessage creates user message with role and content" }],
  ],
  [
    "internal/llm/message_test.go::TestNewToolCallMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "tool call message preserves tool calls and copies" }],
  ],
  [
    "internal/llm/message_test.go::TestNewToolCallMessage_NilCalls",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "tool call message with no tool_calls has undefined or empty" }],
  ],
  [
    "internal/llm/message_test.go::TestNewToolResultMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "tool result message has tool role and call id" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_String",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "extractText returns string content verbatim" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_ContentBlocks",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "extractText concatenates content blocks" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_NestedContentBlocks",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "extractText handles nested content blocks" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_NilContent",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "extractText empty content returns empty" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "ChatResponse content mirrors extractText for assistant message" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_ToolCalls",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "ChatResponse toolCalls extracted from toolCall blocks" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageOpenAICompatibleCachedTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/usage.test.ts", title: "mapPiUsage maps OpenAI cached tokens as cacheRead without double counting total" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageWrappedCachedTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/usage.test.ts", title: "mapPiUsage maps cache write via cacheWrite" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageWrappedAnthropicCompatibleCacheTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/usage.test.ts", title: "mapPiUsage maps Anthropic separate cache and total" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageResponsesAPIFieldNames",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/usage.test.ts", title: "mapPiUsage handles Responses API via Pi normalized input/output" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingUsage",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/usage.test.ts", title: "PiTransport captures streaming usage via turn_end assistant message" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_Empty",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/usage.test.ts", title: "empty Pi usage object yields undefined" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_NilContent",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "ChatResponse nil content falls back to reasoning" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_ToolCalls_Empty",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "ChatResponse empty toolCalls returns empty array" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_Default",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/message.test.ts", title: "extractText default non-string returns empty" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildOpenAIParams_AllRoles",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/build-params.test.ts", title: "ChatRequest role handling covers system/user/tool/assistant/unknown via Pi translation" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildOpenAIParams_Minimal",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/build-params.test.ts", title: "ChatRequest minimal tools stays unset" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildAnthropicParams_DefaultMaxTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/build-params.test.ts", title: "anthropic default maxTokens fallback is handled via Pi model defaults" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildAnthropicParams_InvalidToolArgs",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/build-params.test.ts", title: "invalid tool call arguments are handled without throwing" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildAnthropicParams_AllRoles",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/build-params.test.ts", title: "anthropic role branches mirror openai via Pi translation" }],
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_ContextSessionKeyOverridesFallback",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_SessionKeyExpandedInExtraHeadersAndBody",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestNewLLMClient_ExpandsSessionKeyInExtraBody",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_ContextSessionKeyOverridesFallback",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_SessionKeyExpandedInExtraBody",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_SessionKeyExpandedInExtraHeaders",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_SessionKeyGeneratedWhenEmpty",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_NoInjectionWithoutPlaceholder",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingCancellation",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter.test.ts", title: "PiTransport forwards abort signal to session.abort" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestNewSessionKey",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-key.test.ts", title: "newSessionKey returns UUIDv4 and uniqueness" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestSessionTaskKey",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-key.test.ts", title: "sessionTaskKey derives task-scoped keys with hash" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestExpandSessionKeyInHeaders",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-key.test.ts", title: "expandSessionKeyInHeaders replaces placeholder without mutating input" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestExpandSessionKeyInBody",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-key.test.ts", title: "expandSessionKeyInBody replaces recursively without mutating" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestSessionKeyContext",
    [{ kind: "bun-test-annotation", path: "test/ocr/pi-adapter/session-key.test.ts", title: "sessionTaskKey override semantics via sessionId" }],
  ],

// ---- retry meta: deterministic metadata/hash contracts (transport-independent) ----
  [
    "internal/llm/retry_meta_test.go::TestRequestMetaValid",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "RequestMeta valid cases" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDIsDeterministic",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "logicalRequestID is deterministic and 64 hex chars" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDSeparatesFields",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "logicalRequestID separates fields" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDVariesWithRunIDAndRequestNo",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "logicalRequestID varies with runId and requestNo" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDCanonicalEncoding",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "logicalRequestID canonical encoding" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestRequestMetaDescribe",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "describeRequestMeta contains file/task/request_no" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestWithRequestMeta",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/meta.test.ts", title: "withRequestMeta round trip" }],
  ],
  // ---- retry boundary: error/status/body truncation and boundary classification ----
  [
    "internal/llm/retry_boundary_test.go::TestClassifyBoundaryError",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "classifyBoundaryError contracts" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestClassifyStreamError",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "classifyStreamError always returns classification" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestStreamIntegrityErrorMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "StreamIntegrityError message" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestFinalizeRequestWithPanicSentinel",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "finalizeRequest with panic sentinel produces failed" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryHelpersAreInertWithoutCollectorOrMeta",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "boundary helpers are inert without collector or meta" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsTruncatedResponse",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "reviseAttempt corrects truncated response" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryKeepsHTTPClassOnCorruptErrorBody",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "reviseAttempt keeps HTTP class when already error" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsDecodeFailure",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "decode failure correction is unknown/response_decode" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsMidStreamFailure",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "responses status correction maps to provider/response_status" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryKeepsHTTPClassOnStreamThatNeverOpened",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "reviseAttempt keeps HTTP class when already error" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsResponsesStatus",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "responses status correction maps to provider/response_status" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCancelDuringBackoffIsCancelled",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "finalize decides cancelled vs failed correctly" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryRetryAfterOutlivingAttemptTimeoutIsFailed",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "deadline exceeded is failed not cancelled" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryDeadlineExceededIsFailed",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "deadline exceeded is failed not cancelled" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundarySkipsRequestWithoutAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "boundary skips request without attempt" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryKeepsTruncationCorrectionWhenRecallIsCancelled",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/boundary.test.ts", title: "truncation correction kept through cancellation semantics" }],
  ],
  // ---- retry report ----
  [
    "internal/llm/retry_report_test.go::TestErrorClassAndFailurePhaseSets",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "errorClass and failurePhase sets are fixed" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestClassifyAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "classifyAttempt maps status and errors" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestClassifyAttemptTwoHundredFallsThroughToError",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "classify 200 falls through to error via EOF" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFinalizeDecisionOrder",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "finalize decision order" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptNumbersAndDerivesOutcome",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "recordAttempt numbers and derives outcome" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptDerivesTimings",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "recordAttempt derives timings" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptFloorsInvertedTimestamps",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "recordAttempt floors inverted timestamps" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeAggregatesAndSorts",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze aggregates and sorts by logicalRequestId" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeReturnsNothingWhenNoRetryHappened",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze returns nothing when no retry happened" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeRejectsInvalidRunID",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze rejects invalid runId" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeRejectsOrderingViolations",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze rejects ordering violations (double finalize)" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeErrorIdentifiesTheRequest",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze error identifies request" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeErrorIsDeterministic",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze deterministic error on duplicate violation" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeListsCancelledRequestWithoutErrorAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze lists cancelled request without error attempt" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeRefusesEntryWithNoAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze refuses entry with no attempt" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestCollectorRejectsInvalidInput",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "collector rejects invalid input" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestProviderIsEmittedEvenWhenEmpty",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "provider empty is still emitted" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptRejectsUnclassifiedErrorStatus",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "recordAttempt rejects unclassified error status" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestReviseLastAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "reviseLastAttempt only revises success" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRetryCollectorConcurrentUse",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "retryCollector concurrent use" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRetryReportHasNoUnexpectedTextFields",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "retry report has no unexpected text fields" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestValidateReportCatchesInconsistency",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "validate report catches inconsistency via Freeze" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeSucceededRequestWithExtraAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze succeeded request with extra attempt" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFinalizeZeroAttemptProducesNoRecord",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "finalize zero attempt produces no record" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeSuppressesReportWhenValidationFails",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "freeze suppresses report when validation fails" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptAcceptsUnclassifiedSuccessStatus",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "recordAttempt accepts unclassified success status" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptDropsRequestsWithoutIdentity",
    [{ kind: "bun-test-annotation", path: "test/ocr/retry/report.test.ts", title: "recordAttempt drops requests without identity" }],
  ],  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_CancelledSuffix",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "outputRetryReportText cancelled suffix" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_NilWritesNothing",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "outputRetryReportText nil writes nothing" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_RecoveredAndFailed",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "outputRetryReportText recovered and failed" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_SanitizesControlChars",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "outputRetryReportText sanitizes control chars" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_SingularRetry",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "outputRetryReportText singular retry" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_SucceededAfterRetry",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "outputRetryReportText succeeded after retry" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryAttemptChain_CancelledAttemptNotDuplicated",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "retryAttemptChain cancelled attempt not duplicated" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryAttemptChain_NoStatusCode",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "retryAttemptChain no status code" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryReport_TerminalAndJSONReadSameFrozenResult",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "retryReport terminal and JSON read same frozen result" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryReportJSON_EmptyProviderKept",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "retryReport JSON empty provider kept" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryReportJSON_KeySetIsAllowlisted",
    [{ kind: "bun-test-annotation", path: "test/ocr/cli/retry-report-render.test.ts", title: "retryReport JSON key set is allowlisted" }],
  ],
  [
    "internal/stdout/stdout_test.go::TestWriter_Default",
    [{ kind: "bun-test-annotation", path: "test/cli.test.ts", title: "help goes to stdout, exit 0, via --help" }],
  ],
  [
    "internal/stdout/stdout_test.go::TestQuiet",
    [{ kind: "bun-test-annotation", path: "test/cli.test.ts", title: "factory injection without network: review runner is called and stdout is JSON, stderr is diagnostics only" }],
  ],
  [
    "internal/config/testconnection/testconnection_test.go::TestResolveLang",
    [{ kind: "bun-test-annotation", path: "test/ocr/template/template.test.ts", title: "resolves empty and explicit languages" }],
  ],
  [
    "internal/config/testconnection/testconnection_test.go::TestApplyLanguage",
    [{ kind: "bun-test-annotation", path: "test/ocr/template/template.test.ts", title: "appends language to review system messages" }],
  ],
  [
    "internal/config/testconnection/testconnection_test.go::TestApplyLanguage_EmptyLang",
    [{ kind: "bun-test-annotation", path: "test/ocr/template/template.test.ts", title: "defaults an empty language to English" }],
  ],

]);

// Revalidations for changed/new OCR behavior belong here and must name v1.9.9
// evidence. This intentionally starts empty: Phase 2 records no new behavior.
const upgradeEquivalentTests: ReadonlyMap<string, readonly Evidence[]> = new Map<string, readonly Evidence[]>([]);

const notApplicableTests: ReadonlyMap<string, string> = new Map<string, string>([
  // ---- pi-adapter provider registry: Pi replaces OCR static registry with Pi ModelRuntime ----
  [
    "internal/llm/providers_test.go::TestLookupProvider_KnownProviders",
    "Pi replaces OCR provider registry LookupProvider with Pi ModelRuntime and SettingsManager model discovery via agentDir models.json and createAgentSession; OCR static registry is not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_MiniMaxDetails",
    "Pi replaces OCR provider registry MiniMax details with Pi ModelRuntime; provider BaseURL and EnvVar are Pi model discovery details not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_Unknown",
    "Pi replaces OCR provider registry LookupProvider unknown handling with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestListProviders_Order",
    "Pi replaces OCR provider registry ListProviders ordering with Pi ModelRuntime model list; OCR static sorted provider order is not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestListProviders_ReturnsCopy",
    "Pi replaces OCR provider registry copy semantics with Pi ModelRuntime; provider list copy guard is not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_ReturnsCopyOfModels",
    "Pi replaces OCR provider registry model copy with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_PreservesModelOrder",
    "Pi replaces OCR provider registry model order preservation with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestListProviders_ReturnsSortedProviders",
    "Pi replaces OCR provider registry sorted guarantee with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_AnthropicDetails",
    "Pi replaces OCR provider registry Anthropic details with Pi ModelRuntime; protocol AuthHeader EnvVar are Pi model discovery not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_OpenAIDetails",
    "Pi replaces OCR provider registry OpenAI details with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_OllamaCloudDetails",
    "Pi replaces OCR provider registry OllamaCloud details with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_LiteLLMDetails",
    "Pi replaces OCR provider registry LiteLLM details with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestLookupProvider_MistralDetails",
    "Pi replaces OCR provider registry Mistral details with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/providers_test.go::TestProviders_AllProtocolsCanonical",
    "Pi replaces OCR provider registry protocol canonical check with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  // ---- tiktoken & counting: Pi replaces with bytes/4 fallback ----
  [
    "internal/llm/client_test.go::TestCountTokens",
    "Pi replaces OCR tiktoken counting with deterministic bytes/4 fallback in src/ocr/llmloop/compression.ts countTokens; tiktoken-precise counts are not applicable via public Pi APIs (documented deviation).",
  ],
  [
    "internal/llm/client_test.go::TestCountTokensForModel",
    "Pi replaces OCR model-sensitive tiktoken counting with model-agnostic bytes/4 fallback; not applicable via public Pi APIs (documented deviation).",
  ],
  [
    "internal/llm/client_test.go::TestEncodingForModel",
    "Pi replaces OCR tiktoken encoding selection (cl100k vs o200k) with absence; encoding table is not applicable via public Pi APIs (documented deviation).",
  ],

  [
    "internal/llm/embedded_loader_test.go::TestParseBpeData_Valid",
    "Pi replaces OCR tiktoken BPE parsing with bytes/4 fallback; LoadTiktokenBpe and embedded bpe_data are not applicable via public Pi APIs (documented deviation).",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestParseBpeData_EmptyLines",
    "Pi replaces OCR tiktoken BPE parsing with bytes/4 fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestParseBpeData_InvalidLine",
    "Pi replaces OCR tiktoken BPE parsing with bytes/4 fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestParseBpeData_InvalidBase64",
    "Pi replaces OCR tiktoken BPE parsing with bytes/4 fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestParseBpeData_InvalidRank",
    "Pi replaces OCR tiktoken BPE parsing with bytes/4 fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestLoadTiktokenBpe_KnownURL",
    "Pi replaces OCR LoadTiktokenBpe URL mapping with bytes/4 fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestLoadTiktokenBpe_UnknownURL",
    "Pi replaces OCR LoadTiktokenBpe unknown URL error with bytes/4 fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/embedded_loader_test.go::TestInitEmbeddedLoader",
    "Pi replaces OCR InitEmbeddedLoader global tiktoken loader with absence; not applicable via public Pi APIs.",
  ],
  // ---- retry middleware: Pi replaces SDK middleware with SettingsManager retry disabled ----
  [
    "internal/llm/client_test.go::TestRetryCodesMiddleware_Nil",
    "Pi replaces OCR retry middleware with SettingsManager.inMemory({retry:{enabled:false}}) and SessionManager.inMemory(); no public WithMiddleware hook exists on PiSession, not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestRetryCodesMiddleware_SetsHeader",
    "Pi replaces OCR retry middleware that sets x-should-retry header with absence; Pi disables retry via SettingsManager, not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestRetryCodesMiddleware_NoHeaderForNonMatchingCode",
    "Pi replaces OCR retry middleware header logic with absence; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestRetryCodesMiddleware_PassthroughError",
    "Pi replaces OCR retry middleware passthrough with absence; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_RetryCodesTriggersRetry",
    "Pi replaces OCR SDK retry on 429/403 with retry disabled via SettingsManager.inMemory({retry:{enabled:false}}); single-retry behavior is not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_RetryCodesTriggersRetry",
    "Pi replaces OCR SDK retry with disabled retry; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_norm_test.go::TestNormalizeAuthHeader",
    "Pi replaces OCR auth header normalization with Pi SessionManager auth handling; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_norm_test.go::TestTryCCEnv",
    "Pi replaces OCR Claude Code env resolution with Pi SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_shellrc_test.go::TestShellRCFiles",
    "Pi replaces OCR shell RC file enumeration with Pi DefaultResourceLoader; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_shellrc_test.go::TestTryShellRC",
    "Pi replaces OCR shell RC parsing with Pi DefaultResourceLoader; not applicable via public Pi APIs.",
  ],
  // ---- header/user-agent wiring replaced by Pi SDK internals ----
  [
    "internal/llm/message_test.go::TestDefaultAuthHeader",
    "Pi replaces OCR defaultAuthHeader with Pi SDK SessionManager/SettingsManager auth handling; header name selection is not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/message_test.go::TestUserAgent",
    "Pi replaces OCR userAgent with Pi SDK internal User-Agent; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestNewAnthropicClient_URLNormalization",
    "Pi replaces OCR Anthropic client URL normalization with Pi ModelRuntime baseUrl via agentDir models.json; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestNewOpenAIClient_URLNormalization",
    "Pi replaces OCR OpenAI client URL normalization with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestBuildAnthropicParams_CacheControl",
    "Pi replaces OCR Anthropic cache_control via Pi cacheControlFormat compat; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestBuildAnthropicParams_CacheControl_NoSystem",
    "Pi replaces OCR Anthropic cache control no system; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestBuildAnthropicParams_CacheControl_NoTools",
    "Pi replaces OCR Anthropic cache control no tools; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestBuildAnthropicParams_DynamicCacheBreakpoint",
    "Pi replaces OCR Anthropic dynamic cache breakpoint with Pi cacheControlFormat; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestBuildAnthropicParams_NullToolCallArguments",
    "Pi replaces OCR Anthropic null tool args handling with Pi toPiToolParameters; not applicable via public Pi APIs (handled via TypeBox).",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_DefaultsToAuthorizationHeader",
    "Pi replaces OCR Anthropic default auth header with Pi SessionManager auth; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_UsesConfiguredAuthorizationHeader",
    "Pi replaces OCR Anthropic auth header config; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_UsesConfiguredXAPIKeyHeader",
    "Pi replaces OCR Anthropic x-api-key header; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestNewLLMClient_Dispatch",
    "Pi replaces OCR NewLLMClient dispatch with Pi createAgentSession model routing; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestNewLLMClient_OpenAIAliasDispatchesToOpenAIClient",
    "Pi replaces OCR OpenAI alias dispatch; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_ExtraBodyStreamDropped",
    "Pi replaces OCR Anthropic extra_body stream drop with Pi AgentSession handling; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_ExtraHeadersSent",
    "Pi replaces OCR Anthropic extra headers with Pi provider headers via models.json; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_NoExtraHeadersWhenEmpty",
    "Pi replaces OCR Anthropic no extra headers; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_ExtraHeadersSent",
    "Pi replaces OCR OpenAI extra headers; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_NonStreamingRequestDropsStreamField",
    "Pi replaces OCR OpenAI non-streaming stream field drop; Pi always streams via AgentSession, not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingInconsistentChunks",
    "Pi replaces OCR OpenAI streaming inconsistent chunks via pi-ai accumulator; Pi AgentSession handles via turn_end, not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingReasoningContent",
    "Pi replaces OCR OpenAI streaming reasoning_content extra field with Pi thinking blocks; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingToolCall",
    "Pi replaces OCR OpenAI streaming tool call delta merging with Pi toolCall blocks; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamOnlyGateway",
    "Pi replaces OCR stream-only gateway with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/message_test.go::TestParseShellRC",
    "Pi replaces OCR shell RC parsing with Pi DefaultResourceLoader; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/message_test.go::TestParseShellRC_Incomplete",
    "Pi replaces OCR shell RC parsing; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/message_test.go::TestParseShellRC_ModelOverride",
    "Pi replaces OCR shell RC model override parsing; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/message_test.go::TestParseShellRC_NonexistentFile",
    "Pi replaces OCR shell RC file handling; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_AssistantTextPlusToolCalls",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_MaxTokensAndTemperature",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_NoInstructionsWhenNoSystem",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_StoreAndCacheKey",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_SystemToInstructions",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_ToolCallItems",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestMapResponsesResponse_FunctionCalls",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestMapResponsesResponse_ReasoningAggregated",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestMapResponsesResponse_TextOnly",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestMapResponsesResponse_Usage",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestNewOpenAIResponsesClient_URLNormalization",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestOpenAIResponsesClient_EndToEnd",
    "Pi replaces OCR Responses API wire (provider-specific) with Pi ModelRuntime openai-responses via createAgentSession; not applicable via public Pi APIs.",
  ],
  // ---- resolver provider dispatch: Pi replaces with createAgentSession model routing ----
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CCEnvStripsModelSuffix",
    "Pi replaces OCR ANTHROPIC_* env resolution with Pi createAgentSession model routing via agentDir; model suffix stripping for env is not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CCEnvCleanModelUnchanged",
    "Pi replaces OCR Claude env resolution; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvStripsModelSuffix",
    "Pi replaces OCR OCR_LLM_* env resolution; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigFileStripsModelSuffix",
    "Pi replaces OCR config file llm.* resolution with Pi SettingsManager agentDir; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigAnthropicDefaultsToAuthorization",
    "Pi replaces OCR auth header default with Pi SessionManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigAuthHeaderOverrideToXAPIKey",
    "Pi replaces OCR auth header override; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigOpenAIIgnoresAuthHeader",
    "Pi replaces OCR OpenAI auth header ignore; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvAuthHeader",
    "Pi replaces OCR env auth header; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvOpenAIIgnoresAuthHeader",
    "Pi replaces OCR env OpenAI auth header; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigPrecedesOCREnvironment",
    "Pi replaces OCR file>env precedence with Pi SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigPrecedesClaudeCodeEnvironment",
    "Pi replaces OCR precedence; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_IncompleteConfigFallsBackToOCREnvironment",
    "Pi replaces OCR fallback; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigPrecedesInvalidCompleteEnvironment",
    "Pi replaces OCR precedence with invalid env; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderAnthropic",
    "Pi replaces OCR preset anthropic provider with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderOpenAI",
    "Pi replaces OCR preset openai provider; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderAnthropicURLHasMessagesSuffix",
    "Pi replaces OCR URL messages suffix handling with Pi DefaultResourceLoader; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProvider",
    "Pi replaces OCR custom provider with Pi agentDir custom provider; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderInvalidProtocol",
    "Pi replaces OCR custom provider protocol validation with Pi ModelRuntime; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderMissingFields",
    "Pi replaces OCR custom provider missing fields validation; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderModelFromTopLevel",
    "Pi replaces OCR custom provider top-level model; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestEnsureMessagesSuffix",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestNewLLMClient_DefaultTimeout",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestNewLLMClient_TimeoutForwarded",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ConfigTimeoutSec",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderAnthropicVertexRejected",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderChatCompletionsProtocol",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderOpenAIAlias",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_CustomProviderResponsesProtocol",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_EnvTimeoutGlobalOverride",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_EnvTimeoutOverridesConfigTimeout",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_EnvTimeoutOverridesProviderTimeout",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_InvalidEnvTimeoutWithConfig",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_InvalidRetryCodes",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_LegacyLlmProtocolTakesPriorityOverUseAnthropic",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_LegacyLlmRetryCodes",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_LegacyLlmStillWorks",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_MiniMaxProviderEnvFallback",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_MiniMaxProviderRejectsOtherRegionEnv",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_NegativeConfigTimeoutSec",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_NegativeEnvTimeoutWithConfig",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvProtocolAlias",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvProtocolInvalid",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvProtocolTakesPriorityOverUseAnthropic",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderAPIKeyEnvFallback",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderConfigNegativeTimeoutSec",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderConfigTimeoutSec",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderEntryModelOverridesDefault",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderMissingAPIKey",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderModelOverride",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderNotConfigured",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderRetryCodes",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ResponsesURLNotMutated",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_CustomProviderWithoutConfiguredModel",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_InvalidModelInCustomProviderList",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_InvalidModelInPresetList",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_LegacyConfigNoValidation",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_MergesPresetAndEntryModels",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_NoValidationWhenNoModelList",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_ValidModelInCustomProviderList",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithModelOverride_ValidModelInPresetList",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_DifferentProviderDoesNotReuseTopLevelModel",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_ExplicitProvider",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_ExplicitProviderAndModel",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_ExplicitProviderUsesProviderAPIKeyEnvironmentFallback",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_ExplicitProviderWithoutConfigNamesSection",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_ModelOverrideBeatsEnvironmentModel",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_ModelOverrideCompletesOCREnvironment",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_SameProviderPreservesTopLevelModel",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpointWithOptions_UnknownProviderFailsWithoutFallbackOrMutation",
    "Pi replaces OCR resolver dispatch with Pi createAgentSession model routing via agentDir and SettingsManager; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/message_test.go::TestModelListContains",
    "Pi replaces OCR ModelListContains config helper with Pi SettingsManager model discovery; not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageCacheReadPathPriority",
    "Pi replaces OCR usage resolver path priority probing with Pi SDK normalized usage.cacheRead via createAgentSession; priority among raw JSON paths is not applicable via public Pi APIs, values covered by OpenAI compatible test.",
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageCacheCreationTokensPriority",
    "Pi replaces OCR cache creation path priority with Pi SDK normalized usage.cacheWrite; not applicable via public Pi APIs.",
  ],
  [
    "internal/agent/agent_test.go::TestAgentGettersNil",
    "Pi replaces Go nil-receiver method call (*Agent)(nil).SessionID() with TypeScript's non-null this guarantee; calling a method on null is not applicable in TypeScript and has no runtime path.",
  ],
  [
    "internal/agent/getters_test.go::TestAgentGettersNilSafe",
    "Pi replaces Go nil-receiver guard (a := (*Agent)(nil)) with TypeScript's type system where `this` is always valid; not applicable to TypeScript, verified via normal empty-agent behavior instead.",
  ],
  [
    "internal/session/list_more_test.go::TestManifest_NilReceiver",
    "Pi replaces Go nil-receiver guard (var sh *SessionHistory; sh.Manifest() == nil) with TypeScript's non-null this guarantee; calling a method on null is not applicable in TypeScript and has no runtime path.",
  ],
  [
    "internal/session/list_more_test.go::TestRecordReviewItem_NilReceiver",
    "Pi replaces Go nil-receiver guard (var sh *SessionHistory; sh.RecordReviewItem*() no-op) with TypeScript's non-null this guarantee; calling a method on null is not applicable in TypeScript and has no runtime path.",
  ],
  [
    "internal/llm/resolver_test.go::TestParseExtraHeaders",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestParseRetryCodes",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestParseTimeoutEnv",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestValidateTimeoutSec",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestStripModelSuffix",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_EnvExtraHeadersMergedWithConfigFile",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_LegacyLlmExtraHeaders",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvExtraHeaders",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvExtraHeadersEmpty",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvExtraHeadersInvalid",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_OCREnvExtraHeadersReservedRejected",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderExtraHeaders",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_ProviderExtraBody",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_RedundantRetryCodesFiltered",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/resolver_test.go::TestResolveEndpoint_SessionKeyPlaceholderPreserved",
    "Pi replaces OCR resolver provider-SDK-only parsing (ParseExtraHeaders/ParseRetryCodes/parseTimeoutEnv/validateTimeoutSec/stripModelSuffix and header/body merging) with Pi ModelRuntime via createAgentSession and agentDir SettingsManager; those resolver helpers are provider-SDK-only and not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestBuildResponsesParams_Tools",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestMapResponsesResponse_StatusIncomplete",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestMapResponsesResponse_StatusFailedAndCancelled",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestOpenAIResponsesClient_ExtraBodyPromptCacheKeyOverridesSessionID",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestOpenAIResponsesClient_ExtraBodyStreamDropped",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestOpenAIResponsesClient_NonSuccessStatusReturnsError",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/responses_client_test.go::TestOpenAIResponsesClient_SessionKeyExpandedInHeadersAndBody",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_RetriesTruncatedResponse",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_DoesNotRetryTruncatedResponseAfterCancellation",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StopsAfterSecondTruncatedResponse",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_DoesNotRetryNonRetryableError",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingError",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingIncomplete",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingNoChoices",
    "Pi replaces OCR Responses API wire (buildResponsesParams/mapResponsesResponse/shouldRetryTruncated and status classification) with Pi ModelRuntime openai-responses via createAgentSession; provider-SDK-specific Responses wire and truncation retry are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestResponseRequestID",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestParseRetryDirective",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestParseRetryAfterMS",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverRecordsRateLimitedThenSuccess",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverRecordsTransportFailure",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverDropsRequestsWithoutIdentity",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestNilCollectorMountsNoObserver",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverIgnoresOverriddenRetryCountHeader",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverRecordsRetryDirectiveOnSuccess",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverRecordsExhaustedRetries",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverConcurrentRequests",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverClassifiesTerminalStatuses",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_observer_test.go::TestObserverMountedOnOpenAIClients",
    "Pi replaces OCR SDK retry middleware/HTTP observer that records per-HTTP-attempt Retry-After/request-id/x-should-retry via http middleware; Pi retry is disabled via SettingsManager.inMemory({retry:{enabled:false}}) and PiTransport records one attempt per Pi request via public complete() seam, so per-HTTP-attempt observer hooks are not applicable via public Pi APIs.",
  ],
  [
    "internal/llm/retry_report_test.go::TestNilCollectorIsInert",
    "Pi replaces Go nil-receiver method call (*RetryCollector)(nil).Freeze() with TypeScript's non-null this guarantee; calling a method on null is not applicable in TypeScript and has no runtime path.",
  ],
  // ---- smallfiles: Pi replaces provider/viewer TUI shells ----
  [
    "cmd/opencodereview/smallfiles_test.go::TestRunLLMProviders",
    "Pi replaces OCR's list-providers CLI (provider TUI catalog) with Pi SettingsManager model discovery via agentDir; built-in provider listing is a deferred shell and not applicable via public Pi CLI.",
  ],
  [
    "cmd/opencodereview/smallfiles_test.go::TestViewerCmd_DefaultAddr",
    "Pi replaces OCR's viewer HTTP server shell with a deferred browser session viewer; default addr localhost:5483 is not applicable via pi-reviewer which has no viewer command.",
  ],
  [
    "cmd/opencodereview/apply_provider_field_test.go::TestApplyProviderField",
    "OCR applyProviderField per-field switch (api_key/url/model/models/protocol/auth_header/extra_body/extra_headers) via ProviderEntry mutation is omitted; pi-reviewer does not expose provider field mutation and does not write Pi config; users configure via external Pi tooling/files, runtime only resolves via public Pi APIs; not applicable via review/scan --provider/--model",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestActiveModelForProvider",
    "OCR activeModelForProvider helper that prefers entry Model over cfg Model when provider matches is omitted; pi-reviewer does not expose provider/model config lookup via cfg and does not mutate Pi config; users specify --provider/--model, runtime loads via public Pi APIs; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestConfigRoundTripPreservesTimeoutSec",
    "OCR saveConfig/loadOrCreateConfig round-trip preserving providers.*.timeout_sec/custom_providers.*.timeout_sec/llm.timeout_sec is omitted; runtime per-file timeout exists via review --timeout flag, but config persistence of timeout_sec is not exposed and Pi config is not mutated by pi-reviewer; file round-trip not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestDeleteCustomProvider_NotFound",
    "OCR deleteCustomProvider nil map vs missing entry error via CustomProviders is omitted; pi-reviewer does not expose provider deletion and does not implement custom provider delete error path; Pi config deletion is managed externally; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestEnsureModelInList",
    "OCR ensureModelInList that appends new-model without reordering is omitted; pi-reviewer does not implement model-list ensure for Pi config and does not write Pi config; model availability is managed externally; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestEnsureTelemetry",
    "OCR ensureTelemetry nil->non-nil init for Telemetry is explicitly deferred; Pi telemetry export is not ported and pi-reviewer does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestLegacyLLMShadowWarning",
    "OCR legacyLLMShadowWarning for active provider shadowing llm.* is omitted; pi-reviewer has no llm.* legacy config and does not expose config warning flow; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestLoadAppConfig_InvalidJSON",
    "OCR LoadAppConfig invalid JSON error via os.WriteFile {invalid} is omitted; pi-reviewer does not expose LoadAppConfig file parsing and does not write Pi config; runtime loads external Pi config via public APIs; file error path not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestLoadAppConfig_NotExist",
    "OCR LoadAppConfig nil for nonexistent file is omitted; pi-reviewer does not implement LoadAppConfig; Pi configuration defaults come from public Pi APIs reading ~/.pi/agent managed externally; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestLoadOrCreateConfig_InvalidJSON",
    "OCR loadOrCreateConfig invalid JSON error propagation is omitted; pi-reviewer does not expose file config loading and does not write Pi config; omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestLoadOrCreateConfig_NewFile",
    "OCR loadOrCreateConfig new-file non-nil Config creation is omitted; pi-reviewer does not create Pi config files and does not mutate Pi config; external Pi tooling manages files; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestMaxTokensConfigRoundTrip",
    "OCR saveConfig/LoadAppConfig round-trip for MaxTokens 200000 is omitted; runtime max-tokens exists via review --max-tokens/Budget, but config persistence via Go file is not exposed and Pi config is not written by pi-reviewer; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestMergeModelLists",
    "OCR mergeModelLists dedup/empty-string filter merging of [][]string is omitted; pi-reviewer does not implement model-list dedup for config persistence and does not mutate Pi config; model lists are managed externally via Pi files, runtime only consumes --model; helper not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestNormalizeModelList",
    "OCR normalizeModelList trim+dedup+empty filter is omitted; pi-reviewer does not implement model-list normalization for config write and does not mutate Pi config; external Pi tooling manages lists; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestParseModelListValue",
    "OCR parseModelListValue (JSON array / comma / [a,b] unquoted) is omitted; pi-reviewer does not parse model lists for config persistence and does not mutate Pi config; users configure via external Pi files, runtime uses --model; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestResolveConfigPath_Default",
    "OCR resolveConfigPath default ~/.config/open-code-review/config.json via OCR_CONFIG_PATH is omitted; pi-reviewer uses Pi's external auth/model location ~/.pi/agent via SettingsManager/DefaultResourceLoader and does not implement OCR's config path resolution; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestResolveConfigPath_Env",
    "OCR resolveConfigPath OCR_CONFIG_PATH=/tmp/test-config.json env override is omitted; pi-reviewer resolves Pi agent dir via PI_CODING_AGENT_DIR/--agent-dir and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfigSetWarnsWhenActiveProviderShadowsLegacyLLMConfig",
    "OCR runConfigSet warning when active provider shadows legacy llm.url via captureConfigStderr is omitted; pi-reviewer has no llm.* precedence and does not expose config set; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfigUnsetProviderClearsSelectionAndKeepsProviderEntries",
    "OCR runConfigUnset `provider` that clears Provider/Model but keeps Providers[\"dashscope\"].APIKey via saveConfig/loadOrCreateConfig is omitted; pi-reviewer does not expose config unset and does not clear secrets via saveConfig; users manage via external Pi files, runtime only loads; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfigUnset_InvalidKey",
    "OCR runConfigUnset custom_providers. empty name error is omitted; pi-reviewer has no config unset; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfigUnset_UnknownPrefix",
    "OCR runConfigUnset providers.anthropic unsupported prefix error is omitted; pi-reviewer does not expose config unset and does not validate provider config keys for mutation; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfig_EmptyArgs",
    "OCR runConfig nil args prints usage is omitted; pi-reviewer has no config subcommand, review/scan are only surface; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfig_ModelWithArgs",
    "OCR runConfig `model extra` arg error is omitted; pi-reviewer does not expose config model subcommand, model is --model flag; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestRunConfig_ProviderWithArgs",
    "OCR runConfig `provider extra` arg count error is omitted; pi-reviewer does not expose config provider subcommand, provider selection is --provider flag; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueAuthHeaderNormalizesKnownValues",
    "OCR setConfigValue `llm.auth_header` bearer -> authorization normalization via AuthHeader field is omitted; pi-reviewer does not expose llm.auth_header mutation and does not write Pi config; auth header is handled at runtime via Pi SessionManager from external files; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueAuthHeaderRejectsCustomHeader",
    "OCR auth_header X-Custom-Auth rejection via setConfigValue is omitted; pi-reviewer does not expose config key validation for auth_header and does not mutate Pi config; allowed headers are enforced at runtime via Pi SDK; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueCustomProviderExtraHeaders",
    "OCR custom_providers.my-gateway.extra_headers via ProviderEntry is omitted; pi-reviewer does not persist extra_headers via config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLanguage",
    "OCR setConfigValue `language` English via cfg.Language is omitted; runtime language exists via template applyLanguage and review --language handling, but config persistence of language is not exposed and Pi config is not mutated by pi-reviewer; Go config path not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmAuthToken",
    "OCR setConfigValue `llm.auth_token` via Llm.AuthToken is omitted; pi-reviewer does not expose llm.* legacy config and does not write Pi secrets; legacy llm.* not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmExtraBody",
    "OCR setConfigValue `llm.extra_body` JSON via Llm.ExtraBody is omitted; pi-reviewer does not expose llm.extra_body config mutation; extra body is managed via external Pi models.json and consumed at runtime; not applicable via public Pi APIs",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmExtraBodyInvalid",
    "OCR llm.extra_body not-json rejection via setConfigValue is omitted; pi-reviewer does not expose config validation for llm.extra_body and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmExtraHeaders",
    "OCR setConfigValue `llm.extra_headers` parsing is omitted; pi-reviewer does not expose llm.extra_headers config mutation; headers are managed externally and consumed via Pi APIs; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmExtraHeadersInvalid",
    "OCR llm.extra_headers no-equals rejection is omitted; pi-reviewer does not expose config key validation for headers and does not write Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmExtraHeadersReservedRejected",
    "OCR llm.extra_headers Authorization=bad reserved rejection is omitted; pi-reviewer does not expose config validation and does not mutate Pi config; reserved header guard is at runtime via Pi SDK; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmModel",
    "OCR setConfigValue `llm.model` via Llm.Model is omitted; pi-reviewer does not expose llm.* legacy config; runtime model is via --model flag; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmProtocol",
    "OCR setConfigValue `llm.protocol` mirroring UseAnthropic is omitted; pi-reviewer does not expose llm.protocol mutation; protocol is resolved at runtime via ModelRuntime createAgentSession from external Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmRetryCodesNoWarningForValidCodes",
    "OCR llm.retry_codes 403,400 no-warning path via setConfigValue is omitted; pi-reviewer disables retry via SettingsManager.inMemory({retry:{enabled:false}}) and does not expose retry_codes config persistence; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmRetryCodesRedundantWarning",
    "OCR llm.retry_codes 429,403 redundant 429 warning via captureConfigStderr is omitted; pi-reviewer does not expose retry_codes config and filters via retry disabled; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmURL",
    "OCR setConfigValue `llm.url` via Llm.URL is omitted; pi-reviewer does not expose llm.url mutation; baseUrl comes from external Pi models.json via agentDir; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmUseAnthropic",
    "OCR setConfigValue `llm.use_anthropic` mirroring Protocol is omitted; pi-reviewer does not expose llm.use_anthropic; not applicable via ModelRuntime",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueLlmUseAnthropicInvalid",
    "OCR llm.use_anthropic notbool rejection is omitted; pi-reviewer does not expose config validation for this key and does not write Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueMCPServer",
    "OCR setConfigValue `mcp_servers.my-server.command` via setMCPServerValue is deferred; MCP servers are not ported; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueMaxTokens",
    "OCR setConfigValue `max_tokens` 200000 via cfg.MaxTokens is omitted; runtime max-tokens exists via --max-tokens/Budget but config persistence is not exposed and Pi config is not mutated; not applicable via Go config",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueMaxTokensRejectsInvalidValues",
    "OCR max_tokens 0/-1/not-a-number rejection via setConfigValue is omitted; runtime validation via Budget exists but config-command validation/persistence is omitted and Pi config not written; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueModel",
    "OCR setConfigValue `model` via cfg.Model is omitted; pi-reviewer does not persist model via config command and does not write Pi config; runtime model is via --model flag and external Pi files; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueModelWithCustomProvider",
    "OCR setConfigValue `model` when Provider=my-gateway writes to CustomProviders[my-gateway].Model is omitted; pi-reviewer does not mutate Pi config; model is resolved at runtime via --model/external files; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueModelWithProvider",
    "OCR setConfigValue `model` when Provider=anthropic writes to Providers[anthropic].Model is omitted; pi-reviewer does not write Pi config; runtime only loads; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProvider",
    "OCR setConfigValue `provider` via cfg.Provider is omitted; pi-reviewer does not persist provider via config command; provider is via --provider flag and external Pi files; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderClearsModel",
    "OCR setConfigValue `provider` clears Model on provider change is omitted; pi-reviewer does not implement provider switch clearing via saveConfig and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntry",
    "OCR setConfigValue `providers.anthropic.api_key/model` via ProviderEntry is omitted; pi-reviewer does not expose provider entry mutation and does not write Pi config; external files manage entries, runtime only loads; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryExtraBody",
    "OCR providers.anthropic.extra_body JSON via ProviderEntry.ExtraBody is omitted; pi-reviewer does not persist extra_body via config and does not write Pi config; handled via external models.json at runtime; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryInvalidKey",
    "OCR providers.anthropic.unknown_field rejection via applyProviderField is omitted; pi-reviewer does not validate/expose config key persistence for provider entry and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryInvalidPath",
    "OCR providers.anthropic incomplete path (no field) rejection is omitted; pi-reviewer does not expose config path validation for mutation and does not write Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryModelsCommaSeparated",
    "OCR custom_providers.my-gateway.models comma parsing via parseModelListValue is omitted; pi-reviewer does not parse/persist model lists via config command and does not mutate Pi config; external files manage lists; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryModelsJSON",
    "OCR custom_providers.my-gateway.models JSON dedup via parseModelListValue is omitted; pi-reviewer does not implement dedup for config persistence and does not write Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryModelsUnquotedBracketList",
    "OCR custom_providers models [llama-3-70b,llama-3-8b] unquoted bracket parsing is omitted; pi-reviewer does not parse model lists for config write; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryNonPresetWritesCustomProvider",
    "OCR providers.my-gateway.url non-preset writes to CustomProviders[my-gateway].URL via setConfigValue is omitted; pi-reviewer does not route non-preset providers to CustomProviders and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderEntryProtocol",
    "OCR custom_providers.custom.protocol openai alias validation is omitted; pi-reviewer does not validate protocol via config mutation; runtime resolves via ModelRuntime from external files; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderExtraHeaders",
    "OCR providers.anthropic.extra_headers parsing via ProviderEntry.ExtraHeaders is omitted; pi-reviewer does not persist extra_headers via config and does not write Pi config; handled externally at runtime; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderExtraHeadersInvalid",
    "OCR providers.anthropic.extra_headers =missing-key rejection is omitted; pi-reviewer does not validate extra_headers config persistence and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueProviderRetryCodesRedundantWarning",
    "OCR custom_providers.test.retry_codes redundant warning via captureConfigStderr is omitted; pi-reviewer disables retry and does not expose retry_codes config persistence; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueTelemetryContentLogging",
    "OCR telemetry.content_logging bool is deferred; pi-reviewer does not port content logging config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueTelemetryContentLoggingInvalid",
    "OCR telemetry.content_logging notbool rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueTelemetryEnabled",
    "OCR setConfigValue `telemetry.enabled` true bool via ensureTelemetry is deferred; pi-reviewer does not expose telemetry config mutation and does not write Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueTelemetryEnabledInvalid",
    "OCR telemetry.enabled notbool rejection is deferred; pi-reviewer does not expose telemetry config command and does not validate config keys; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueTelemetryExporter",
    "OCR telemetry.exporter otlp string is deferred; pi-reviewer does not port telemetry config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueTelemetryOTLPEndpoint",
    "OCR telemetry.otlp_endpoint localhost:4317 is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueUnknownKey",
    "OCR setConfigValue unknown.key rejection via supportedConfigKeys is omitted; pi-reviewer does not expose config key validation for persistence and does not write Pi config; users configure via external Pi files, runtime only loads; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetConfigValueUnknownKeyMessage",
    "OCR unknown-key message byte-identical check from supportedConfigKeys/supportedProviderFields is omitted; pi-reviewer does not generate unknown-key messages for config persistence and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Args",
    "OCR setMCPServerValue mcp_servers.my-server.args JSON is deferred; MCP servers not ported; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_ArgsInvalidJSON",
    "OCR mcp_servers args not-json rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Command",
    "OCR setMCPServerValue mcp_servers.my-server.command is deferred; Pi has no MCP command; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_CommandEmpty",
    "OCR mcp_servers command empty rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Env",
    "OCR mcp_servers.my-server.env is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_EnvInvalidFormat",
    "OCR mcp_servers env NOEQUALS format rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_EnvInvalidJSON",
    "OCR mcp_servers env not-json rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_ExistingServer",
    "OCR setMCPServerValue existing srv old-cmd->new-cmd via MCPServers map is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Headers",
    "OCR mcp_servers.gh.headers is deferred; Pi has no MCP headers; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_HeadersEmptyName",
    "OCR mcp_servers headers empty name rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_HeadersEmptyValue",
    "OCR mcp_servers headers empty value rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_HeadersInvalidJSON",
    "OCR mcp_servers headers not-json rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_InvalidKey",
    "OCR setMCPServerValue mcp_servers malformed key is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Setup",
    "OCR mcp_servers.my-server.setup is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Tools",
    "OCR mcp_servers.my-server.tools dedup via setMCPServerValue is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_ToolsEmptyName",
    "OCR mcp_servers tools empty name rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_ToolsInvalidJSON",
    "OCR mcp_servers tools not-json rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_Type",
    "OCR setMCPServerValue mcp_servers.gh.type is deferred; Pi has no MCP type; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_TypeInvalid",
    "OCR mcp_servers type invalid rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_URL",
    "OCR mcp_servers.gh.url is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_URLEmpty",
    "OCR mcp_servers url empty rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_URLInvalidScheme",
    "OCR mcp_servers url ftp:// scheme rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_URLNoHost",
    "OCR mcp_servers url http:// no-host rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_URLParseError",
    "OCR mcp_servers url ://bad parse error is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestSetMCPServerValue_UnknownField",
    "OCR mcp_servers unknown field rejection is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetActiveCustomProvider",
    "OCR unsetCustomProvider when Provider=my-gateway active clears Provider/Model and keeps other-gateway via saveConfig is omitted; pi-reviewer does not expose unset and does not mutate Pi config; Pi files managed externally; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetCustomProvider",
    "OCR unsetCustomProvider that deletes CustomProviders[my-gateway] via saveConfig is omitted; pi-reviewer does not expose unset and does not delete via saveConfig; external Pi files manage deletions; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetInvalidKey",
    "OCR unsetCustomProvider my-gateway ok vs nonexistent error via CustomProviders map is omitted; pi-reviewer does not expose unset error path and does not mutate Pi config; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetMCPServer",
    "OCR unsetMCPServer deleting srv1 keeps srv2 via saveConfig is deferred; MCP not ported; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetMCPServer_LastEntry",
    "OCR unsetMCPServer deleting last entry nils MCPServers map is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetMCPServer_NotFound",
    "OCR unsetMCPServer nonexistent error is deferred; not applicable",
  ],
  [
    "cmd/opencodereview/config_cmd_test.go::TestUnsetMaxTokens",
    "OCR unsetMaxTokens that removes max_tokens key via saveConfig/loadOrCreateConfig is omitted; runtime maxTokens via Budget exists but config unset persistence is not exposed and Pi config is not written; not applicable",
  ],
  [
    "cmd/opencodereview/config_dispatch_test.go::TestRunConfig_InvalidSetMissingValue",
    "OCR runConfig `config set` missing value arg validation via Cobra is omitted; pi-reviewer does not expose config set and does not mutate Pi config; users configure through external Pi tooling/files, runtime only resolves via public Pi APIs; config-command persistence is omitted, not applicable via review/scan --provider/--model",
  ],
  [
    "cmd/opencodereview/config_dispatch_test.go::TestRunConfig_InvalidUnsetMissingKey",
    "OCR runConfig `config unset` missing key validation via Cobra is omitted; pi-reviewer does not expose config unset and does not mutate Pi config; users configure via external Pi tooling/files, runtime only loads via public Pi APIs; config unset is omitted, not applicable",
  ],
  [
    "cmd/opencodereview/config_dispatch_test.go::TestRunConfig_UnknownSubcommand",
    "OCR runConfig dispatch unknown subcommand via Cobra is omitted; pi-reviewer does not expose a config command tree and routes only review/scan/version; users configure auth/models through external Pi tooling/files, runtime only resolves/loads via public Pi APIs; config subtree is an omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/config_runset_test.go::TestRunConfigSetPersists",
    "OCR runConfigSet persistence via setConfigValue + saveConfig 0600 with maskKey redaction is omitted; pi-reviewer does not expose config set, does not write Pi config files and does not implement maskKey; users configure via external Pi tooling/files, runtime only loads via public Pi APIs; config saving/masking is omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/config_runset_test.go::TestRunConfigUnsetPaths",
    "OCR runConfigUnset dispatch for `provider`/`custom_providers.<name>`/`mcp_servers.<name>` with captureStdout is omitted; pi-reviewer does not expose config unset and does not mutate Pi config; users configure via external Pi tooling/files; omitted boundary, not applicable via Cobra",
  ],
  [
    "cmd/opencodereview/config_unset_error_test.go::TestUnset_LoadErrors",
    "OCR unset* load-error branches (unsetActiveProvider/unsetCustomProvider/unsetMCPServer wrapping loadOrCreateConfig invalid JSON) are omitted; pi-reviewer does not expose config unset and does not implement loadOrCreateConfig file parsing; runtime only loads external Pi config via public Pi APIs; omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyCustomProviderConfig_EmptyKeyClearsSavedAPIKey",
    "OCR applyCustomProviderConfig empty-key clears CustomProviders[aaa].APIKey via saveConfig is omitted; pi-reviewer does not expose secret clearing and does not write Pi config; external Pi files manage secrets; not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyCustomProviderConfig_MissingModel",
    "OCR applyCustomProviderConfig missing model validation is omitted; pi-reviewer does not expose custom provider config mutation; validation is at runtime via ModelRuntime, not via config save; omitted, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyCustomProviderConfig_MissingProvider",
    "OCR applyCustomProviderConfig missing provider name validation is omitted; pi-reviewer does not expose custom provider creation via config command; provider name lives in external Pi files, runtime only loads; omitted, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyManualConfig_MissingModel",
    "OCR applyManualConfig missing model validation is omitted; pi-reviewer does not expose manual config mutation; model validation occurs at runtime via --model and ModelRuntime, not via saved config; omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyManualConfig_MissingURL",
    "OCR applyManualConfig missing URL validation before network test is omitted; pi-reviewer does not expose manual config/provider wizard; manual provider URL is supplied via external Pi models.json baseUrl and resolved at review time via createAgentSession; config-command validation is omitted, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyOfficialProviderConfig_EmptyKeyClearsSavedAPIKey",
    "OCR applyOfficialProviderConfig empty-key clears persisted APIKey via saveConfig/loadOrCreateConfig is omitted; pi-reviewer does not expose secret clearing and does not mutate Pi config; users manage secrets via external Pi tooling/files; omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyOfficialProviderConfig_MissingFields",
    "OCR applyOfficialProviderConfig missing provider/model required error is omitted; pi-reviewer does not expose official provider config mutation; provider/model validation is via review/scan --provider/--model flags, not via config file; omitted, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyOfficialProviderConfig_UsesSessionModelPick",
    "OCR applyOfficialProviderConfig sessionModelPick -> Model/Provider switch via saveConfig is omitted; pi-reviewer does not expose provider config apply and does not mutate Pi config; runtime routes via --provider/--model and createAgentSession; omitted, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyProviderDeletions",
    "OCR applyProviderDeletions (saveConfig + delete from CustomProviders, keep active) is omitted; pi-reviewer does not expose provider deletion and does not mutate Pi config; users manage deletions via external Pi tooling/files; omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyProviderDeletions_ActiveCleared",
    "OCR applyProviderDeletions active-cleared path that clears Provider/Model when deleting active custom provider is omitted; pi-reviewer does not expose provider deletion and does not clear selection via saveConfig; users configure via external Pi files, runtime only loads; not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestApplyProviderDeletions_SkipsNotFound",
    "OCR applyProviderDeletions skip-not-found no-error path is omitted; pi-reviewer does not expose provider deletion and does not implement tolerant delete; Pi config is not mutated by pi-reviewer; omitted boundary, not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestMaskKey",
    "OCR maskKey API-key redaction (\"\"->(not set), \"abcd\"/\"12345678\"->***, sk-ant-***1234) is omitted; pi-reviewer does not expose config display and does not implement Pi config secret clearing/masking; users manage secrets via external Pi tooling/files; not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestPrintWizardCancelled",
    "OCR printWizardCancelled wizard scope message (Configuration/Model list changes kept) via stdout pipe is omitted; pi-reviewer does not expose provider TUI wizard; not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestProviderTUIResult_ResolvedModel",
    "OCR providerTUIResult.resolvedModel via sessionModelPick map vs model field is omitted; pi-reviewer does not expose provider TUI wizard; model selection is via CLI --model and external Pi config, runtime only resolves via public APIs; TUI result struct not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestRemoveModels",
    "OCR removeModels helper (remove one/none/all, empty existing) is omitted; pi-reviewer does not expose model-list mutation and does not implement Pi config model deduplication/filtering for persistence; users edit Pi models externally, runtime only resolves via --model; not applicable",
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go::TestSaveConfig",
    "OCR saveConfig MkdirAll + 0600 JSON write and loadOrCreateConfig round-trip is omitted; pi-reviewer does not write Pi config files and does not mutate Pi config; users manage files externally, runtime only reads via public Pi APIs; Go permission/file write not applicable",
  ],
  [
    "cmd/opencodereview/provider_config_apply_test.go::TestApplyOfficialProviderConfig_Validation",
    "OCR applyOfficialProviderConfig validation that rejects empty provider/model or missing API key before test-connection is omitted; pi-reviewer does not expose the provider TUI/config apply flow; provider/model are supplied via review/scan --provider/--model and validated at runtime via Pi ModelRuntime createAgentSession; config-command validation is omitted, not applicable via Go file",
  ],
  [
    "cmd/opencodereview/provider_config_apply_test.go::TestSetCustomProviderValue",
    "OCR setCustomProviderValue for `custom_providers.<name>.<field>` malformed-key handling and custom provider materialization is omitted; pi-reviewer does not expose custom_providers config mutation and does not write Pi config; users define providers via external Pi files, runtime only loads via public Pi APIs; not applicable",
  ],
  [
    "internal/config/testconnection/testconnection_test.go::TestLoadDefault",
    "OCR LoadDefault conversation fixture (Timeout>0, system+user messages) for HTTP test-connection is omitted; pi-reviewer does not expose a test-connection command and does not use that fixture; users verify connectivity via external Pi tooling, runtime uses review/scan --provider/--model via ModelRuntime createAgentSession; fixture not applicable (language behavior covered separately via template applyLanguage)",
  ],
]);

// v1.9.9 additions and changed bodies in these files were reviewed as a group:
// each is solely an approved omitted provider catalog/TUI, credential command,
// or config-persistence mechanism. This table is intentionally path-explicit;
// no broad internal/llm exclusion is permitted because protocol, tool-choice,
// and usage behavior remains in scope.
const upgradeNotApplicableByPath: ReadonlyMap<string, string> = new Map<string, string>([
  ["cmd/opencodereview/apply_provider_field_test.go", "OCR v1.9.9 applyProviderField configuration persistence is not applicable: Pi owns provider and credential configuration through public APIs, and pi-reviewer deliberately omits this OCR command mutation."],
  ["cmd/opencodereview/bedrock_config_test.go", "OCR v1.9.9 Bedrock configuration persistence and provider-TUI flow are not applicable: Pi owns provider/model/auth runtime through public APIs, and pi-reviewer deliberately omits those OCR shells."],
  ["cmd/opencodereview/config_cmd_test.go", "OCR v1.9.9 config-command mutation and credential masking persistence are not applicable: Pi owns external configuration through public APIs, and pi-reviewer does not mutate OCR config."],
  ["cmd/opencodereview/provider_cmd_test.go", "OCR v1.9.9 provider-command persistence and credential mutation are not applicable: Pi owns provider/model/auth runtime through public APIs, and pi-reviewer deliberately omits this command."],
  ["internal/llm/bedrock_test.go", "OCR v1.9.9 Bedrock provider catalog and credential-resolution behavior are not applicable: Pi owns provider/model/auth runtime through public APIs, and pi-reviewer deliberately omits OCR provider catalogs."],
  ["internal/llm/keycmd_test.go", "OCR v1.9.9 API-key command execution is not applicable: Pi owns external credential resolution through public APIs, and pi-reviewer deliberately omits OCR credential commands."],
  ["internal/llm/keycmd_windows_test.go", "OCR v1.9.9 Windows API-key command execution is not applicable: Pi owns external credential resolution through public APIs, and pi-reviewer deliberately omits OCR credential commands."],
  ["internal/llm/providers_test.go", "OCR v1.9.9 provider catalog lookup and ordering are not applicable: Pi owns provider catalogs through public APIs, and pi-reviewer deliberately omits OCR provider catalogs."],
  ["internal/llm/resolver_keycmd_test.go", "OCR v1.9.9 endpoint API-key command resolution is not applicable: Pi owns external credential resolution through public APIs, and pi-reviewer deliberately omits OCR credential commands."],
  ["internal/llm/resolver_shellrc_test.go", "OCR v1.9.9 shell-profile credential resolution is not applicable: Pi owns external credential configuration through public APIs, and pi-reviewer deliberately omits OCR shell-profile loading."],
  ["internal/llm/resolver_test.go", "OCR v1.9.9 provider endpoint catalog and credential-resolution policy are not applicable: Pi owns provider/model/auth runtime through public APIs, and pi-reviewer deliberately omits those OCR provider mechanisms."],
]);

// Explicit scope decisions for paths that would otherwise be needs_decision.
// Each entry must state kind/area/reason; generator validates completeness.
// Empty initially — every needs_decision file will be flagged until triaged.
const scopeOverrides: ReadonlyMap<string, Scope> = new Map<string, Scope>([
  [
    "internal/pathutil/path_test.go",
    {
      kind: "in_scope",
      area: "diff",
      reason: "path traversal and symlink containment is core repository boundary for diff workspace and tool file access",
    },
  ],
  [
    "cmd/opencodereview/background_file_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "background file loading, sanitation, delimiters, limits and merge ordering are core CLI review input handling",
    },
  ],
  [
    "internal/config/toolsconfig/toolsconfig_test.go",
    {
      kind: "in_scope",
      area: "tool",
      reason: "tool configuration loading and phase filtering are core to advertised model capabilities and CLI --tools wiring",
    },
  ],
  [
    "cmd/opencodereview/flags_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "review flag parsing and validation for diff, budget, and output modes are core CLI review input handling",
    },
  ],
  [
    "cmd/opencodereview/git_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "git repository resolution, commit validation, and tool registry setup are core CLI review input handling",
    },
  ],
  [
    "internal/suggestdiff/diff_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "suggestdiff line diff is core CLI rendering for suggestion display; used by cmd/opencodereview/output.go via buildDiffLines",
    },
  ],
  [
    "cmd/opencodereview/misc_helpers_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "miscellaneous review/session CLI helpers (reviewModeFromOptions, sanitizeEndpointHost, shortSessionID, completeSessionIDs) are core CLI behavior",
    },
  ],
  [
    "cmd/opencodereview/arg_errors_test.go",
    {
      kind: "out_of_scope",
      area: "cmd/opencodereview",
      reason: "Cobra positional-argument families (config set <key> <value>, config unset <key>, rules check <file-path>, session show/comments <session-id>, delegate rule <path...>, completion <shell>) are omitted from Pi's reduced review/scan/version surface; friendly count errors and validators for those families are not applicable",
    },
  ],
  [
    "cmd/opencodereview/flag_suggest_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "flag typo suggestion via Levenshtein is core CLI error handling for review/scan flags",
    },
  ],
  [
    "cmd/opencodereview/parent_cmd_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "parent command help and unknown subcommand handling is core CLI routing for pi-review review/scan/version",
    },
  ],
  [
    "cmd/opencodereview/smallfiles_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "version string formatting and root help text are core CLI output for pi-review",
    },
  ],
  [
    "cmd/opencodereview/zero_args_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "zero-argument version command rejection is core CLI validation for pi-review version",
    },
  ],
  [
    "internal/stdout/stdout_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "stdout writer and quiet silencing are core CLI output boundary for stdout/stderr separation",
    },
  ],
  [
    "cmd/opencodereview/manual_e2e_retry_test.go",
    {
      kind: "in_scope",
      area: "cli-output",
      reason: "manual e2e retry report wiring is core CLI retry reporting via injected collector semantics",
    },
  ],
  [
    "internal/release/asset_naming_test.go",
    {
      kind: "out_of_scope",
      area: "internal/release",
      reason: "Go binary release archive naming (urlPattern/checksum/Makefile/release.yml) is replaced by Bun npm package distribution; not applicable via pi-reviewer distribution",
    },
  ],
  [
    "cmd/opencodereview/rules_check_test.go",
    {
      kind: "out_of_scope",
      area: "cmd/opencodereview",
      reason: "auxiliary rules check diagnostic command is intentionally not ported per approved scope decision; review/scan are supported surface",
    },
  ],
  [
    "cmd/opencodereview/config_cmd_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR config provider/model/MCP/telemetry command dispatch and persistence are intentionally omitted; pi-reviewer only resolves externally managed Pi configuration at runtime, with per-test not-applicable reasons recorded below",
    },
  ],
  [
    "cmd/opencodereview/provider_cmd_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR provider mutation, API-key display, and TUI wizard behavior are intentionally omitted; pi-reviewer does not mutate or display externally managed Pi configuration",
    },
  ],
  [
    "internal/config/testconnection/testconnection_test.go",
    {
      kind: "in_scope",
      area: "internal/config/testconnection",
      reason: "test-connection fixture and language mapping are examined per-test; Pi replaces HTTP test-connection with ModelRuntime",
    },
  ],
  [
    "cmd/opencodereview/config_dispatch_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR config command dispatch is intentionally omitted; pi-reviewer has no config command subtree",
    },
  ],
  [
    "cmd/opencodereview/config_runset_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR config set/unset persistence and display masking are intentionally omitted; pi-reviewer does not mutate or display externally managed Pi configuration",
    },
  ],
  [
    "cmd/opencodereview/provider_config_apply_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR provider-config mutation and validation commands are intentionally omitted; pi-reviewer only resolves externally managed provider/model configuration at runtime",
    },
  ],
  [
    "cmd/opencodereview/apply_provider_field_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR provider-field mutation is intentionally omitted; pi-reviewer does not edit externally managed Pi provider configuration",
    },
  ],
  [
    "cmd/opencodereview/config_unset_error_test.go",
    {
      kind: "in_scope",
      area: "cmd/opencodereview",
      reason: "OCR config-unset mutation and its config-file error paths are intentionally omitted; pi-reviewer does not expose config unset",
    },
  ],
]);

const localCoverage: readonly LocalCoverage[] = [
  {
    localPath: "test/ocr/llmloop/loop.test.ts",
    upstreamPaths: ["internal/llmloop/loop_test.go"],
  },
  {
    localPath: "test/ocr/llmloop/compression.test.ts",
    upstreamPaths: ["internal/llmloop/compression_test.go"],
  },
  {
    localPath: "test/ocr/llmloop/pool.test.ts",
    upstreamPaths: ["internal/llmloop/pool_test.go"],
  },
  {
    localPath: "test/ocr/llmloop/loop-phase5.test.ts",
    upstreamPaths: [
      "internal/llmloop/loop_test.go",
      "internal/llmloop/loop_execute_test.go",
      "internal/llmloop/loop_execute_more_test.go",
    ],
  },
  {
    localPath: "test/ocr/llmloop/runner-pending.test.ts",
    upstreamPaths: [
      "internal/llmloop/compression_test.go",
      "internal/llmloop/init_test.go",
      "internal/llmloop/loop_execute_more_test.go",
      "internal/llmloop/loop_execute_test.go",
      "internal/llmloop/loop_test.go",
      "internal/llmloop/pool_test.go",
      "internal/llmloop/retry_background_test.go",
      "internal/llmloop/retry_identity_test.go",
      "internal/llmloop/runner_test.go",
    ],
  },
  {
    localPath: "test/ocr/llmloop/identity.test.ts",
    upstreamPaths: ["internal/llmloop/retry_identity_test.go"],
  },
  {
    localPath: "test/ocr/diff/parser.test.ts",
    upstreamPaths: ["internal/diff/parser_test.go"],
  },
  {
    localPath: "test/ocr/diff/first-line.test.ts",
    upstreamPaths: ["internal/diff/first_line_test.go"],
  },
  {
    localPath: "test/ocr/diff/gitignore.test.ts",
    upstreamPaths: ["internal/diff/gitignore_test.go"],
  },
  {
    localPath: "test/ocr/diff/hunk.test.ts",
    upstreamPaths: ["internal/diff/hunk_test.go"],
  },
  {
    localPath: "test/ocr/diff/resolver.test.ts",
    upstreamPaths: ["internal/diff/resolver_test.go"],
  },
  {
    localPath: "test/ocr/diff/relocation.test.ts",
    upstreamPaths: ["internal/diff/relocation_test.go"],
  },
  {
    localPath: "test/ocr/tool/code-comment.test.ts",
    upstreamPaths: ["internal/tool/code_comment_test.go"],
  },
  {
    localPath: "test/ocr/tool/collector.test.ts",
    upstreamPaths: ["internal/tool/comment_collector_test.go"],
  },
  {
    localPath: "test/ocr/tool/definitions.test.ts",
    upstreamPaths: ["internal/tool/definitions_test.go"],
  },
  {
    localPath: "test/ocr/tool/response-message.test.ts",
    upstreamPaths: ["internal/tool/response_message_test.go"],
  },
  {
    localPath: "test/ocr/tool/stub.test.ts",
    upstreamPaths: ["internal/tool/stub_test.go"],
  },
  {
    localPath: "test/ocr/model/model.test.ts",
    upstreamPaths: ["internal/model/model_test.go"],
  },
  {
    localPath: "test/ocr/template/template.test.ts",
    upstreamPaths: ["internal/config/template/template_test.go"],
  },
  {
    localPath: "test/ocr/rules/allowed_ext.test.ts",
    upstreamPaths: ["internal/config/allowlist/allowed_ext_test.go"],
  },
  {
    localPath: "test/ocr/rules/system_rules.test.ts",
    upstreamPaths: ["internal/config/rules/system_rules_test.go"],
  },
  {
    localPath: "test/ocr/rules/resolve_github.test.ts",
    upstreamPaths: ["internal/config/rules/resolve_github_test.go"],
  },
  {
    localPath: "test/ocr/rules/system_rules_unmarshal.test.ts",
    upstreamPaths: ["internal/config/rules/system_rules_unmarshal_test.go"],
  },
  {
    localPath: "test/ocr/rules/canonical_config.test.ts",
    upstreamPaths: ["internal/config/rules/canonical_config_test.go"],
  },
  {
    localPath: "test/ocr/session/history.test.ts",
    upstreamPaths: ["internal/session/history_test.go"],
  },
  {
    localPath: "test/ocr/session/persist.test.ts",
    upstreamPaths: ["internal/session/persist_test.go"],
  },
  {
    localPath: "test/ocr/session/resume-identity.test.ts",
    upstreamPaths: ["internal/session/resume_identity_test.go"],
  },
  {
    localPath: "test/ocr/session/manifest.test.ts",
    upstreamPaths: ["internal/session/manifest_test.go"],
  },
  {
    localPath: "test/ocr/session/final-manifest.test.ts",
    upstreamPaths: ["internal/session/final_manifest_test.go"],
  },
  {
    localPath: "test/ocr/session/validate-scan.test.ts",
    upstreamPaths: ["internal/session/validate_scan_options_test.go"],
  },
  {
    localPath: "test/ocr/session/manifest-guards.test.ts",
    upstreamPaths: ["internal/session/manifest_guards_test.go"],
  },
  {
    localPath: "test/ocr/session/resume-orphan.test.ts",
    upstreamPaths: ["internal/session/resume_orphan_request_test.go"],
  },
  {
    localPath: "test/ocr/session/resume.test.ts",
    upstreamPaths: ["internal/session/resume_test.go"],
  },
  {
    localPath: "test/ocr/agent/budget.test.ts",
    upstreamPaths: ["internal/agent/budget_test.go"],
  },
  {
    localPath: "test/ocr/agent/coverage.test.ts",
    upstreamPaths: ["internal/agent/coverage_test.go"],
  },
  {
    localPath: "test/ocr/scan/batch.test.ts",
    upstreamPaths: ["internal/scan/batch_test.go"],
  },
  {
    localPath: "test/ocr/scan/budget.test.ts",
    upstreamPaths: ["internal/scan/budget_test.go"],
  },
  {
    localPath: "test/ocr/scan/dedup.test.ts",
    upstreamPaths: ["internal/scan/dedup_test.go"],
  },
  {
    localPath: "test/ocr/scan/coverage.test.ts",
    upstreamPaths: ["internal/scan/coverage_test.go"],
  },
  {
    localPath: "test/ocr/scan/agent.test.ts",
    upstreamPaths: ["internal/scan/agent_test.go"],
  },
  {
    localPath: "test/ocr/agent/estimate.test.ts",
    upstreamPaths: ["internal/agent/estimate_test.go"],
  },
  {
    localPath: "test/ocr/agent/getters.test.ts",
    upstreamPaths: ["internal/agent/getters_test.go"],
  },
  {
    localPath: "test/ocr/agent/util.test.ts",
    upstreamPaths: ["internal/agent/util_test.go"],
  },
  {
    localPath: "test/ocr/agent/preview.test.ts",
    upstreamPaths: ["internal/agent/preview_test.go"],
  },
  {
    localPath: "test/ocr/agent/preview-run.test.ts",
    upstreamPaths: ["internal/agent/preview_run_test.go"],
  },
  {
    localPath: "test/ocr/agent/manifest-hash.test.ts",
    upstreamPaths: ["internal/agent/manifest_hash_test.go"],
  },
  {
    localPath: "test/ocr/agent/helpers.test.ts",
    upstreamPaths: ["internal/agent/agent_test.go"],
  },
  {
    localPath: "test/ocr/agent/dispatch.test.ts",
    upstreamPaths: ["internal/agent/agent_test.go"],
  },
  {
    localPath: "test/ocr/agent/identity.test.ts",
    upstreamPaths: ["internal/agent/identity_test.go"],
  },
  {
    localPath: "test/ocr/agent/sealed-input.test.ts",
    upstreamPaths: ["internal/agent/sealed_input_test.go"],
  },
  {
    localPath: "test/ocr/agent/retry-identity.test.ts",
    upstreamPaths: ["internal/agent/retry_identity_test.go"],
  },
  {
    localPath: "test/ocr/agent/manifest-integration.test.ts",
    upstreamPaths: ["internal/agent/manifest_integration_test.go"],
  },
  {
    localPath: "test/ocr/scan/provider.test.ts",
    upstreamPaths: ["internal/scan/provider_test.go", "internal/scan/provider_more_test.go"],
  },
  {
    localPath: "test/ocr/scan/estimate.test.ts",
    upstreamPaths: ["internal/scan/estimate_test.go"],
  },
  {
    localPath: "test/ocr/scan/getters.test.ts",
    upstreamPaths: ["internal/scan/getters_test.go", "internal/scan/getters_more_test.go"],
  },
  {
    localPath: "test/ocr/scan/retry-identity.test.ts",
    upstreamPaths: ["internal/scan/retry_identity_test.go"],
  },
  {
    localPath: "test/ocr/pathutil/path.test.ts",
    upstreamPaths: ["internal/pathutil/path_test.go"],
  },
  {
    localPath: "test/ocr/gitcmd/runner.test.ts",
    upstreamPaths: ["internal/gitcmd/runner_test.go"],
  },
  {
    localPath: "test/ocr/diff/workspace-file.test.ts",
    upstreamPaths: ["internal/diff/workspace_file_test.go"],
  },
  {
    localPath: "test/ocr/diff/git-resolve.test.ts",
    upstreamPaths: ["internal/diff/git_resolve_test.go"],
  },
  {
    localPath: "test/ocr/diff/git-boundaries.test.ts",
    upstreamPaths: ["internal/diff/git_test.go"],
  },
  {
    localPath: "test/ocr/tool/filereader-read.test.ts",
    upstreamPaths: ["internal/tool/filereader_read_test.go"],
  },
  {
    localPath: "test/ocr/tool/file-read.test.ts",
    upstreamPaths: ["internal/tool/file_read_test.go"],
  },
  {
    localPath: "test/ocr/tool/file-read-diff.test.ts",
    upstreamPaths: ["internal/tool/file_read_diff_test.go"],
  },
  {
    localPath: "test/ocr/tool/file-find.test.ts",
    upstreamPaths: ["internal/tool/file_find_test.go"],
  },
  {
    localPath: "test/ocr/tool/code-search.test.ts",
    upstreamPaths: ["internal/tool/code_search_test.go"],
  },
  {
    localPath: "test/ocr/tool/filereader.test.ts",
    upstreamPaths: ["internal/tool/filereader_test.go"],
  },
  {
    localPath: "test/ocr/session/comments.test.ts",
    upstreamPaths: ["internal/session/comments_test.go"],
  },
  {
    localPath: "test/ocr/session/list.test.ts",
    upstreamPaths: ["internal/session/list_test.go"],
  },
  {
    localPath: "test/ocr/session/list-more.test.ts",
    upstreamPaths: ["internal/session/list_more_test.go"],
  },
  {
    localPath: "test/ocr/session/list-error.test.ts",
    upstreamPaths: ["internal/session/list_error_test.go"],
  },
  {
    localPath: "test/ocr/cli/output-helpers.test.ts",
    upstreamPaths: ["cmd/opencodereview/output_helpers_test.go"],
  },
  {
    localPath: "test/ocr/cli/output-manifest.test.ts",
    upstreamPaths: ["cmd/opencodereview/output_manifest_test.go"],
  },
  {
    localPath: "test/ocr/cli/output.test.ts",
    upstreamPaths: ["cmd/opencodereview/output_test.go"],
  },
  {
    localPath: "test/ocr/cli/shared.test.ts",
    upstreamPaths: ["cmd/opencodereview/shared_test.go"],
  },
  {
    localPath: "test/ocr/cli/shared-llmruntime.test.ts",
    upstreamPaths: ["cmd/opencodereview/shared_llmruntime_test.go"],
  },
  {
    localPath: "test/ocr/cli/sarif.test.ts",
    upstreamPaths: ["cmd/opencodereview/sarif_test.go"],
  },
  {
    localPath: "test/ocr/cli/emit-run-result.test.ts",
    upstreamPaths: ["cmd/opencodereview/emit_run_result_test.go"],
  },
  {
    localPath: "test/ocr/cli/budget-output.test.ts",
    upstreamPaths: ["cmd/opencodereview/budget_output_test.go"],
  },
  {
    localPath: "test/ocr/cli/retry-e2e.test.ts",
    upstreamPaths: ["cmd/opencodereview/retry_report_e2e_test.go", "cmd/opencodereview/manual_e2e_retry_test.go"],
  },
  {
    localPath: "test/ocr/cli/session-cmd.test.ts",
    upstreamPaths: ["cmd/opencodereview/session_cmd_test.go"],
  },
  {
    localPath: "test/ocr/cli/session-display.test.ts",
    upstreamPaths: ["cmd/opencodereview/session_display_more_test.go"],
  },
  {
    localPath: "test/ocr/cli/session-complete.test.ts",
    upstreamPaths: ["cmd/opencodereview/session_complete_test.go"],
  },
  {
    localPath: "test/ocr/cli/review-cmd.test.ts",
    upstreamPaths: ["cmd/opencodereview/review_cmd_test.go"],
  },
  {
    localPath: "test/ocr/cli/review-helpers.test.ts",
    upstreamPaths: ["cmd/opencodereview/review_helpers_test.go"],
  },
  {
    localPath: "test/ocr/cli/review-resume.test.ts",
    upstreamPaths: ["cmd/opencodereview/review_resume_more_test.go"],
  },
  {
    localPath: "test/ocr/cli/scan-cmd.test.ts",
    upstreamPaths: ["cmd/opencodereview/scan_cmd_test.go"],
  },
  {
    localPath: "test/ocr/cli/scan-helpers.test.ts",
    upstreamPaths: ["cmd/opencodereview/scan_helpers_test.go"],
  },
  {
    localPath: "test/ocr/cli/scan-resume.test.ts",
    upstreamPaths: ["cmd/opencodereview/scan_resume_more_test.go"],
  },
  {
    localPath: "test/ocr/cli/background-file.test.ts",
    upstreamPaths: ["cmd/opencodereview/background_file_test.go"],
  },
  {
    localPath: "test/ocr/tool/toolsconfig.test.ts",
    upstreamPaths: ["internal/config/toolsconfig/toolsconfig_test.go"],
  },
  {
    localPath: "test/ocr/cli/review-flags.test.ts",
    upstreamPaths: ["cmd/opencodereview/flags_test.go"],
  },
  {
    localPath: "test/ocr/cli/git.test.ts",
    upstreamPaths: ["cmd/opencodereview/git_test.go"],
  },
  {
    localPath: "test/ocr/cli/suggestdiff.test.ts",
    upstreamPaths: ["internal/suggestdiff/diff_test.go"],
  },
  {
    localPath: "test/ocr/cli/misc-helpers.test.ts",
    upstreamPaths: ["cmd/opencodereview/misc_helpers_test.go"],
  },
  {
    localPath: "test/ocr/cli/flag-suggest.test.ts",
    upstreamPaths: ["cmd/opencodereview/flag_suggest_test.go"],
  },
  {
    localPath: "test/ocr/cli/smallfiles.test.ts",
    upstreamPaths: ["cmd/opencodereview/smallfiles_test.go"],
  },
  {
    localPath: "test/ocr/cli/parent-cmd.test.ts",
    upstreamPaths: ["cmd/opencodereview/parent_cmd_test.go"],
  },
  {
    localPath: "test/ocr/cli/zero-args.test.ts",
    upstreamPaths: ["cmd/opencodereview/zero_args_test.go"],
  },
];

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", upstreamRepo, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function sourceAtPin(path: string): string {
  return git("show", `${reference.commit}:${path}`);
}

function classifyScope(path: string): Scope {
  const prefixAreas: readonly [string, Area][] = [
    ["internal/model/", "model"],
    ["internal/config/template/", "template"],
    ["internal/config/allowlist/", "rules"],
    ["internal/config/rules/", "rules"],
    ["internal/diff/", "diff"],
    ["internal/gitcmd/", "git"],
    ["internal/tool/", "tool"],
    ["internal/llmloop/", "llmloop"],
    ["internal/agent/", "agent"],
    ["internal/scan/", "scan"],
    ["internal/session/", "session"],
    ["internal/llm/", "pi-adapter"],
  ];
  for (const [prefix, area] of prefixAreas) {
    if (path.startsWith(prefix)) return { kind: "in_scope", area };
  }

  const deferredPrefixes: readonly [string, string][] = [
    ["internal/viewer/", "browser session viewer is an explicitly deferred shell"],
    ["internal/telemetry/", "telemetry export is explicitly deferred"],
    ["internal/mcp/", "MCP integration is explicitly deferred"],
    ["internal/delegate/", "delegate integration is explicitly deferred"],
  ];
  for (const [prefix, reason] of deferredPrefixes) {
    if (path.startsWith(prefix)) return { kind: "out_of_scope", area: prefix.slice(0, -1), reason };
  }

  if (
    path.startsWith("cmd/opencodereview/provider_tui_")
    || path.startsWith("cmd/opencodereview/delegate_")
    || path === "cmd/opencodereview/review_mcp_more_test.go"
  ) {
    return {
      kind: "out_of_scope",
      area: "cmd/opencodereview",
      reason: "provider TUI, MCP, and delegate command shells are explicitly deferred",
    };
  }

  if (path.startsWith("cmd/opencodereview/")) {
    const basename = path.slice("cmd/opencodereview/".length);
    const corePrefixes = [
      "budget_output_",
      "emit_run_result_",
      "output",
      "retry_report_",
      "review_cmd_",
      "review_helpers_",
      "review_resume_",
      "sarif_",
      "scan_cmd_",
      "scan_helpers_",
      "scan_resume_",
      "session_",
      "shared_",
    ];
    if (corePrefixes.some((prefix) => basename.startsWith(prefix))) {
      return { kind: "in_scope", area: "cli-output" };
    }
  }

  return {
    kind: "needs_decision",
    area: path.split("/").slice(0, 2).join("/"),
    reason: "not yet classified by the OCR v1.9.3 core-port source map",
  };
}

export interface LocalAnnotation {
  readonly name: string;
  readonly title: string;
  readonly ocrVersion: OcrEvidenceVersion;
}

export function annotations(localPath: string): readonly LocalAnnotation[] {
  const absolutePath = resolve(repoRoot, localPath);
  if (!existsSync(absolutePath)) return [];
  const source = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(localPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: LocalAnnotation[] = [];

  const isTestCall = (node: ts.CallExpression): boolean => {
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text === "test" || node.expression.text === "it" || node.expression.text === "describe";
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      if (prop.name.text === "serial" && ts.isIdentifier(prop.expression) && (prop.expression.text === "test" || prop.expression.text === "it" || prop.expression.text === "describe")) return true;
    }
    if (!ts.isCallExpression(node.expression) || !ts.isPropertyAccessExpression(node.expression.expression)) {
      return false;
    }
    const owner = node.expression.expression.expression;
    const method = node.expression.expression.name.text;
    return ts.isIdentifier(owner)
      && (owner.text === "test" || owner.text === "it" || owner.text === "describe")
      && (method === "each" || method === "skipIf" || method === "runIf" || method === "serial");
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const titleNode = node.arguments[0];
      if (titleNode !== undefined && ts.isStringLiteralLike(titleNode)) {
        const statement = ts.isExpressionStatement(node.parent) ? node.parent : node;
        const comments = ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? [];
        const annotations = comments
          .map((range) => source.slice(range.pos, range.end).match(/OCR (v1\.9\.[39]): (Test[A-Za-z0-9_]+)/))
          .filter((match): match is RegExpMatchArray => match !== null);
        for (const annotation of annotations) {
          const [, ocrVersion, name] = annotation;
          if ((ocrVersion !== "v1.9.3" && ocrVersion !== "v1.9.9") || name === undefined) {
            throw new Error(`invalid OCR annotation in ${localPath}`);
          }
          result.push({ name, title: titleNode.text, ocrVersion });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const rawAnnotations = [...source.matchAll(/^\s*\/\/ OCR (v1\.9\.[39]): (Test[A-Za-z0-9_]+)\s*$/gm)]
    .map((match) => ({ ocrVersion: match[1], name: match[2] }))
    .filter((annotation): annotation is { readonly ocrVersion: OcrEvidenceVersion; readonly name: string } =>
      (annotation.ocrVersion === "v1.9.3" || annotation.ocrVersion === "v1.9.9") && annotation.name !== undefined,
    );
  if (rawAnnotations.length !== result.length) {
    throw new Error(
      `${localPath} has ${rawAnnotations.length} OCR annotations but only ${result.length} are attached to test()/it() calls`,
    );
  }
  return result;
}

export function evidenceApplicableToDelta(
  delta: Exclude<DeltaKind, "removed">,
  evidence: readonly Evidence[],
): readonly Evidence[] {
  if (delta === "byte_identical") return evidence;
  return evidence.filter((item) => item.ocrVersion === "v1.9.9");
}

function legacyEvidence(evidence: readonly LegacyEvidence[]): readonly Evidence[] {
  return evidence.map((item) => ({ ...item, ocrVersion: "v1.9.3" }));
}

function coverageByTestId(
  testNamesByPath: ReadonlyMap<string, ReadonlySet<string>>,
  delta: OcrTestDelta,
): ReadonlyMap<string, readonly Evidence[]> {
  const result = new Map<string, Evidence[]>();
  const removedTestIds = new Set(
    delta.tests
      .filter((test) => test.kind === "removed")
      .map((test) => `${test.path}::${test.name}`),
  );

  for (const mapping of localCoverage) {
    const localAnnotations = annotations(mapping.localPath);
    const seen = new Map<string, Set<string>>();
    for (const annotation of localAnnotations) {
      const annotationId = `${annotation.ocrVersion}:${annotation.name}`;
      const set = seen.get(annotationId) ?? new Set<string>();
      if (set.has(annotation.title)) {
        throw new Error(`${mapping.localPath} has duplicate OCR annotation ${annotationId} with title "${annotation.title}"`);
      }
      set.add(annotation.title);
      seen.set(annotationId, set);
    }

    for (const annotation of localAnnotations) {
      const name = annotation.name;
      const matchingPaths = mapping.upstreamPaths.filter((path) => testNamesByPath.get(path)?.has(name) === true);
      if (matchingPaths.length === 0) {
        // Allow annotations that are satisfied via equivalentTests (e.g.,
        // testconnection language tests mapped to template tests)
        let isEquivalent = false;
        for (const [key, ev] of equivalentTests) {
          const [, eqName] = key.split("::");
          if (eqName === name) {
            for (const e of ev) {
              if (e.path === mapping.localPath && e.title === annotation.title) {
                isEquivalent = true;
                break;
              }
            }
          }
          if (isEquivalent) break;
        }
        if (isEquivalent) continue;
        const retiredIds = mapping.upstreamPaths.map((path) => `${path}::${name}`);
        if (retiredIds.length > 0 && retiredIds.every((id) => removedTestIds.has(id))) continue;
        throw new Error(
          `${mapping.localPath} annotation ${name} matched ${matchingPaths.length} configured upstream files`,
        );
      }
      if (matchingPaths.length !== 1) {
        throw new Error(
          `${mapping.localPath} annotation ${name} matched ${matchingPaths.length} configured upstream files`,
        );
      }
      const id = `${matchingPaths[0]}::${name}`;
      const evidence = result.get(id) ?? [];
      evidence.push({
        kind: "bun-test-annotation",
        path: mapping.localPath,
        title: annotation.title,
        ocrVersion: annotation.ocrVersion,
      });
      result.set(id, evidence);
    }
  }

  return result;
}

function validateOverrides(
  testNamesByPath: ReadonlyMap<string, ReadonlySet<string>>,
  delta: OcrTestDelta,
): void {
  const removedTestIds = new Set(
    delta.tests
      .filter((test) => test.kind === "removed")
      .map((test) => `${test.path}::${test.name}`),
  );
  for (const [key, evidence] of equivalentTests) {
    const [path, name] = key.split("::");
    if (!path || !name) throw new Error(`equivalentTests key must be "path::TestName", got ${JSON.stringify(key)}`);
    const names = testNamesByPath.get(path);
    if (!names || !names.has(name)) {
      if (removedTestIds.has(key)) continue;
      throw new Error(`equivalentTests references unknown active test ${key}`);
    }
    if (evidence.length === 0) throw new Error(`equivalentTests ${key} has no evidence`);
    for (const e of evidence) {
      if (e.kind !== "bun-test-annotation") throw new Error(`equivalentTests ${key} evidence kind must be bun-test-annotation`);
      if (!existsSync(resolve(repoRoot, e.path))) throw new Error(`equivalentTests ${key} evidence path does not exist: ${e.path}`);
    }
  }
  for (const [key, evidence] of upgradeEquivalentTests) {
    const [path, name] = key.split("::");
    if (!path || !name) throw new Error(`upgradeEquivalentTests key must be "path::TestName", got ${JSON.stringify(key)}`);
    if (!testNamesByPath.get(path)?.has(name)) throw new Error(`upgradeEquivalentTests references unknown active test ${key}`);
    const deltaEntry = delta.tests.find((test) => test.path === path && test.name === name);
    if (deltaEntry?.kind !== "added" && deltaEntry?.kind !== "changed_body") {
      throw new Error(`upgradeEquivalentTests ${key} requires an added or changed-body v1.9.9 test`);
    }
    if (evidence.length === 0) throw new Error(`upgradeEquivalentTests ${key} has no v1.9.9 evidence`);
    for (const e of evidence) {
      if (e.kind !== "bun-test-annotation" || e.ocrVersion !== "v1.9.9") {
        throw new Error(`upgradeEquivalentTests ${key} evidence must be a v1.9.9 bun-test-annotation`);
      }
      const source = readFileSync(resolve(repoRoot, e.path), "utf8");
      if (!source.includes(`// OCR v1.9.9: ${name}`) || !source.includes(`"${e.title}"`)) {
        throw new Error(`upgradeEquivalentTests ${key} evidence is not directly attached in ${e.path}`);
      }
    }
  }
  for (const [key, reason] of notApplicableTests) {
    const [path, name] = key.split("::");
    if (!path || !name) throw new Error(`notApplicableTests key must be "path::TestName", got ${JSON.stringify(key)}`);
    const names = testNamesByPath.get(path);
    if (!names || !names.has(name)) {
      if (removedTestIds.has(key)) continue;
      throw new Error(`notApplicableTests references unknown active test ${key}`);
    }
    if (reason.length < 20) throw new Error(`notApplicableTests ${key} reason too short`);
    const lower = reason.toLowerCase();
    if (!lower.includes("pi replaces") && !lower.includes("not applicable") && !lower.includes("deferred")) {
      throw new Error(`notApplicableTests ${key} reason must mention "Pi replaces", "not applicable" or "deferred" with concrete rationale`);
    }
  }
  for (const [path, scope] of scopeOverrides) {
    if (!testNamesByPath.has(path)) {
      const fileWasRemoved = delta.tests.some((test) => test.path === path && test.kind === "removed");
      if (fileWasRemoved) continue;
      throw new Error(`scopeOverrides references unknown active file ${path}`);
    }
    if (!scope.area || !scope.kind) throw new Error(`scopeOverrides ${path} missing area/kind`);
  }
  for (const [path, reason] of upgradeNotApplicableByPath) {
    const names = testNamesByPath.get(path);
    if (names === undefined) throw new Error(`upgradeNotApplicableByPath references unknown active file ${path}`);
    const hasUpgradeDelta = [...names].some((name) => {
      const deltaEntry = delta.tests.find((test) => test.path === path && test.name === name);
      return deltaEntry?.kind === "added" || deltaEntry?.kind === "changed_body";
    });
    if (!hasUpgradeDelta) throw new Error(`upgradeNotApplicableByPath ${path} has no v1.9.9 added or changed test`);
    if (reason.length < 20 || !reason.toLowerCase().includes("not applicable")) {
      throw new Error(`upgradeNotApplicableByPath ${path} must state its concrete not-applicable boundary`);
    }
  }
}

function effectiveScope(path: string): Scope {
  const override = scopeOverrides.get(path);
  if (override !== undefined) return override;
  return classifyScope(path);
}

function generateInventory(): Inventory {
  const delta = generateOcrTestDelta();
  const deltaByTestId = deltaByActiveTestId(delta);
  const actualTagObject = git("rev-parse", `${reference.tag}^{tag}`).trim();
  const actualCommit = git("rev-parse", `${reference.tag}^{commit}`).trim();
  if (actualTagObject !== reference.tagObject || actualCommit !== reference.commit) {
    throw new Error(
      `OCR reference mismatch: tag=${actualTagObject} commit=${actualCommit}`,
    );
  }
  const signature = spawnSync("git", ["-C", upstreamRepo, "verify-tag", reference.tag], { encoding: "utf8" });
  if (!`${signature.stdout}${signature.stderr}`.includes("Good")) {
    throw new Error(`OCR tag signature did not verify as Good: ${signature.stdout}${signature.stderr}`);
  }

  const treeLines = git("ls-tree", "-r", reference.commit)
    .trim()
    .split("\n")
    .filter((line) => line.endsWith("_test.go"));
  const blobs = new Map<string, string>();
  const testNamesByPath = new Map<string, ReadonlySet<string>>();

  for (const line of treeLines) {
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+_test\.go)$/);
    if (match === null) throw new Error(`unexpected git ls-tree line: ${line}`);
    const blob = match[1];
    const path = match[2];
    if (blob === undefined || path === undefined) throw new Error(`incomplete git ls-tree line: ${line}`);
    const declarations = extractGoTestDeclarations(sourceAtPin(path));
    const names = declarations.map((declaration) => declaration.name);
    if (new Set(names).size !== names.length) throw new Error(`${path} contains duplicate top-level test names`);
    blobs.set(path, blob);
    testNamesByPath.set(path, new Set(names));
  }

  validateOverrides(testNamesByPath, delta);

  const evidence = coverageByTestId(testNamesByPath, delta);
  const files = [...blobs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, blob]): InventoryFile => {
      const scope = effectiveScope(path);
      const names = [...(testNamesByPath.get(path) ?? [])].sort((left, right) => left.localeCompare(right));
      const tests = names.map((name): InventoryTest => {
        const id = `${path}::${name}`;
        const change = deltaByTestId.get(id);
        if (change === undefined || change === "removed") throw new Error(`active test ${id} is absent from delta`);
        if (change === "added" || change === "changed_body") {
          const scope = effectiveScope(path);
          const directEvidence = evidenceApplicableToDelta(change, evidence.get(id) ?? []);
          if (directEvidence.length > 0) {
            return { name, delta: change, disposition: "covered", evidence: directEvidence };
          }
          const revalidationEvidence = upgradeEquivalentTests.get(id);
          if (revalidationEvidence !== undefined) {
            return {
              name,
              delta: change,
              disposition: "equivalent",
              evidence: revalidationEvidence,
              reason: `v1.9.9 revalidated equivalent via ${revalidationEvidence.map((item) => item.path).join(", ")}`,
            };
          }
          const omissionReason = upgradeNotApplicableByPath.get(path);
          if (omissionReason !== undefined) {
            return {
              name,
              delta: change,
              disposition: "not_applicable",
              reason: omissionReason,
            };
          }
          if (scope.kind === "out_of_scope") {
            return {
              name,
              delta: change,
              disposition: "out_of_scope",
              reason: scope.reason,
            };
          }
          return {
            name,
            delta: change,
            disposition: "pending",
            reason: `OCR v1.9.9 ${change.replace("_", " ")} requires explicit new evidence or revalidation; prior v1.9.3 coverage is not inherited.`,
          };
        }
        const testEvidence = evidence.get(id);
        if (testEvidence !== undefined) return { name, delta: change, disposition: "covered", evidence: testEvidence };
        const equivEvidence = equivalentTests.get(id);
        if (equivEvidence !== undefined) return { name, delta: change, disposition: "equivalent", evidence: legacyEvidence(equivEvidence), reason: `equivalent via ${equivEvidence.map((e) => e.path).join(", ")}` };
        const naReason = notApplicableTests.get(id);
        if (naReason !== undefined) return { name, delta: change, disposition: "not_applicable", reason: naReason };
        if (scope.kind === "out_of_scope") return { name, delta: change, disposition: "out_of_scope", reason: scope.reason };
        if (scope.kind === "needs_decision") return { name, delta: change, disposition: "pending_scope", reason: scope.reason };
        return { name, delta: change, disposition: "pending", reason: "OCR-derived test translation has not been recorded" };
      });
      return { path, blob, scope, tests };
    });

  // Validate every equivalent/not_applicable/covered evidence actually contains the OCR annotation
  for (const file of files) {
    for (const t of file.tests) {
      if ((t.disposition === "covered" || t.disposition === "equivalent") && t.evidence) {
        for (const e of t.evidence) {
          const src = readFileSync(resolve(repoRoot, e.path), "utf8");
          if (!src.includes(`// OCR v1.9.3: ${t.name}`)) {
            throw new Error(`Evidence ${e.path} does not contain annotation for ${file.path}::${t.name}`);
          }
        }
      }
      if (t.disposition === "not_applicable" && (!t.reason || t.reason.length < 20)) {
        throw new Error(`not_applicable ${file.path}::${t.name} missing rationale`);
      }
    }
  }

  return {
    schemaVersion: 3,
    reference,
    previousReference,
    delta: { path: "docs/ocr-upstream-test-delta.json", totals: delta.totals },
    files,
  };
}

function serializedInventory(): string {
  return `${JSON.stringify(generateInventory(), null, 2)}\n`;
}

function summary(inventory: Inventory): string {
  const counts = new Map<string, number>();
  for (const file of inventory.files) {
    for (const test of file.tests) counts.set(test.disposition, (counts.get(test.disposition) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([disposition, count]) => `${disposition}=${count}`)
    .join(" ");
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const generated = serializedInventory();
  if (args.has("--check")) {
    if (!existsSync(inventoryPath) || readFileSync(inventoryPath, "utf8") !== generated) {
      console.error("OCR v1.9.9 test inventory is stale; run bun run scripts/generate-ocr-test-inventory.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(inventoryPath, generated);
  }

  const inventory = JSON.parse(generated) as Inventory;
  console.error(`[ocr-test-inventory] files=${inventory.files.length} ${summary(inventory)}`);
  if (args.has("--require-complete")) {
    const incomplete = inventory.files.flatMap((file) =>
      file.tests
        .filter((test) => test.disposition === "pending" || test.disposition === "pending_scope")
        .map((test) => `${file.path}::${test.name} (${test.disposition})`),
    );
    if (incomplete.length > 0) {
      console.error(`[ocr-test-inventory] incomplete=${incomplete.length}`);
      for (const id of incomplete.slice(0, 20)) console.error(`  ${id}`);
      if (incomplete.length > 20) console.error(`  ... and ${incomplete.length - 20} more`);
      process.exit(1);
    }
  }
}
