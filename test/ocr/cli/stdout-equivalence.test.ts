// SPDX-License-Identifier: Apache-2.0
// OCR v1.9.9 stdout.Swap equivalence: isolated injected routers compose
// without replacing a process-global writer.

import { expect, test } from "bun:test";
import { newProgressRouter } from "../../../src/ocr/cli/shared.js";

// OCR v1.9.9: TestSwap
test("TestSwap", () => {
  const left: string[] = [];
  const right: string[] = [];
  const first = newProgressRouter({ stderr: (text) => { left.push(text); } }, "json", "human");
  const second = newProgressRouter({ stderr: (text) => { right.push(text); } }, "json", "human");
  first.emit({ kind: "progress", message: "left" });
  second.emit({ kind: "progress", message: "right" });
  expect(left).toEqual(["left\n"]);
  expect(right).toEqual(["right\n"]);
});

// OCR v1.9.9: TestSwap_Composable
test("TestSwap_Composable", () => {
  const out: string[] = [];
  const router = newProgressRouter({ stderr: (text) => { out.push(text); } }, "json", "human");
  const first = router.quiet();
  const second = router.quiet();
  router.emit({ kind: "progress", message: "hidden" });
  first.Restore();
  router.emit({ kind: "progress", message: "still hidden" });
  second.Restore();
  router.emit({ kind: "progress", message: "visible" });
  expect(out).toEqual(["visible\n"]);
});
