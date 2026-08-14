// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/model/diff.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Diff represents a single file change in a git diff.
 * Mirrors Go's `model.Diff` struct. Field names are camelCase for
 * ergonomics; JSON mapping uses the Go `json:"..."` tags (snake_case).
 */
export interface Diff {
  /** Previous path for renames; mirrors `OldPath` json:"old_path". */
  oldPath: string;
  /** New/current path; mirrors `NewPath` json:"new_path". */
  newPath: string;
  /** Unified diff text; mirrors `Diff` json:"diff". */
  diff: string;
  /** Full new file content; mirrors `NewFileContent` json:"new_file_content". */
  newFileContent: string;
  /** Whether the file is binary; mirrors `IsBinary` json:"is_binary". */
  isBinary: boolean;
  /** Whether the file was deleted; mirrors `IsDeleted` json:"is_deleted". */
  isDeleted: boolean;
  /** Whether the file is newly added; mirrors `IsNew` json:"is_new". */
  isNew: boolean;
  /** Whether the file was renamed; mirrors `IsRenamed` json:"is_renamed". */
  isRenamed: boolean;
  /** Inserted line count; mirrors `Insertions` json:"insertions". */
  insertions: number;
  /** Deleted line count; mirrors `Deletions` json:"deletions". */
  deletions: number;
}

/**
 * Raw JSON shape exactly matching Go's `json` tags.
 * Use `diffToJson` / `diffFromJson` for conversion.
 */
export interface DiffJson {
  old_path: string;
  new_path: string;
  diff: string;
  new_file_content: string;
  is_binary: boolean;
  is_deleted: boolean;
  is_new: boolean;
  is_renamed: boolean;
  insertions: number;
  deletions: number;
}

/** Create a Diff with defaults for omitted fields (mirrors Go zero values). */
export function createDiff(partial: Partial<Diff> = {}): Diff {
  return {
    oldPath: partial.oldPath ?? "",
    newPath: partial.newPath ?? "",
    diff: partial.diff ?? "",
    newFileContent: partial.newFileContent ?? "",
    isBinary: partial.isBinary ?? false,
    isDeleted: partial.isDeleted ?? false,
    isNew: partial.isNew ?? false,
    isRenamed: partial.isRenamed ?? false,
    insertions: partial.insertions ?? 0,
    deletions: partial.deletions ?? 0,
  };
}

/** Convert a camelCase Diff to its snake_case JSON representation. */
export function diffToJson(d: Diff): DiffJson {
  return {
    old_path: d.oldPath,
    new_path: d.newPath,
    diff: d.diff,
    new_file_content: d.newFileContent,
    is_binary: d.isBinary,
    is_deleted: d.isDeleted,
    is_new: d.isNew,
    is_renamed: d.isRenamed,
    insertions: d.insertions,
    deletions: d.deletions,
  };
}

/** Convert a snake_case JSON object to a camelCase Diff. */
export function diffFromJson(j: DiffJson): Diff {
  return {
    oldPath: j.old_path ?? "",
    newPath: j.new_path ?? "",
    diff: j.diff ?? "",
    newFileContent: j.new_file_content ?? "",
    isBinary: Boolean(j.is_binary),
    isDeleted: Boolean(j.is_deleted),
    isNew: Boolean(j.is_new),
    isRenamed: Boolean(j.is_renamed),
    insertions: typeof j.insertions === "number" ? j.insertions : 0,
    deletions: typeof j.deletions === "number" ? j.deletions : 0,
  };
}

/**
 * Parse an unknown JSON value into a Diff, validating field types.
 * Returns a Diff with zero-value defaults for missing fields. This is
 * permissive for resilience; callers that need strict validation should
 * check the raw JSON themselves.
 */
export function parseDiffFromUnknown(value: unknown): Diff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createDiff();
  }
  const obj = value as Record<string, unknown>;
  return {
    oldPath: typeof obj["old_path"] === "string" ? (obj["old_path"] as string) : "",
    newPath: typeof obj["new_path"] === "string" ? (obj["new_path"] as string) : "",
    diff: typeof obj["diff"] === "string" ? (obj["diff"] as string) : "",
    newFileContent:
      typeof obj["new_file_content"] === "string" ? (obj["new_file_content"] as string) : "",
    isBinary: Boolean(obj["is_binary"]),
    isDeleted: Boolean(obj["is_deleted"]),
    isNew: Boolean(obj["is_new"]),
    isRenamed: Boolean(obj["is_renamed"]),
    insertions: typeof obj["insertions"] === "number" ? (obj["insertions"] as number) : 0,
    deletions: typeof obj["deletions"] === "number" ? (obj["deletions"] as number) : 0,
  };
}

/** JSON.stringify-compatible replacer: delegates to diffToJson. */
export function stringifyDiff(d: Diff): string {
  return JSON.stringify(diffToJson(d));
}

/** Parse a JSON string produced by Go's `json.Marshal(Diff)`. */
export function parseDiffJson(json: string): Diff {
  const raw: unknown = JSON.parse(json) as unknown;
  return parseDiffFromUnknown(raw);
}
