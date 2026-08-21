// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/client.go stripThinkTags at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

/**
 * stripThinkTags removes reasoning wrapper tags <think> and </think> from content.
 * Mirrors Go stripThinkTags which constructs tag strings from individual bytes
 * and replaces all occurrences.
 */
export function stripThinkTags(s: string): string {
  const openBytes = String.fromCharCode(0x3c) + "think" + String.fromCharCode(0x3e);
  const closeBytes = String.fromCharCode(0x3c, 0x2f) + "think" + String.fromCharCode(0x3e);
  return s.split(openBytes).join("").split(closeBytes).join("");
}
