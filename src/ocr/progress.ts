// SPDX-License-Identifier: Apache-2.0
/** Per-run boundary for non-document progress output. */
export interface ProgressEvent {
  readonly kind: "progress";
  readonly message: string;
}

export interface ProgressSink {
  emit(event: ProgressEvent): void;
}

/**
 * Per-file lifecycle status lines for dispatch loops (review and scan):
 * a line when a file starts, a line when it finishes with its note count
 * and a run-level done counter, and a quiet warning emitted halfway into
 * the per-file idle timeout. Metadata only — never model message content.
 * All emission is best-effort: a throwing sink must never break a review.
 */
export class FileStatusLines {
  private finished = 0;

  constructor(
    private readonly emit: (message: string) => void,
    private readonly total: number,
  ) {}

  start(path: string): void {
    this.tryEmit(`[pi-review] Checking ${path}...`);
  }

  done(path: string, notes: number): void {
    this.finished++;
    const unit = notes === 1 ? "note" : "notes";
    this.tryEmit(`[pi-review] ${path} done, ${notes} ${unit} (${this.finished}/${this.total} files done)`);
  }

  /** Counts a file that finished without a done line (failed or reused). */
  countFinished(): void {
    this.finished++;
  }

  quiet(path: string, minutes: string): void {
    this.tryEmit(`[pi-review] ${path}: still waiting, no activity for ${minutes} min`);
  }

  private tryEmit(message: string): void {
    try {
      this.emit(message);
    } catch {
      // Progress is best-effort; never break the dispatch loop.
    }
  }
}

/** Human-readable quiet-warning threshold: half the per-file idle timeout. */
export function quietWaitMinutes(timeoutMs: number): string {
  const minutes = timeoutMs / 2 / 60000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}
