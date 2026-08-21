// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates the exhaustive OCR v1.9.3 upstream-test inventory. The upstream
// tree is read only through the pinned Git object; its working tree is ignored.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { extractGoTestDeclarations } from "../test/ocr-v193/support/go-test-declarations.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRepo = resolve(repoRoot, "../open-code-review");
const inventoryPath = resolve(repoRoot, "docs/ocr-v193-upstream-test-inventory.json");

const reference = {
  tag: "v1.9.3",
  tagObject: "4d796ae54cabdcf4e22b69ef502ed8871456a909",
  commit: "c35ddd7223f2b5540ce03aa43c9a25ef643fca27",
} as const;

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

interface Evidence {
  readonly kind: "bun-test-annotation";
  readonly path: string;
  readonly title: string;
}

type Disposition = "covered" | "equivalent" | "not_applicable" | "pending" | "pending_scope" | "out_of_scope";

interface InventoryTest {
  readonly name: string;
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
  readonly schemaVersion: 2;
  readonly reference: typeof reference;
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
const equivalentTests: ReadonlyMap<string, readonly Evidence[]> = new Map<string, readonly Evidence[]>([
  [
    "internal/llm/protocol_test.go::TestNormalizeProtocol",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/protocol.test.ts", title: "normalizeProtocol canonicalizes known protocols case-insensitively and trims" }],
  ],
  [
    "internal/llm/protocol_test.go::TestValidateProtocol",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/protocol.test.ts", title: "validateProtocol accepts canonical names and rejects others" }],
  ],
  [
    "internal/llm/protocol_test.go::TestValidateProtocol_ErrorMessageListsAllProtocols",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/protocol.test.ts", title: "validateProtocol error message enumerates every canonical protocol" }],
  ],
  [
    "internal/llm/client_test.go::TestStripThinkTags",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/strip-think-tags.test.ts", title: "stripThinkTags removes think wrapper tags globally" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_StripsThinkTags",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/strip-think-tags.test.ts", title: "ChatResponse content strips think tags before trimming" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_FallbackToReasoning",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/strip-think-tags.test.ts", title: "content empty falls back to reasoning content" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildToolInputSchema",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/tool-schema.test.ts", title: "buildToolInputSchema preserves object-root guarantees and filters required" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildToolInputSchema_Empty",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/tool-schema.test.ts", title: "buildToolInputSchema empty input stays empty" }],
  ],
  [
    "internal/llm/message_test.go::TestNewTextMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "newTextMessage creates user message with role and content" }],
  ],
  [
    "internal/llm/message_test.go::TestNewToolCallMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "tool call message preserves tool calls and copies" }],
  ],
  [
    "internal/llm/message_test.go::TestNewToolCallMessage_NilCalls",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "tool call message with no tool_calls has undefined or empty" }],
  ],
  [
    "internal/llm/message_test.go::TestNewToolResultMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "tool result message has tool role and call id" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_String",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "extractText returns string content verbatim" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_ContentBlocks",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "extractText concatenates content blocks" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_NestedContentBlocks",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "extractText handles nested content blocks" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_NilContent",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "extractText empty content returns empty" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "ChatResponse content mirrors extractText for assistant message" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_ToolCalls",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "ChatResponse toolCalls extracted from toolCall blocks" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageOpenAICompatibleCachedTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/usage.test.ts", title: "mapPiUsage maps OpenAI cached tokens as cacheRead without double counting total" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageWrappedCachedTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/usage.test.ts", title: "mapPiUsage maps cache write via cacheWrite" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageWrappedAnthropicCompatibleCacheTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/usage.test.ts", title: "mapPiUsage maps Anthropic separate cache and total" }],
  ],
  [
    "internal/llm/usage_resolver_test.go::TestResolveUsageResponsesAPIFieldNames",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/usage.test.ts", title: "mapPiUsage handles Responses API via Pi normalized input/output" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingUsage",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/usage.test.ts", title: "PiTransport captures streaming usage via turn_end assistant message" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_Empty",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/usage.test.ts", title: "empty Pi usage object yields undefined" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_Content_NilContent",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "ChatResponse nil content falls back to reasoning" }],
  ],
  [
    "internal/llm/message_test.go::TestChatResponse_ToolCalls_Empty",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "ChatResponse empty toolCalls returns empty array" }],
  ],
  [
    "internal/llm/message_test.go::TestExtractText_Default",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/message.test.ts", title: "extractText default non-string returns empty" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildOpenAIParams_AllRoles",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/build-params.test.ts", title: "ChatRequest role handling covers system/user/tool/assistant/unknown via Pi translation" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildOpenAIParams_Minimal",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/build-params.test.ts", title: "ChatRequest minimal tools stays unset" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildAnthropicParams_DefaultMaxTokens",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/build-params.test.ts", title: "anthropic default maxTokens fallback is handled via Pi model defaults" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildAnthropicParams_InvalidToolArgs",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/build-params.test.ts", title: "invalid tool call arguments are handled without throwing" }],
  ],
  [
    "internal/llm/client_params_test.go::TestBuildAnthropicParams_AllRoles",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/build-params.test.ts", title: "anthropic role branches mirror openai via Pi translation" }],
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_ContextSessionKeyOverridesFallback",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestAnthropicClient_SessionKeyExpandedInExtraHeadersAndBody",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestNewLLMClient_ExpandsSessionKeyInExtraBody",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_ContextSessionKeyOverridesFallback",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_SessionKeyExpandedInExtraBody",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_SessionKeyExpandedInExtraHeaders",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_SessionKeyGeneratedWhenEmpty",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_NoInjectionWithoutPlaceholder",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-affinity-loopback.test.ts", title: "session affinity via SessionManager id reaches provider request (loopback)" }],
  ],
  [
    "internal/llm/client_test.go::TestOpenAIClient_StreamingCancellation",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter.test.ts", title: "PiTransport forwards abort signal to session.abort" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestNewSessionKey",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-key.test.ts", title: "newSessionKey returns UUIDv4 and uniqueness" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestSessionTaskKey",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-key.test.ts", title: "sessionTaskKey derives task-scoped keys with hash" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestExpandSessionKeyInHeaders",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-key.test.ts", title: "expandSessionKeyInHeaders replaces placeholder without mutating input" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestExpandSessionKeyInBody",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-key.test.ts", title: "expandSessionKeyInBody replaces recursively without mutating" }],
  ],
  [
    "internal/llm/sessionkey_test.go::TestSessionKeyContext",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter/session-key.test.ts", title: "sessionTaskKey override semantics via sessionId" }],
  ],

