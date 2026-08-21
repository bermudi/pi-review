// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/resolver.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Only the observable parsing/validation layer is ported; provider dispatch is Pi ModelRuntime.

const reservedHeaders = new Set(["authorization", "x-api-key", "content-type", "user-agent"]);

export function splitHeaderPairs(raw: string): string[] {
  const pairs: string[] = [];
  let sb = "";
  let inQuote = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuote = !inQuote;
      sb += ch;
    } else if (ch === "," && !inQuote) {
      pairs.push(sb);
      sb = "";
    } else {
      sb += ch;
    }
  }
  if (sb.length > 0 || pairs.length === 0) pairs.push(sb);
  if (inQuote) throw new Error("unclosed quote in extra headers");
  return pairs;
}

export function parseExtraHeaders(raw: string): Record<string, string> | null {
  if (raw === "") return null;
  const pairs = splitHeaderPairs(raw);
  const result: Record<string, string> = {};
  for (let pair of pairs) {
    pair = pair.trim();
    if (pair === "") continue;
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) throw new Error(`invalid extra header "${pair}": expected key=value`);
    const key = pair.slice(0, eqIdx).trim();
    let value = pair.slice(eqIdx + 1).trim();
    if (key === "") throw new Error(`invalid extra header "${pair}": empty header name`);
    if (reservedHeaders.has(key.toLowerCase())) {
      throw new Error(`extra header "${key}" conflicts with a reserved header; use the dedicated config field instead`);
    }
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function sanitizeRetryCodes(codes: number[]): { filtered: number[]; warnings: string[] } {
  const filtered: number[] = [];
  const warnings: string[] = [];
  for (const code of codes) {
    if (code < 400 || code > 499) {
      throw new Error(`invalid retry code ${code}: must be a 4xx status code (5xx codes are already retried by default)`);
    }
    if (code === 408 || code === 409 || code === 429) {
      warnings.push(`retry code ${code} is unnecessary (SDK already retries it) and will be ignored`);
      continue;
    }
    filtered.push(code);
  }
  return { filtered, warnings };
}

export function parseRetryCodes(raw: string): { codes: number[] | null; warnings: string[] } {
  const trimmed = raw.trim();
  if (trimmed === "") return { codes: null, warnings: [] };
  const parts = trimmed.split(",");
  const seen = new Set<number>();
  const codes: number[] = [];
  for (let p of parts) {
    p = p.trim();
    if (p === "") continue;
    const code = Number.parseInt(p, 10);
    if (Number.isNaN(code) || String(code) !== p.replace(/^0+/, "") && p !== "0") {
      // Strict integer check: parseInt "abc" -> NaN, "403 " not possible due to trim
      if (!/^-?\d+$/.test(p)) throw new Error(`invalid retry code "${p}": must be an integer`);
    }
    if (Number.isNaN(code)) throw new Error(`invalid retry code "${p}": must be an integer`);
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  const { filtered, warnings } = sanitizeRetryCodes(codes);
  return { codes: filtered.length === 0 ? null : filtered, warnings };
}

export function parseTimeoutEnv(raw: string): { durationMs: number; ok: boolean } {
  const v = raw.trim();
  if (v === "") return { durationMs: 0, ok: false };
  const sec = Number.parseInt(v, 10);
  if (Number.isNaN(sec) || !/^-?\d+$/.test(v)) throw new Error(`OCR_LLM_TIMEOUT must be an integer (seconds): ${v}`);
  const d = validateTimeoutSec(sec);
  return { durationMs: d, ok: true };
}

export function validateTimeoutSec(sec: number): number {
  if (sec === 0) return 0;
  if (sec < 0) throw new Error(`timeout_sec must be non-negative, got ${sec}`);
  const maxSec = Math.floor(Number.MAX_SAFE_INTEGER / 1000); // time.Duration is int64 ns, but we cap at safe
  // Actual Go max is MaxInt64 / 1e9 ≈ 9.22e9
  const goMaxSec = 9223372036;
  if (sec > goMaxSec) throw new Error(`timeout_sec ${sec} overflows time.Duration (max ${goMaxSec})`);
  if (sec > maxSec) throw new Error(`timeout_sec ${sec} overflows`);
  return sec * 1000;
}

const modelSuffixRe = /\[\d+m\]$/;

export function stripModelSuffix(model: string): string {
  return model.replace(modelSuffixRe, "");
}

// Merging helpers for tail tests

export function mergeExtraHeaders(
  configHeaders: Record<string, string> | null | undefined,
  envRaw: string | null | undefined,
): Record<string, string> | null {
  const envParsed = envRaw ? parseExtraHeaders(envRaw) : null;
  if (!configHeaders && !envParsed) return null;
  const out: Record<string, string> = {};
  if (configHeaders) Object.assign(out, configHeaders);
  if (envParsed) Object.assign(out, envParsed);
  return Object.keys(out).length === 0 ? null : out;
}

export function filterRedundantRetryCodes(codes: number[] | null): number[] | null {
  if (codes === null) return null;
  const filtered = codes.filter((c) => c !== 408 && c !== 409 && c !== 429);
  return filtered.length === 0 ? null : filtered;
}
