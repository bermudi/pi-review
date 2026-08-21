// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/protocol_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import {
  normalizeProtocol,
  validateProtocol,
  ProtocolAnthropic,
  ProtocolOpenAIChatCompletions,
  ProtocolOpenAIResponses,
} from "../../../src/ocr-v193/pi-adapter/protocol.js";

// OCR v1.9.3: TestNormalizeProtocol
test("normalizeProtocol canonicalizes known protocols case-insensitively and trims", () => {
  const cases: readonly [string, string, string][] = [
    ["empty stays empty", "", ""],
    ["canonical anthropic is idempotent", ProtocolAnthropic, ProtocolAnthropic],
    ["canonical openai is idempotent", ProtocolOpenAIChatCompletions, ProtocolOpenAIChatCompletions],
    ["canonical openai-responses is idempotent", ProtocolOpenAIResponses, ProtocolOpenAIResponses],
    ["anthropic case-insensitive", "ANTHROPIC", ProtocolAnthropic],
    ["openai-responses case-insensitive", "OpenAI-Responses", ProtocolOpenAIResponses],
    ["unknown passthrough lowercased", "gRPC", "grpc"],
    ["unknown anthropic-vertex preserved", "anthropic-vertex", "anthropic-vertex"],
  ];
  for (const [name, raw, want] of cases) {
    const got = normalizeProtocol(raw);
    expect(got, name).toBe(want);
  }
});

// OCR v1.9.3: TestValidateProtocol
test("validateProtocol accepts canonical names and rejects others", () => {
  const cases: readonly [string, string, boolean, string][] = [
    ["anthropic ok", ProtocolAnthropic, false, ""],
    ["openai ok", ProtocolOpenAIChatCompletions, false, ""],
    ["openai-responses ok", ProtocolOpenAIResponses, false, ""],
    ["empty rejected", "", true, "unsupported protocol"],
    ["grpc rejected", "grpc", true, "unsupported protocol"],
    ["anthropic-vertex rejected", "anthropic-vertex", true, "unsupported protocol"],
  ];
  for (const [name, p, wantErr, errSub] of cases) {
    if (wantErr) {
      expect(() => validateProtocol(p), name).toThrow(errSub);
    } else {
      expect(() => validateProtocol(p), name).not.toThrow();
    }
  }
});

// OCR v1.9.3: TestValidateProtocol_ErrorMessageListsAllProtocols
test("validateProtocol error message enumerates every canonical protocol", () => {
  let err: Error | undefined;
  try {
    validateProtocol("grpc");
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();
  for (const sub of [ProtocolAnthropic, ProtocolOpenAIChatCompletions, ProtocolOpenAIResponses]) {
    expect(err!.message).toContain(sub);
  }
});
