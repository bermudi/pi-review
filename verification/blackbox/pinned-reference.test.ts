// Active-gate guard: historical provenance may mention v1.9.3, selectors may not.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const activePin = /(?:PINNED_TAG|expectedTag|binaryPath)\s*=\s*["`][^"`]*v1\.9\.3|(?:rev-parse|archive|cat-file)[^"\n]*v1\.9\.3|ocr-v1\.9\.3/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(dir, entry.name);
    return entry.isDirectory() ? sources(child) : entry.name.endsWith(".ts") ? [child] : [];
  });
}

test("active black-box gates cannot select the retired OCR v1.9.3 pin", () => {
  const stale = sources(ROOT)
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => activePin.test(readFileSync(file, "utf8")));
  expect(stale).toEqual([]);
});
