// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Narrow contract error for eval-harness inputs and outputs.
 *
 * Thrown for: corpus manifest contract violations, tampered content hashes,
 * judge output that does not classify findings exactly once, and report
 * misuse (existing run directory, unsafe run id). Engine review failures are
 * eval *evidence* and are reported in run records, never as this error.
 */
export class EvalContractError extends Error {
	/** One human-readable issue per violation, e.g. `/headCommit: must match pattern ...`. */
	readonly issues: readonly string[];

	constructor(message: string, issues: readonly string[] = []) {
		super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
		this.name = "EvalContractError";
		this.issues = issues;
	}
}
