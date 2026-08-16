// SPDX-License-Identifier: Apache-2.0
// Gate 0 black-box schemas — runtime validation of every capture.
// Allowed deps: Node stdlib + zod (already in package.json) + local types.

import { z } from "zod";

// Every HTTP body we capture should be JSON. We validate it loosely
// but reject completely broken captures so a missing file is obvious.
export const capturedHttpSchema = z.object({
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  response: z.union([
    z.object({
      status: z.number(),
      headers: z.record(z.string(), z.string()),
      body: z.unknown(),
    }),
    z.null(),
  ]),
  delivered: z.boolean(),
  sanitized: z.boolean(),
});

export const processCaptureSchema = z.object({
  engine: z.enum(["ocr", "pi"]),
  command: z.array(z.string()),
  envSanitized: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.union([z.number(), z.null()]),
  signal: z.union([z.string(), z.null()]),
  providerCaptures: z.array(capturedHttpSchema),
  artifactFiles: z.array(z.string()),
  producedAt: z.string(),
});

export const gate0ReportSchema = z.object({
  gate: z.literal("blackbox-integrity"),
  commit: z.string().min(7),
  ocrTagObject: z.string().min(7),
  ocrCommit: z.string().min(7),
  packageArchiveHash: z.union([z.string(), z.null()]),
  fixtures: z.array(z.string()),
  assertions: z.number(),
  notObservable: z.array(z.string()),
  forbiddenImports: z.number(),
  forbiddenImportDetails: z.array(z.string()),
  result: z.enum(["pass", "fail"]),
  artifactDir: z.string(),
  error: z.string().optional(),
});

// Helper: parse and throw with a clear message if invalid.
export function validateProcessCapture(data: unknown): import("./types.js").ProcessCapture {
  return processCaptureSchema.parse(data) as import("./types.js").ProcessCapture;
}

export function validateGate0Report(data: unknown): import("./types.js").Gate0Report {
  return gate0ReportSchema.parse(data) as import("./types.js").Gate0Report;
}
