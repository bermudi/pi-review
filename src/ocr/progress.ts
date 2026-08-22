// SPDX-License-Identifier: Apache-2.0
/** Per-run boundary for non-document progress output. */
export interface ProgressEvent {
  readonly kind: "progress";
  readonly message: string;
}

export interface ProgressSink {
  emit(event: ProgressEvent): void;
}
