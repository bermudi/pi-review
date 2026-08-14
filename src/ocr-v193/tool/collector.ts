// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/comment_collector.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/types.js";

/**
 * CommentCollector is a per-Agent comment store.
 * Mirrors Go's `type CommentCollector struct { mu sync.Mutex; comments []LlmComment }`.
 * Each Agent instance owns its own collector so reviews across different repos do not interfere.
 * In JS the single-threaded runtime makes the mutex unnecessary, but copy-on-read semantics are preserved.
 */
export class CommentCollector {
  private comments_: LlmComment[] = [];

  // -------------------------------------------------------------------------
  // Core API — mirrors Go method names (PascalCase)
  // -------------------------------------------------------------------------

  /** Appends a comment — mirrors Go `Add`. */
  Add(cm: LlmComment): void {
    this.comments_.push({ ...cm });
  }

  /** Returns all collected comments (copy) — mirrors Go `Comments`. */
  Comments(): LlmComment[] {
    return this.comments_.map((c) => ({ ...c }));
  }

  /** Returns comments for a given path — mirrors Go `CommentsForPath`. */
  CommentsForPath(path: string): LlmComment[] {
    return this.comments_.filter((c) => c.path === path).map((c) => ({ ...c }));
  }

  /**
   * Snapshot returns the current count of stored comments.
   * Pair with Since / ReplaceSince to operate on the comments added between two points in time.
   * Mirrors Go `Snapshot() int`.
   */
  Snapshot(): number {
    return this.comments_.length;
  }

  /**
   * Since returns a copy of all comments stored at index ≥ start.
   * Returns null when no new comments have been added since the snapshot — mirrors Go's `nil` return.
   * Mirrors Go `Since(start int) []LlmComment`.
   */
  Since(start: number): LlmComment[] | null {
    if (start < 0) start = 0;
    if (start >= this.comments_.length) return null;
    return this.comments_.slice(start).map((c) => ({ ...c }));
  }

  /**
   * ReplaceSince replaces comments[start:] with the given replacements.
   * Useful for batch-level dedup: take a Snapshot, run a batch, dedup the new comments, then apply the deduped list.
   * Mirrors Go `ReplaceSince(start int, replacements []LlmComment)`.
   */
  ReplaceSince(start: number, replacements: LlmComment[]): void {
    if (start < 0) start = 0;
    if (start > this.comments_.length) return;
    const prefix = this.comments_.slice(0, start).map((c) => ({ ...c }));
    const repl = replacements.map((c) => ({ ...c }));
    this.comments_ = [...prefix, ...repl];
  }

  /**
   * RemoveByPathAndIndices removes comments for a given path whose per-path index
   * (0-based position among all comments with that path) is in the indices set.
   * Mirrors Go `RemoveByPathAndIndices(path string, indices map[int]struct{})`.
   */
  RemoveByPathAndIndices(path: string, indices: Set<number> | Map<number, unknown> | Record<number, unknown>): void {
    const toRemove = new Set<number>();
    if (indices instanceof Set || indices instanceof Map) {
      for (const k of indices.keys()) toRemove.add(k as number);
    } else if (typeof indices === "object" && indices !== null) {
      for (const k of Object.keys(indices)) toRemove.add(Number(k));
    }

    const kept: LlmComment[] = [];
    let pathIdx = 0;
    for (const cm of this.comments_) {
      if (cm.path === path) {
        if (toRemove.has(pathIdx)) {
          pathIdx++;
          continue;
        }
        pathIdx++;
      }
      kept.push(cm);
    }
    this.comments_ = kept;
  }

  /**
   * RemoveByPath removes all comments for a given path.
   * Convenience alias not in Go but requested by task spec `RemoveByPath`.
   * Implemented in terms of RemoveByPathAndIndices.
   */
  RemoveByPath(path: string): void {
    this.comments_ = this.comments_.filter((c) => c.path !== path);
  }

  // -------------------------------------------------------------------------
  // Aliases for JS-idiomatic camelCase — mirrors loop.ts dual naming support
  // -------------------------------------------------------------------------

  /** Alias for `Add` — JS camelCase. */
  add(cm: LlmComment): void {
    this.Add(cm);
  }

  /** Alias for `Comments` — JS camelCase. */
  comments(): LlmComment[] {
    return this.Comments();
  }

  /** Alias for `CommentsForPath`. */
  commentsForPath(path: string): LlmComment[] {
    return this.CommentsForPath(path);
  }

  /** Alias for `Snapshot`. */
  snapshot(): number {
    return this.Snapshot();
  }

  /** Alias for `Since`. */
  since(start: number): LlmComment[] | null {
    return this.Since(start);
  }

  /** Alias for `ReplaceSince`. */
  replaceSince(start: number, replacements: LlmComment[]): void {
    this.ReplaceSince(start, replacements);
  }

  /** Alias for `RemoveByPathAndIndices`. */
  removeByPathAndIndices(path: string, indices: Set<number> | Map<number, unknown> | Record<number, unknown>): void {
    this.RemoveByPathAndIndices(path, indices);
  }

  /** Alias for `RemoveByPath`. */
  removeByPath(path: string): void {
    this.RemoveByPath(path);
  }
}

/** Factory — mirrors Go `NewCommentCollector()`. */
export function NewCommentCollector(): CommentCollector {
  return new CommentCollector();
}

/** Lowercase factory alias. */
export function newCommentCollector(): CommentCollector {
  return new CommentCollector();
}

export default CommentCollector;
