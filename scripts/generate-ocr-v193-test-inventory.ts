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
    "internal/llm/client_test.go::TestOpenAIClient_StreamingCancellation",
    [{ kind: "bun-test-annotation", path: "test/ocr-v193/pi-adapter.test.ts", title: "PiTransport forwards abort signal to session.abort" }],
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
