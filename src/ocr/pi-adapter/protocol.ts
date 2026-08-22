// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/protocol.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later.

/**
 * Canonical protocol identifiers understood by the LLM client factory and
 * resolver. These are the only values produced by normalizeProtocol for known
 * protocols.
 */

export const ProtocolAnthropic = "anthropic";
export const ProtocolOpenAIChatCompletions = "openai";
export const ProtocolOpenAIResponses = "openai-responses";

/**
 * NormalizeProtocol canonicalizes protocol names. It is case-insensitive and
 * trims whitespace. Empty string is returned as-is. Known protocol names are
 * mapped to their canonical constants; unknown values are lowercased and trimmed.
 * Mirrors Go NormalizeProtocol.
 */
export function normalizeProtocol(raw: string): string {
  const normalized = raw.toLowerCase().trim();
  switch (normalized) {
    case "":
      return "";
    case ProtocolAnthropic:
      return ProtocolAnthropic;
    case ProtocolOpenAIChatCompletions:
      return ProtocolOpenAIChatCompletions;
    case ProtocolOpenAIResponses:
      return ProtocolOpenAIResponses;
    default:
      return normalized;
  }
}

/**
 * ValidateProtocol accepts the three canonical protocol names and rejects
 * everything else. Mirrors Go ValidateProtocol.
 */
export function validateProtocol(p: string): void {
  switch (p) {
    case ProtocolAnthropic:
    case ProtocolOpenAIChatCompletions:
    case ProtocolOpenAIResponses:
      return;
    default:
      throw new Error(
        `unsupported protocol "${p}"; supported protocols are "${ProtocolAnthropic}", "${ProtocolOpenAIChatCompletions}", "${ProtocolOpenAIResponses}"`,
      );
  }
}
