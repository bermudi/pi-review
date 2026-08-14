// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/* at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Barrel for the OCR v1.9.3 diff parity engine.
 *
 * Re-exports:
 * - hunk.ts        <- internal/diff/hunk.go
 * - parser.ts      <- internal/diff/parser.go
 * - workspace.ts   <- internal/diff/workspace_file.go
 * - gitignore.ts   <- internal/diff/gitignore.go (+ helpers from git.go)
 * - git.ts         <- internal/diff/git.go
 * - resolver.ts    <- internal/diff/resolver.go
 * - relocation.ts  <- internal/diff/relocation.go
 * - runner.ts      <- internal/gitcmd/runner.go
 *
 * Deterministic ordering is preserved throughout; caller sees review inputs
 * in the same order the underlying git diff emitted them.
 */

export * from "./hunk.js";
export * from "./parser.js";
export * from "./workspace.js";
export * from "./gitignore.js";
export * from "./git.js";
export * from "./resolver.js";
export * from "./relocation.js";
export * from "./runner.js";
