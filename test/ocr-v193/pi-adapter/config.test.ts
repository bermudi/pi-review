// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/resolver_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Covers ParseExtraHeaders, ParseRetryCodes, parseTimeoutEnv, validateTimeoutSec, stripModelSuffix
// and observable merging/body/session-key behaviors.

import { test, expect } from "bun:test";
import {
  parseExtraHeaders,
  parseRetryCodes,
  parseTimeoutEnv,
  validateTimeoutSec,
  stripModelSuffix,
  mergeExtraHeaders,
} from "../../../src/ocr-v193/pi-adapter/config.js";
import { expandSessionKeyInHeaders, expandSessionKeyInBody } from "../../../src/ocr-v193/pi-adapter/session-key.js";

// OCR v1.9.3: TestResolveEndpoint_OCREnvExtraHeadersEmpty
test("parseExtraHeaders empty returns null", () => {
  expect(parseExtraHeaders("")).toBeNull();
});

// OCR v1.9.3: TestParseExtraHeaders
test("parseExtraHeaders single pair", () => {
  expect(parseExtraHeaders("X-Custom-Header=value1")).toEqual({ "X-Custom-Header": "value1" });
});

// OCR v1.9.3: TestResolveEndpoint_OCREnvExtraHeaders
test("parseExtraHeaders multiple pairs", () => {
  expect(parseExtraHeaders("X-Custom-Header=value1,X-Another=value2")).toEqual({ "X-Custom-Header": "value1", "X-Another": "value2" });
});

test("parseExtraHeaders trims whitespace", () => {
  expect(parseExtraHeaders("  X-Header  =  spaced-value  , X-Two = val ")).toEqual({ "X-Header": "spaced-value", "X-Two": "val" });
});

test("parseExtraHeaders trailing comma ignored", () => {
  expect(parseExtraHeaders("X-Header=value,")).toEqual({ "X-Header": "value" });
});

test("parseExtraHeaders empty pairs skipped", () => {
  expect(parseExtraHeaders("X-Header=value,, ,X-Two=val2")).toEqual({ "X-Header": "value", "X-Two": "val2" });
});

test("parseExtraHeaders value can contain equals", () => {
  expect(parseExtraHeaders("X-Header=a=b=c")).toEqual({ "X-Header": "a=b=c" });
});

// OCR v1.9.3: TestResolveEndpoint_OCREnvExtraHeadersInvalid
test("parseExtraHeaders pair without equals is error", () => {
  expect(() => parseExtraHeaders("X-Header-no-equals")).toThrow();
});

test("parseExtraHeaders empty key is error", () => {
  expect(() => parseExtraHeaders("=value")).toThrow();
  expect(() => parseExtraHeaders("  =value")).toThrow();
});

// OCR v1.9.3: TestResolveEndpoint_OCREnvExtraHeadersReservedRejected
test("parseExtraHeaders reserved headers rejected", () => {
  expect(() => parseExtraHeaders("Authorization=Bearer token")).toThrow(/reserved/i);
  expect(() => parseExtraHeaders("x-api-key=secret")).toThrow(/reserved/i);
  expect(() => parseExtraHeaders("Content-Type=text/plain")).toThrow(/reserved/i);
  expect(() => parseExtraHeaders("User-Agent=custom-agent")).toThrow(/reserved/i);
  expect(() => parseExtraHeaders("X-Org=val,Authorization=bad")).toThrow(/reserved/i);
});

test("parseExtraHeaders quoted value with comma", () => {
  expect(parseExtraHeaders(`X-Forwarded-For="1.2.3.4,5.6.7.8"`)).toEqual({ "X-Forwarded-For": "1.2.3.4,5.6.7.8" });
});

test("parseExtraHeaders quoted with trailing pair", () => {
  expect(parseExtraHeaders(`X-Forwarded-For="1.2.3.4,5.6.7.8",X-Org=abc`)).toEqual({ "X-Forwarded-For": "1.2.3.4,5.6.7.8", "X-Org": "abc" });
});

test("parseExtraHeaders multiple quoted", () => {
  expect(parseExtraHeaders(`X-A="1,2",X-B="3,4"`)).toEqual({ "X-A": "1,2", "X-B": "3,4" });
});

test("parseExtraHeaders quoted empty", () => {
  expect(parseExtraHeaders(`X-Key=""`)).toEqual({ "X-Key": "" });
});

test("parseExtraHeaders unclosed quote error", () => {
  expect(() => parseExtraHeaders(`X-Key="unterminated`)).toThrow(/unclosed/i);
});

test("parseRetryCodes empty", () => {
  expect(parseRetryCodes("").codes).toBeNull();
  expect(parseRetryCodes("   ").codes).toBeNull();
});

// OCR v1.9.3: TestParseRetryCodes
test("parseRetryCodes single and multiple", () => {
  expect(parseRetryCodes("403").codes).toEqual([403]);
  expect(parseRetryCodes("403,400").codes).toEqual([403, 400]);
  expect(parseRetryCodes(" 403 , 400 ").codes).toEqual([403, 400]);
});

test("parseRetryCodes deduplicates", () => {
  expect(parseRetryCodes("403,403,400").codes).toEqual([403, 400]);
});