// ---- retry meta: deterministic metadata/hash contracts (transport-independent) ----
  [
    "internal/llm/retry_meta_test.go::TestRequestMetaValid",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "RequestMeta valid cases" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDIsDeterministic",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "logicalRequestID is deterministic and 64 hex chars" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDSeparatesFields",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "logicalRequestID separates fields" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDVariesWithRunIDAndRequestNo",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "logicalRequestID varies with runId and requestNo" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestLogicalRequestIDCanonicalEncoding",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "logicalRequestID canonical encoding" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestRequestMetaDescribe",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "describeRequestMeta contains file/task/request_no" }],
  ],
  [
    "internal/llm/retry_meta_test.go::TestWithRequestMeta",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/meta.test.ts", title: "withRequestMeta round trip" }],
  ],
  // ---- retry boundary: error/status/body truncation and boundary classification ----
  [
    "internal/llm/retry_boundary_test.go::TestClassifyBoundaryError",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "classifyBoundaryError contracts" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestClassifyStreamError",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "classifyStreamError always returns classification" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestStreamIntegrityErrorMessage",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "StreamIntegrityError message" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestFinalizeRequestWithPanicSentinel",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "finalizeRequest with panic sentinel produces failed" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryHelpersAreInertWithoutCollectorOrMeta",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "boundary helpers are inert without collector or meta" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsTruncatedResponse",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "reviseAttempt corrects truncated response" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryKeepsHTTPClassOnCorruptErrorBody",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "reviseAttempt keeps HTTP class when already error" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsDecodeFailure",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "decode failure correction is unknown/response_decode" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsMidStreamFailure",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "responses status correction maps to provider/response_status" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryKeepsHTTPClassOnStreamThatNeverOpened",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "reviseAttempt keeps HTTP class when already error" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCorrectsResponsesStatus",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "responses status correction maps to provider/response_status" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryCancelDuringBackoffIsCancelled",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "finalize decides cancelled vs failed correctly" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryRetryAfterOutlivingAttemptTimeoutIsFailed",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "deadline exceeded is failed not cancelled" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryDeadlineExceededIsFailed",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "deadline exceeded is failed not cancelled" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundarySkipsRequestWithoutAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "boundary skips request without attempt" }],
  ],
  [
    "internal/llm/retry_boundary_test.go::TestBoundaryKeepsTruncationCorrectionWhenRecallIsCancelled",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/boundary.test.ts", title: "truncation correction kept through cancellation semantics" }],
  ],
  // ---- retry report ----
  [
    "internal/llm/retry_report_test.go::TestErrorClassAndFailurePhaseSets",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "errorClass and failurePhase sets are fixed" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestClassifyAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "classifyAttempt maps status and errors" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestClassifyAttemptTwoHundredFallsThroughToError",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "classify 200 falls through to error via EOF" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFinalizeDecisionOrder",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "finalize decision order" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptNumbersAndDerivesOutcome",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "recordAttempt numbers and derives outcome" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptDerivesTimings",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "recordAttempt derives timings" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptFloorsInvertedTimestamps",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "recordAttempt floors inverted timestamps" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeAggregatesAndSorts",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze aggregates and sorts by logicalRequestId" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeReturnsNothingWhenNoRetryHappened",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze returns nothing when no retry happened" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeRejectsInvalidRunID",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze rejects invalid runId" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeRejectsOrderingViolations",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze rejects ordering violations (double finalize)" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeErrorIdentifiesTheRequest",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze error identifies request" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeErrorIsDeterministic",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze deterministic error on duplicate violation" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeListsCancelledRequestWithoutErrorAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze lists cancelled request without error attempt" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeRefusesEntryWithNoAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze refuses entry with no attempt" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestCollectorRejectsInvalidInput",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "collector rejects invalid input" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestProviderIsEmittedEvenWhenEmpty",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "provider empty is still emitted" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptRejectsUnclassifiedErrorStatus",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "recordAttempt rejects unclassified error status" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestReviseLastAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "reviseLastAttempt only revises success" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRetryCollectorConcurrentUse",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "retryCollector concurrent use" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRetryReportHasNoUnexpectedTextFields",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "retry report has no unexpected text fields" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestValidateReportCatchesInconsistency",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "validate report catches inconsistency via Freeze" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeSucceededRequestWithExtraAttempt",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze succeeded request with extra attempt" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFinalizeZeroAttemptProducesNoRecord",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "finalize zero attempt produces no record" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestFreezeSuppressesReportWhenValidationFails",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "freeze suppresses report when validation fails" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptAcceptsUnclassifiedSuccessStatus",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "recordAttempt accepts unclassified success status" }],
  ],
  [
    "internal/llm/retry_report_test.go::TestRecordAttemptDropsRequestsWithoutIdentity",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/retry/report.test.ts", title: "recordAttempt drops requests without identity" }],
  ],  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_CancelledSuffix",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "outputRetryReportText cancelled suffix" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_NilWritesNothing",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "outputRetryReportText nil writes nothing" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_RecoveredAndFailed",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "outputRetryReportText recovered and failed" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_SanitizesControlChars",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "outputRetryReportText sanitizes control chars" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_SingularRetry",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "outputRetryReportText singular retry" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestOutputRetryReportText_SucceededAfterRetry",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "outputRetryReportText succeeded after retry" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryAttemptChain_CancelledAttemptNotDuplicated",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "retryAttemptChain cancelled attempt not duplicated" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryAttemptChain_NoStatusCode",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "retryAttemptChain no status code" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryReport_TerminalAndJSONReadSameFrozenResult",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "retryReport terminal and JSON read same frozen result" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryReportJSON_EmptyProviderKept",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "retryReport JSON empty provider kept" }],
  ],
  [
    "cmd/opencodereview/retry_report_render_test.go::TestRetryReportJSON_KeySetIsAllowlisted",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/cli/retry-report-render.test.ts", title: "retryReport JSON key set is allowlisted" }],
  ],

]);

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
    "Pi replaces OCR tiktoken counting with deterministic bytes/4 fallback in src/ocr-v193/llmloop/compression.ts countTokens; tiktoken-precise counts are not applicable via public Pi APIs (documented deviation).",
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
]);

