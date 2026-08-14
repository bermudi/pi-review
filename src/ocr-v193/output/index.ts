// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/output.go, sarif.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Output barrel for the OCR v1.9.3 CLI — re-exports the parity rendering
 * surface so consumers can import from either `src/ocr-v193/cli/output.ts`
 * or the `src/ocr-v193/output` namespace.
 *
 * No legacy `src/output` import; this is the parity path.
 */

export * from "../cli/output.js";
export * from "../cli/sarif.js";
