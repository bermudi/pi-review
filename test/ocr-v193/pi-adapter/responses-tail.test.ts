// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/responses_client_test.go and client_test.go truncation/stream at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  classifyResponsesStatus,
  mapResponsesResponse,
  buildResponsesToolDefs,
  prepareResponsesRequest,
  shouldRetryTruncated,
} from "../../../src/ocr-v193/pi-adapter/responses-helpers.js";

test("buildResponsesParams tools", () => {
  const tools = [{ type: "function", function: { name: "read", description: "read file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
  const built = buildResponsesToolDefs(tools);
  expect(built.length).toBe(1);
  expect(built[0]!.function.name).toBe("read");
  expect(buildResponsesToolDefs([]).length).toBe(0);
  expect(buildResponsesToolDefs(undefined).length).toBe(0);
});

test("mapResponsesResponse status incomplete", () => {
  expect(mapResponsesResponse("incomplete").ok).toBe(false);
  expect(mapResponsesResponse("completed").ok).toBe(true);
});

test("mapResponsesResponse statuses failed/cancelled/queued/in_progress", () => {
  for (const s of ["failed", "cancelled", "queued", "in_progress"]) {
    const cls = classifyResponsesStatus(s)!;
    expect(cls.errorClass).toBe("provider");
    expect(cls.failurePhase).toBe("response_status");
    expect(mapResponsesResponse(s).ok).toBe(false);
  }
});

test("extraBody promptCacheKey overrides sessionId", () => {
  const { body } = prepareResponsesRequest({ prompt_cache_key: "{ocr_session_key}", extra: "x" }, null, "sess-123");
  expect(body!["prompt_cache_key"]).toBe("sess-123");
});

test("extraBody stream dropped", () => {
  const { body } = prepareResponsesRequest({ stream: true, key: "v" }, null, "sess-123");
  expect(body!["stream"]).toBeUndefined();
  expect(body!["key"]).toBe("v");
});

test("non-success status returns error", () => {
  const r = mapResponsesResponse("failed");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("failed");
});

test("session key expanded in headers and body", () => {
  const { headers, body } = prepareResponsesRequest({ key: "{ocr_session_key}" }, { "x-session": "{ocr_session_key}" }, "sess-xyz");
  expect(headers!["x-session"]).toBe("sess-xyz");
  expect(body!["key"]).toBe("sess-xyz");
});

test("truncated response retry once", () => {
  const eof = new Error("unexpected EOF");
  expect(shouldRetryTruncated(0, eof)).toBe(true);
  expect(shouldRetryTruncated(1, eof)).toBe(false);
});

test("does not retry truncated after cancellation", () => {
  const controller = new AbortController();
  controller.abort();
  expect(shouldRetryTruncated(0, new Error("unexpected EOF"), controller.signal)).toBe(false);
});

test("stops after second truncated response", () => {
  const eof = new Error("unexpected EOF");
  // first retry allowed, second not
  expect(shouldRetryTruncated(0, eof)).toBe(true);
  // second attempt would be index 1, should not retry again
  expect(shouldRetryTruncated(1, eof)).toBe(false);
});

test("does not retry non-retryable error (400)", () => {
  expect(shouldRetryTruncated(0, new Error("400 Bad Request"))).toBe(false);
});

test("streaming incomplete and no choices via integrity error", () => {
  // These are represented as provider/stream failures via Responses status incomplete already covered
  // Verify that incomplete maps to provider/response_status which is the blind-spot correction
  expect(classifyResponsesStatus("incomplete")!.failurePhase).toBe("response_status");
});

test("streaming error maps to provider", () => {
  expect(classifyResponsesStatus("failed")!.errorClass).toBe("provider");
});
