// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from docs/ocr-v1.9.3-port-plan.md Phase 0 comparer contract at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { Trace } from "./types.js";

export interface CompareMismatch {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
}

function normalizeTmp(s: string): string {
  return s.replace(/\/tmp\/[^\s"']+/g, "<TMP>").replace(/localhost:\d+/g, "localhost:<PORT>");
}

export function compareTraces(ocr: Trace, pi: Trace): { equal: boolean; mismatches: CompareMismatch[] } {
  const mismatches: CompareMismatch[] = [];

  function check(field: string, pass: boolean, left: unknown, right: unknown, msg: string): void {
    if (!pass) mismatches.push({ field, expected: left, actual: right, message: msg });
  }

  // Requests: ordinal, model, messages, tool set
  check("trace.requests.count", ocr.requests.length === pi.requests.length, ocr.requests.length, pi.requests.length, `request count ${ocr.requests.length} vs ${pi.requests.length}`);
  const reqLen = Math.min(ocr.requests.length, pi.requests.length);
  for (let i = 0; i < reqLen; i++) {
    const o = ocr.requests[i] as NonNullable<(typeof ocr.requests)[number]>;
    const p = pi.requests[i] as NonNullable<(typeof pi.requests)[number]>;
    check(`trace.requests[${i}].ordinal`, o.ordinal === p.ordinal, o.ordinal, p.ordinal, `ordinal mismatch`);
    check(`trace.requests[${i}].model`, normalizeTmp(String(o.model)) === normalizeTmp(String(p.model)), o.model, p.model, `model mismatch`);
    const oTools = [...o.tools].map((t) => t.name).sort();
    const pTools = [...p.tools].map((t) => t.name).sort();
    check(`trace.requests[${i}].tools`, JSON.stringify(oTools) === JSON.stringify(pTools), oTools, pTools, `tool set mismatch for request ${i}`);
    check(`trace.requests[${i}].messages`, JSON.stringify(o.messages) === JSON.stringify(p.messages), o.messages, p.messages, `messages mismatch for request ${i}`);
  }
  // Any extra requests beyond min length are already flagged via count; also emit per-ordinal tool name mismatch if needed

  // Responses: ordinal, text, tool calls, raw usage
  check("trace.responses.count", ocr.responses.length === pi.responses.length, ocr.responses.length, pi.responses.length, `response count ${ocr.responses.length} vs ${pi.responses.length}`);
  const respLen = Math.min(ocr.responses.length, pi.responses.length);
  for (let i = 0; i < respLen; i++) {
    const o = ocr.responses[i] as NonNullable<(typeof ocr.responses)[number]>;
    const p = pi.responses[i] as NonNullable<(typeof pi.responses)[number]>;
    check(`trace.responses[${i}].ordinal`, o.ordinal === p.ordinal, o.ordinal, p.ordinal, `ordinal`);
    check(`trace.responses[${i}].text`, normalizeTmp(String(o.text)) === normalizeTmp(String(p.text)), o.text, p.text, `text mismatch`);
    const oCalls = o.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
    const pCalls = p.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
    check(`trace.responses[${i}].toolCalls`, JSON.stringify(oCalls) === JSON.stringify(pCalls), oCalls, pCalls, `toolCalls mismatch`);
    // Individual tool call name/args granular checks for named mismatches
    const maxCalls = Math.max(o.toolCalls.length, p.toolCalls.length);
    for (let j = 0; j < maxCalls; j++) {
      const oc = o.toolCalls[j];
      const pc = p.toolCalls[j];
      if (oc && pc) {
        check(`trace.responses[${i}].toolCalls[${j}].name`, oc.name === pc.name, oc.name, pc.name, `tool call name mismatch`);
        check(`trace.responses[${i}].toolCalls[${j}].arguments`, JSON.stringify(oc.arguments) === JSON.stringify(pc.arguments), oc.arguments, pc.arguments, `tool call arguments mismatch`);
      } else if (oc || pc) {
        check(`trace.responses[${i}].toolCalls[${j}]`, false, oc ?? null, pc ?? null, `tool call missing`);
      }
    }
    check(`trace.responses[${i}].rawUsage`, JSON.stringify(o.rawUsage) === JSON.stringify(p.rawUsage), o.rawUsage, p.rawUsage, `rawUsage mismatch for response ${i}`);
  }

  // Tool executions: ordinal, name, parsed arguments, result/error
  check("trace.toolExecutions.count", ocr.toolExecutions.length === pi.toolExecutions.length, ocr.toolExecutions.length, pi.toolExecutions.length, `tool execution count`);
  const toolLen = Math.min(ocr.toolExecutions.length, pi.toolExecutions.length);
  for (let i = 0; i < toolLen; i++) {
    const o = ocr.toolExecutions[i] as NonNullable<(typeof ocr.toolExecutions)[number]>;
    const p = pi.toolExecutions[i] as NonNullable<(typeof pi.toolExecutions)[number]>;
    check(`trace.toolExecutions[${i}].ordinal`, o.ordinal === p.ordinal, o.ordinal, p.ordinal, `ordinal`);
    check(`trace.toolExecutions[${i}].name`, o.name === p.name, o.name, p.name, `tool name mismatch`);
    check(`trace.toolExecutions[${i}].parsedArguments`, JSON.stringify(o.parsedArguments) === JSON.stringify(p.parsedArguments), o.parsedArguments, p.parsedArguments, `tool args mismatch`);
    check(`trace.toolExecutions[${i}].result`, (o.result ?? "") === (p.result ?? ""), o.result, p.result, `tool result mismatch`);
    check(`trace.toolExecutions[${i}].error`, (o.error ?? "") === (p.error ?? ""), o.error, p.error, `tool error mismatch`);
  }

  // Final: coverage, comments, usage, stop reason, exit
  const of = ocr.final;
  const pf = pi.final;
  check("trace.final.coverage", JSON.stringify(of.coverage) === JSON.stringify(pf.coverage), of.coverage, pf.coverage, `coverage mismatch`);
  check("trace.final.rawComments", JSON.stringify(of.rawComments) === JSON.stringify(pf.rawComments), of.rawComments, pf.rawComments, `rawComments mismatch`);
  check("trace.final.processedComments", JSON.stringify(of.processedComments) === JSON.stringify(pf.processedComments), of.processedComments, pf.processedComments, `processedComments mismatch`);
  // Granular comment line check for Phase 0 named mismatch: check first comment content line if present
  if (Array.isArray(of.processedComments) && Array.isArray(pf.processedComments) && of.processedComments.length > 0 && pf.processedComments.length > 0) {
    const oc: unknown = of.processedComments[0];
    const pc: unknown = pf.processedComments[0];
    const oContent = typeof (oc as Record<string, unknown>).content === "string" ? String((oc as Record<string, unknown>).content) : JSON.stringify(oc);
    const pContent = typeof (pc as Record<string, unknown>).content === "string" ? String((pc as Record<string, unknown>).content) : JSON.stringify(pc);
    check("trace.final.processedComments[0].content", oContent === pContent, oContent, pContent, `first processed comment content mismatch`);
    const oLine = ((oc as Record<string, unknown>).startLine ?? (oc as Record<string, unknown>).start_line) as unknown;
    const pLine = ((pc as Record<string, unknown>).startLine ?? (pc as Record<string, unknown>).start_line) as unknown;
    if (oLine !== undefined && pLine !== undefined) {
      check("trace.final.processedComments[0].startLine", oLine === pLine, oLine, pLine, `first comment line mismatch`);
    }
  }
  check("trace.final.usage", JSON.stringify(of.usage) === JSON.stringify(pf.usage), of.usage, pf.usage, `usage mismatch`);
  // Granular usage value for named mismatch
  if (typeof of.usage === "object" && of.usage !== null && typeof pf.usage === "object" && pf.usage !== null) {
    const oU = of.usage as Record<string, unknown>;
    const pU = pf.usage as Record<string, unknown>;
    const keys = new Set([...Object.keys(oU), ...Object.keys(pU)]);
    for (const k of keys) {
      check(`trace.final.usage.${k}`, JSON.stringify(oU[k]) === JSON.stringify(pU[k]), oU[k], pU[k], `usage.${k} mismatch`);
    }
  }
  check("trace.final.stopReason", of.stopReason === pf.stopReason, of.stopReason, pf.stopReason, `stopReason mismatch`);
  check("trace.final.exitCode", of.exitCode === pf.exitCode, of.exitCode, pf.exitCode, `exitCode mismatch`);

  return { equal: mismatches.length === 0, mismatches };
}
