// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_meta.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { createHash } from "node:crypto";

export const logicalRequestIDVersion = "ocr.llm-request/v1";

export interface RequestMeta {
  readonly provider: string;
  readonly model: string;
  readonly filePath: string;
  readonly taskType: string;
  readonly requestNo: number;
}

function containsNul(s: string): boolean {
  return s.includes("\0");
}

export function isValidRequestMeta(m: RequestMeta): boolean {
  if (m.requestNo <= 0) return false;
  if (containsNul(m.provider)) return false;
  for (const s of [m.model, m.filePath, m.taskType] as const) {
    if (s === "" || containsNul(s)) return false;
  }
  return true;
}

export function logicalRequestID(m: RequestMeta, runId: string): string {
  const h = createHash("sha256");
  for (const field of [
    logicalRequestIDVersion,
    runId,
    m.provider,
    m.model,
    m.filePath,
    m.taskType,
    String(m.requestNo),
  ] as const) {
    h.update(field, "utf8");
    h.update("\0", "utf8");
  }
  return h.digest("hex");
}

export function describeRequestMeta(m: RequestMeta): string {
  return `file=${m.filePath} task=${m.taskType} request_no=${m.requestNo}`;
}

// Context carrying via WeakMap + Symbol, transport-independent.
// No Pi private hook; works for any object context.

const metaKey = Symbol("ocr.RequestMeta");
const metaStore = new WeakMap<object, RequestMeta>();

export function withRequestMeta(ctx: unknown, m: RequestMeta): unknown {
  if (ctx === null || ctx === undefined) return ctx;
  if (typeof ctx !== "object") return ctx;
  if (!isValidRequestMeta(m)) return ctx;
  const wrapper = Object.create(ctx as object);
  // store both places for robustness
  metaStore.set(wrapper, { ...m });
  (wrapper as Record<symbol, unknown>)[metaKey] = { ...m };
  return wrapper;
}

export function requestMetaFromContext(ctx: unknown): { meta: RequestMeta; ok: boolean } {
  if (ctx === null || ctx === undefined || typeof ctx !== "object") {
    return { meta: { provider: "", model: "", filePath: "", taskType: "", requestNo: 0 }, ok: false };
  }
  const fromStore = metaStore.get(ctx as object);
  if (fromStore !== undefined) return { meta: fromStore, ok: true };
  const direct = (ctx as Record<symbol, unknown>)[metaKey];
  if (direct !== undefined && typeof direct === "object" && direct !== null) {
    // Verify shape
    const d = direct as RequestMeta;
    if (
      typeof d.provider === "string" &&
      typeof d.model === "string" &&
      typeof d.filePath === "string" &&
      typeof d.taskType === "string" &&
      typeof d.requestNo === "number"
    ) {
      return { meta: d, ok: true };
    }
  }
  // Walk prototype chain for inherited symbol (Object.create case)
  let cur: unknown = ctx;
  while (cur !== null && typeof cur === "object") {
    const v = (cur as Record<symbol, unknown>)[metaKey];
    if (v !== undefined) {
      const d = v as RequestMeta;
      return { meta: d, ok: true };
    }
    cur = Object.getPrototypeOf(cur as object);
  }
  return { meta: { provider: "", model: "", filePath: "", taskType: "", requestNo: 0 }, ok: false };
}
