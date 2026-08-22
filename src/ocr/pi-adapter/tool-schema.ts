// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm client_params_test.go buildToolInputSchema at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

export interface ToolInputSchema {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: unknown;
  readonly extraFields?: Record<string, unknown>;
}

/**
 * buildToolInputSchema mirrors Go buildToolInputSchema.
 * - properties from input["properties"] when it's a map
 * - required filtered to string entries only
 * - additionalProperties preserved via extraFields
 * - reserved keys ("type","properties","required") not duplicated in extraFields
 */
export function buildToolInputSchema(input: Record<string, unknown>): {
  readonly Properties: Record<string, unknown> | undefined;
  readonly Required: readonly string[] | undefined;
  readonly ExtraFields: Record<string, unknown> | undefined;
} {
  let properties: Record<string, unknown> | undefined;
  const rawProps = input["properties"];
  if (rawProps !== null && typeof rawProps === "object" && !Array.isArray(rawProps)) {
    properties = rawProps as Record<string, unknown>;
  }

  let required: string[] | undefined;
  const rawReq = input["required"];
  if (Array.isArray(rawReq)) {
    const filtered = rawReq.filter((v): v is string => typeof v === "string");
    if (filtered.length > 0) required = filtered;
  }

  let extraFields: Record<string, unknown> | undefined;
  const reserved = new Set(["type", "properties", "required"]);
  for (const [k, v] of Object.entries(input)) {
    if (reserved.has(k)) continue;
    if (extraFields === undefined) extraFields = {};
    extraFields[k] = v;
  }
  if (extraFields !== undefined && Object.keys(extraFields).length === 0) {
    extraFields = undefined;
  }

  return {
    Properties: properties,
    Required: required,
    ExtraFields: extraFields,
  };
}