test("parseRetryCodes rejects non-integer", () => {
  expect(() => parseRetryCodes("abc")).toThrow(/invalid retry code/i);
});

test("parseRetryCodes rejects 2xx/3xx/5xx", () => {
  expect(() => parseRetryCodes("200")).toThrow(/4xx/i);
  expect(() => parseRetryCodes("301")).toThrow(/4xx/i);
  expect(() => parseRetryCodes("500")).toThrow(/4xx/i);
});

test("parseRetryCodes filters 408/409/429 with warning", () => {
  const r408 = parseRetryCodes("408");
  expect(r408.codes).toBeNull();
  expect(r408.warnings.length).toBeGreaterThan(0);
  const r429 = parseRetryCodes("429");
  expect(r429.codes).toBeNull();
  const rBoth = parseRetryCodes("429,403");
  expect(rBoth.codes).toEqual([403]);
  expect(rBoth.warnings.length).toBeGreaterThan(0);
});

test("parseTimeoutEnv empty", () => {
  expect(parseTimeoutEnv("").ok).toBe(false);
});

// OCR v1.9.3: TestParseTimeoutEnv
test("parseTimeoutEnv valid", () => {
  expect(parseTimeoutEnv("120").durationMs).toBe(120000);
  expect(parseTimeoutEnv(" 90 ").durationMs).toBe(90000);
  expect(parseTimeoutEnv("0").durationMs).toBe(0);
});

test("parseTimeoutEnv invalid", () => {
  expect(() => parseTimeoutEnv("-5")).toThrow();
  expect(() => parseTimeoutEnv("abc")).toThrow();
  expect(() => parseTimeoutEnv("99999999999999")).toThrow(/overflow/i);
});

// OCR v1.9.3: TestValidateTimeoutSec
test("validateTimeoutSec", () => {
  expect(validateTimeoutSec(0)).toBe(0);
  expect(validateTimeoutSec(60)).toBe(60000);
  expect(() => validateTimeoutSec(-1)).toThrow(/non-negative/i);
  expect(() => validateTimeoutSec(9223372037)).toThrow(/overflow/i);
});

// OCR v1.9.3: TestStripModelSuffix
test("stripModelSuffix", () => {
  expect(stripModelSuffix("claude-opus-4-7[1m]")).toBe("claude-opus-4-7");
  expect(stripModelSuffix("claude-opus-4-7")).toBe("claude-opus-4-7");
  expect(stripModelSuffix("")).toBe("");
  expect(stripModelSuffix("claude[1m]-extra")).toBe("claude[1m]-extra");
  expect(stripModelSuffix("claude-opus-4-7[m]")).toBe("claude-opus-4-7[m]");
});

// OCR v1.9.3: TestResolveEndpoint_EnvExtraHeadersMergedWithConfigFile
test("mergeExtraHeaders merges config and env", () => {
  const merged = mergeExtraHeaders({ "X-Org-ID": "org-123" }, "EagleEye-TraceId=trace-from-env,X-New=from-env");
  expect(merged!["X-Org-ID"]).toBe("org-123");
  expect(merged!["EagleEye-TraceId"]).toBe("trace-from-env");
  expect(merged!["X-New"]).toBe("from-env");
});

test("mergeExtraHeaders env reserved rejected", () => {
  expect(() => mergeExtraHeaders(null, "Authorization=oops")).toThrow(/reserved/i);
});

// OCR v1.9.3: TestResolveEndpoint_LegacyLlmExtraHeaders
// OCR v1.9.3: TestResolveEndpoint_ProviderExtraHeaders
test("provider extra headers preserved", () => {
  const merged = mergeExtraHeaders({ "X-Org-ID": "org-123" }, null);
  expect(merged!["X-Org-ID"]).toBe("org-123");
});

// OCR v1.9.3: TestResolveEndpoint_SessionKeyPlaceholderPreserved
test("session key placeholder preserved before expansion", () => {
  const headers = { "x-session-affinity": "{ocr_session_key}" };
  expect(headers["x-session-affinity"]).toBe("{ocr_session_key}");
  const expanded = expandSessionKeyInHeaders(headers, "sess-123")!;
  expect(expanded["x-session-affinity"]).toBe("sess-123");
});

// OCR v1.9.3: TestResolveEndpoint_ProviderExtraBody
test("extraBody session key expansion and stream drop", () => {
  const body: Record<string, unknown> = { prompt_cache_key: "{ocr_session_key}", thinking: { type: "disabled" }, stream: true };
  const expanded = expandSessionKeyInBody(body, "sess-xyz")!;
  expect(expanded["prompt_cache_key"]).toBe("sess-xyz");
  // stream key preserved in expansion; transport drops it if not streaming (checked in pi-transport)
  expect(expanded["stream"]).toBe(true);
});

// OCR v1.9.3: TestResolveEndpoint_RedundantRetryCodesFiltered
test("redundant retry codes filtered keeps valid", () => {
  const { codes, warnings } = parseRetryCodes("429,403");
  expect(codes).toEqual([403]);
  expect(warnings.length).toBeGreaterThan(0);
});
