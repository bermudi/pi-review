// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/definitions.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Tool represents a single review tool — mirrors Go's `type Tool struct { name string }`.
 * Value semantics: equality is by name.
 */
export class Tool {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  /** Returns the tool's identifier name — mirrors Go `Tool.Name()`. */
  Name(): string {
    return this.#name;
  }

  /** Mirrors Go `Tool.IsKnown()`: false only for Unknown. */
  IsKnown(): boolean {
    return this.#name !== Unknown.Name();
  }

  toString(): string {
    return this.#name;
  }

  valueOf(): string {
    return this.#name;
  }

  /** Strict equality by name — mirrors Go `t != Unknown` comparison. */
  equals(other: Tool): boolean {
    return other instanceof Tool && this.#name === other.#name;
  }
}

// ---------------------------------------------------------------------------
// Built-in tool singletons — mirrors Go `var ( Unknown, TaskDone, ...)`
// ---------------------------------------------------------------------------

export const Unknown = new Tool("unknown");
export const TaskDone = new Tool("task_done");
export const CodeComment = new Tool("code_comment");
export const FileRead = new Tool("file_read");
export const FileFind = new Tool("file_find");
export const FileReadDiff = new Tool("file_read_diff");
export const CodeSearch = new Tool("code_search");

function allTools(): Tool[] {
  return [Unknown, TaskDone, CodeComment, FileRead, FileFind, FileReadDiff, CodeSearch];
}

/**
 * OfName returns the Tool matching name, or Unknown when not found.
 * Mirrors Go `OfName`.
 */
export function OfName(name: string): Tool {
  for (const t of allTools()) {
    if (t.Name() === name) return t;
  }
  return Unknown;
}

/**
 * IsReserved reports whether name matches any built-in tool name (including Unknown).
 * Mirrors Go `IsReserved`.
 */
export function IsReserved(name: string): boolean {
  for (const t of allTools()) {
    if (t.Name() === name) return true;
  }
  return false;
}

/**
 * Dynamic creates a Tool with the given name for dynamically discovered tools (e.g. MCP).
 * Mirrors Go `Dynamic`: panics on empty or reserved name.
 */
export function Dynamic(name: string): Tool {
  if (name === "") {
    throw new Error("tool: Dynamic called with empty name");
  }
  if (IsReserved(name)) {
    throw new Error(`tool: Dynamic called with reserved tool name ${JSON.stringify(name)}`);
  }
  return new Tool(name);
}

// ---------------------------------------------------------------------------
// Constants mirrored from response_message.go / definitions.go
// ---------------------------------------------------------------------------

/** Sentinel error for unknown tool — mirrors Go `ErrToolNotFound`. */
export const ErrToolNotFound = new Error("tool not found");

/** Canonical not-available message — mirrors Go `NotAvailableMsg` / `ToolNotFoundMsg`. */
export const NotAvailableMsg =
  "Error: Tool not found. The tool you attempted to call does not exist or is not available. Please check the tool name and try again with a valid tool.";

export const ToolNotFoundMsg = NotAvailableMsg;

/** Success message for code_comment — mirrors Go `CommentSucceed`. */
export const CommentSucceed = "Successfully commented.";
