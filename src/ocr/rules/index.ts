// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/allowlist/allowed_ext.go and internal/config/rules/system_rules.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Barrel for the OCR v1.9.3 parity rules engine.
 *
 * Callers should import from `src/ocr/rules` rather than reaching
 * directly into `allowed_ext.ts` or `system_rules.ts`. No legacy engine
 * re-exports.
 */

// --- allowlist (internal/config/allowlist) ---
export {
  EXPECTED_SUPPORTED_FILE_TYPES_HASH,
  EXPECTED_DEFAULT_EXCLUDE_PATTERNS_HASH,
  resetAllowlistForTesting,
  getSupportedExtensions,
  DefaultAllowedExt,
  isAllowedExt,
  IsAllowedExt,
  isExcludedPath,
  IsExcludedPath,
  getDefaultExcludePatterns,
} from "./allowed_ext.js";
export { sha256Hex as sha256HexAllowlist } from "./allowed_ext.js";

// --- system rules (internal/config/rules) ---
export {
  EXPECTED_SYSTEM_RULES_HASH,
  EXPECTED_RULE_DOC_HASHES,
  verifyAllRuleDocHashes,
  type PathRule,
  type SystemRule,
  type RuleDetail,
  type Resolver,
  type DetailResolver,
  type ProjectRuleEntry,
  type ProjectRule,
  type FileFilter,
  expandBraces,
  parseSystemRuleJson,
  loadDefaultSystemRule,
  LoadDefault,
  LoadSystemRules,
  loadDefault,
  resolveSystemRule,
  ResolveSystemRule,
  canonicalConfigSystemRule,
  resolveDetailSystemRule,
  createFileFilter,
  hasInclude,
  HasInclude,
  isUserExcluded,
  IsUserExcluded,
  isUserIncluded,
  IsUserIncluded,
  loadProjectRule,
  loadGlobalRule,
  loadRuleFile,
  buildFileFilter,
  ComposedResolver,
  newResolver,
  NewResolver,
  LoadDefaultResolver,
} from "./system_rules.js";
export { sha256Hex as sha256HexSystem } from "./system_rules.js";
export type { LoadOptions, RuleWarnFn } from "./system_rules.js";