const localCoverage: readonly LocalCoverage[] = [
  {
    localPath: "test/ocr-v193/llmloop/loop.test.ts",
    upstreamPaths: ["internal/llmloop/loop_test.go"],
  },
  {
    localPath: "test/ocr-v193/llmloop/compression.test.ts",
    upstreamPaths: ["internal/llmloop/compression_test.go"],
  },
  {
    localPath: "test/ocr-v193/llmloop/pool.test.ts",
    upstreamPaths: ["internal/llmloop/pool_test.go"],
  },
  {
    localPath: "test/ocr-v193/llmloop/loop-phase5.test.ts",
    upstreamPaths: [
      "internal/llmloop/loop_test.go",
      "internal/llmloop/loop_execute_test.go",
      "internal/llmloop/loop_execute_more_test.go",
    ],
  },
  {
    localPath: "test/ocr-v193/llmloop/runner-pending.test.ts",
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
    localPath: "test/ocr-v193/llmloop/identity.test.ts",
    upstreamPaths: ["internal/llmloop/retry_identity_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/parser.test.ts",
    upstreamPaths: ["internal/diff/parser_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/first-line.test.ts",
    upstreamPaths: ["internal/diff/first_line_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/gitignore.test.ts",
    upstreamPaths: ["internal/diff/gitignore_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/hunk.test.ts",
    upstreamPaths: ["internal/diff/hunk_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/resolver.test.ts",
    upstreamPaths: ["internal/diff/resolver_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/relocation.test.ts",
    upstreamPaths: ["internal/diff/relocation_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/code-comment.test.ts",
    upstreamPaths: ["internal/tool/code_comment_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/collector.test.ts",
    upstreamPaths: ["internal/tool/comment_collector_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/definitions.test.ts",
    upstreamPaths: ["internal/tool/definitions_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/response-message.test.ts",
    upstreamPaths: ["internal/tool/response_message_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/stub.test.ts",
    upstreamPaths: ["internal/tool/stub_test.go"],
  },
  {
    localPath: "test/ocr-v193/model/model.test.ts",
    upstreamPaths: ["internal/model/model_test.go"],
  },
  {
    localPath: "test/ocr-v193/template/template.test.ts",
    upstreamPaths: ["internal/config/template/template_test.go"],
  },
  {
    localPath: "test/ocr-v193/rules/allowed_ext.test.ts",
    upstreamPaths: ["internal/config/allowlist/allowed_ext_test.go"],
  },
  {
    localPath: "test/ocr-v193/rules/system_rules.test.ts",
    upstreamPaths: ["internal/config/rules/system_rules_test.go"],
  },
  {
    localPath: "test/ocr-v193/rules/resolve_github.test.ts",
    upstreamPaths: ["internal/config/rules/resolve_github_test.go"],
  },
  {
    localPath: "test/ocr-v193/rules/system_rules_unmarshal.test.ts",
    upstreamPaths: ["internal/config/rules/system_rules_unmarshal_test.go"],
  },
  {
    localPath: "test/ocr-v193/rules/canonical_config.test.ts",
    upstreamPaths: ["internal/config/rules/canonical_config_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/history.test.ts",
    upstreamPaths: ["internal/session/history_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/persist.test.ts",
    upstreamPaths: ["internal/session/persist_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/resume-identity.test.ts",
    upstreamPaths: ["internal/session/resume_identity_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/manifest.test.ts",
    upstreamPaths: ["internal/session/manifest_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/final-manifest.test.ts",
    upstreamPaths: ["internal/session/final_manifest_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/validate-scan.test.ts",
    upstreamPaths: ["internal/session/validate_scan_options_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/manifest-guards.test.ts",
    upstreamPaths: ["internal/session/manifest_guards_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/resume-orphan.test.ts",
    upstreamPaths: ["internal/session/resume_orphan_request_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/resume.test.ts",
    upstreamPaths: ["internal/session/resume_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/budget.test.ts",
    upstreamPaths: ["internal/agent/budget_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/coverage.test.ts",
    upstreamPaths: ["internal/agent/coverage_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/batch.test.ts",
    upstreamPaths: ["internal/scan/batch_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/budget.test.ts",
    upstreamPaths: ["internal/scan/budget_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/dedup.test.ts",
    upstreamPaths: ["internal/scan/dedup_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/coverage.test.ts",
    upstreamPaths: ["internal/scan/coverage_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/agent.test.ts",
    upstreamPaths: ["internal/scan/agent_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/estimate.test.ts",
    upstreamPaths: ["internal/agent/estimate_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/getters.test.ts",
    upstreamPaths: ["internal/agent/getters_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/util.test.ts",
    upstreamPaths: ["internal/agent/util_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/preview.test.ts",
    upstreamPaths: ["internal/agent/preview_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/preview-run.test.ts",
    upstreamPaths: ["internal/agent/preview_run_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/manifest-hash.test.ts",
    upstreamPaths: ["internal/agent/manifest_hash_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/helpers.test.ts",
    upstreamPaths: ["internal/agent/agent_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/dispatch.test.ts",
    upstreamPaths: ["internal/agent/agent_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/identity.test.ts",
    upstreamPaths: ["internal/agent/identity_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/sealed-input.test.ts",
    upstreamPaths: ["internal/agent/sealed_input_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/retry-identity.test.ts",
    upstreamPaths: ["internal/agent/retry_identity_test.go"],
  },
  {
    localPath: "test/ocr-v193/agent/manifest-integration.test.ts",
    upstreamPaths: ["internal/agent/manifest_integration_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/provider.test.ts",
    upstreamPaths: ["internal/scan/provider_test.go", "internal/scan/provider_more_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/estimate.test.ts",
    upstreamPaths: ["internal/scan/estimate_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/getters.test.ts",
    upstreamPaths: ["internal/scan/getters_test.go", "internal/scan/getters_more_test.go"],
  },
  {
    localPath: "test/ocr-v193/scan/retry-identity.test.ts",
    upstreamPaths: ["internal/scan/retry_identity_test.go"],
  },
  {
    localPath: "test/ocr-v193/pathutil/path.test.ts",
    upstreamPaths: ["internal/pathutil/path_test.go"],
  },
  {
    localPath: "test/ocr-v193/gitcmd/runner.test.ts",
    upstreamPaths: ["internal/gitcmd/runner_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/workspace-file.test.ts",
    upstreamPaths: ["internal/diff/workspace_file_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/git-resolve.test.ts",
    upstreamPaths: ["internal/diff/git_resolve_test.go"],
  },
  {
    localPath: "test/ocr-v193/diff/git-boundaries.test.ts",
    upstreamPaths: ["internal/diff/git_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/filereader-read.test.ts",
    upstreamPaths: ["internal/tool/filereader_read_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/file-read.test.ts",
    upstreamPaths: ["internal/tool/file_read_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/file-read-diff.test.ts",
    upstreamPaths: ["internal/tool/file_read_diff_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/file-find.test.ts",
    upstreamPaths: ["internal/tool/file_find_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/code-search.test.ts",
    upstreamPaths: ["internal/tool/code_search_test.go"],
  },
  {
    localPath: "test/ocr-v193/tool/filereader.test.ts",
    upstreamPaths: ["internal/tool/filereader_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/comments.test.ts",
    upstreamPaths: ["internal/session/comments_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/list.test.ts",
    upstreamPaths: ["internal/session/list_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/list-more.test.ts",
    upstreamPaths: ["internal/session/list_more_test.go"],
  },
  {
    localPath: "test/ocr-v193/session/list-error.test.ts",
    upstreamPaths: ["internal/session/list_error_test.go"],
  },
  {
    localPath: "test/ocr-v193/cli/output-helpers.test.ts",
    upstreamPaths: ["cmd/opencodereview/output_helpers_test.go"],
  },
  {
    localPath: "test/ocr-v193/cli/output-manifest.test.ts",
    upstreamPaths: ["cmd/opencodereview/output_manifest_test.go"],
  },
  {
    localPath: "test/ocr-v193/cli/output.test.ts",
    upstreamPaths: ["cmd/opencodereview/output_test.go"],
  },
  {
    localPath: "test/ocr-v193/cli/shared.test.ts",
    upstreamPaths: ["cmd/opencodereview/shared_test.go"],
  },
  {
    localPath: "test/ocr-v193/cli/shared-llmruntime.test.ts",
    upstreamPaths: ["cmd/opencodereview/shared_llmruntime_test.go"],
  },
  {
    localPath: "test/ocr-v193/cli/sarif.test.ts",
    upstreamPaths: ["cmd/opencodereview/sarif_test.go"],
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

interface LocalAnnotation {
  readonly name: string;
  readonly title: string;
}

function annotations(localPath: string): readonly LocalAnnotation[] {
  const absolutePath = resolve(repoRoot, localPath);
  if (!existsSync(absolutePath)) return [];
  const source = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(localPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: LocalAnnotation[] = [];

  const isTestCall = (node: ts.CallExpression): boolean => {
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text === "test" || node.expression.text === "it" || node.expression.text === "describe";
    }
    if (!ts.isCallExpression(node.expression) || !ts.isPropertyAccessExpression(node.expression.expression)) {
      return false;
    }
    const owner = node.expression.expression.expression;
    const method = node.expression.expression.name.text;
    return ts.isIdentifier(owner)
      && (owner.text === "test" || owner.text === "it" || owner.text === "describe")
      && (method === "each" || method === "skipIf" || method === "runIf");
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const titleNode = node.arguments[0];
      if (titleNode !== undefined && ts.isStringLiteralLike(titleNode)) {
        const statement = ts.isExpressionStatement(node.parent) ? node.parent : node;
        const comments = ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? [];
        const names = comments
          .map((range) => source.slice(range.pos, range.end).match(/OCR v1\.9\.3: (Test[A-Za-z0-9_]+)/)?.[1])
          .filter((name): name is string => name !== undefined);
        for (const name of names) result.push({ name, title: titleNode.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const rawNames = [...source.matchAll(/^\s*\/\/ OCR v1\.9\.3: (Test[A-Za-z0-9_]+)\s*$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  if (rawNames.length !== result.length) {
    throw new Error(
      `${localPath} has ${rawNames.length} OCR annotations but only ${result.length} are attached to test()/it() calls`,
    );
  }
  return result;
}

function coverageByTestId(testNamesByPath: ReadonlyMap<string, ReadonlySet<string>>): ReadonlyMap<string, readonly Evidence[]> {
  const result = new Map<string, Evidence[]>();

  for (const mapping of localCoverage) {
    const localAnnotations = annotations(mapping.localPath);
    const names = localAnnotations.map((annotation) => annotation.name);
    const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicateNames.length > 0) {
      throw new Error(`${mapping.localPath} has duplicate OCR annotations: ${[...new Set(duplicateNames)].join(", ")}`);
    }

    for (const annotation of localAnnotations) {
      const name = annotation.name;
      const matchingPaths = mapping.upstreamPaths.filter((path) => testNamesByPath.get(path)?.has(name) === true);
      if (matchingPaths.length !== 1) {
        throw new Error(
          `${mapping.localPath} annotation ${name} matched ${matchingPaths.length} configured upstream files`,
        );
      }
      const id = `${matchingPaths[0]}::${name}`;
      const evidence = result.get(id) ?? [];
      evidence.push({ kind: "bun-test-annotation", path: mapping.localPath, title: annotation.title });
      result.set(id, evidence);
    }
  }

  return result;
}

function validateOverrides(
  testNamesByPath: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const [key, evidence] of equivalentTests) {
    const [path, name] = key.split("::");
    if (!path || !name) throw new Error(`equivalentTests key must be "path::TestName", got ${JSON.stringify(key)}`);
    const names = testNamesByPath.get(path);
    if (!names) throw new Error(`equivalentTests references unknown file ${path}`);
    if (!names.has(name)) throw new Error(`equivalentTests references unknown test ${key}`);
    if (evidence.length === 0) throw new Error(`equivalentTests ${key} has no evidence`);
    for (const e of evidence) {
      if (e.kind !== "bun-test-annotation") throw new Error(`equivalentTests ${key} evidence kind must be bun-test-annotation`);
      if (!existsSync(resolve(repoRoot, e.path))) throw new Error(`equivalentTests ${key} evidence path does not exist: ${e.path}`);
    }
  }
  for (const [key, reason] of notApplicableTests) {
    const [path, name] = key.split("::");
    if (!path || !name) throw new Error(`notApplicableTests key must be "path::TestName", got ${JSON.stringify(key)}`);
    const names = testNamesByPath.get(path);
    if (!names) throw new Error(`notApplicableTests references unknown file ${path}`);
    if (!names.has(name)) throw new Error(`notApplicableTests references unknown test ${key}`);
    if (reason.length < 20) throw new Error(`notApplicableTests ${key} reason too short`);
    const lower = reason.toLowerCase();
    if (!lower.includes("pi replaces") && !lower.includes("not applicable") && !lower.includes("deferred")) {
      throw new Error(`notApplicableTests ${key} reason must mention "Pi replaces", "not applicable" or "deferred" with concrete rationale`);
    }
  }
  for (const [path, scope] of scopeOverrides) {
    if (!testNamesByPath.has(path)) throw new Error(`scopeOverrides references unknown file ${path}`);
    if (!scope.area || !scope.kind) throw new Error(`scopeOverrides ${path} missing area/kind`);
  }
}

function effectiveScope(path: string): Scope {
  const override = scopeOverrides.get(path);
  if (override !== undefined) return override;
  return classifyScope(path);
}

function generateInventory(): Inventory {
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

  validateOverrides(testNamesByPath);

  const evidence = coverageByTestId(testNamesByPath);
  const files = [...blobs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, blob]): InventoryFile => {
      const scope = effectiveScope(path);
      const names = [...(testNamesByPath.get(path) ?? [])].sort((left, right) => left.localeCompare(right));
      const tests = names.map((name): InventoryTest => {
        const id = `${path}::${name}`;
        const testEvidence = evidence.get(id);
        if (testEvidence !== undefined) return { name, disposition: "covered", evidence: testEvidence };
        const equivEvidence = equivalentTests.get(id);
        if (equivEvidence !== undefined) return { name, disposition: "equivalent", evidence: equivEvidence, reason: `equivalent via ${equivEvidence.map((e) => e.path).join(", ")}` };
        const naReason = notApplicableTests.get(id);
        if (naReason !== undefined) return { name, disposition: "not_applicable", reason: naReason };
        if (scope.kind === "out_of_scope") return { name, disposition: "out_of_scope", reason: scope.reason };
        if (scope.kind === "needs_decision") return { name, disposition: "pending_scope", reason: scope.reason };
        return { name, disposition: "pending", reason: "OCR-derived test translation has not been recorded" };
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

  return { schemaVersion: 2, reference, files };
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

const args = new Set(process.argv.slice(2));
const generated = serializedInventory();
if (args.has("--check")) {
  if (!existsSync(inventoryPath) || readFileSync(inventoryPath, "utf8") !== generated) {
    console.error("OCR v1.9.3 test inventory is stale; run bun run scripts/generate-ocr-v193-test-inventory.ts");
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
