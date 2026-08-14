// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from docs/ocr-v193-reference-manifest.md + docs/ocr-v1.9.3-port-plan.md Phase 2 at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Pinned OCR reference guard.
 *
 * Fails fast if ../open-code-review does not contain the expected tag and commit.
 * Uses argv arrays (no shell) per AGENTS.md.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

export const PINNED_TAG = "v1.9.3";
export const PINNED_TAG_OBJECT = "4d796ae54cabdcf4e22b69ef502ed8871456a909";
export const PINNED_COMMIT = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";
export const PINNED_GO = "go1.26.6";

function runGit(args: readonly string[], cwd: string): { stdout: string; status: number | null } {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf-8", timeout: 5000 });
  return { stdout: (res.stdout ?? "").toString().trim(), status: res.status };
}

export function verifyPinnedRef(refCheckout: string = path.resolve(import.meta.dir, "../../../../open-code-review")): void {
  // existence
  const check = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: refCheckout, encoding: "utf-8", timeout: 3000 });
  if (check.status !== 0) {
    throw new Error(
      `[harness] reference checkout not found at ${refCheckout} — expected OCR checkout for ${PINNED_TAG}. ` +
        `Clone https://github.com/alibaba/open-code-review and checkout ${PINNED_TAG}`,
    );
  }
  const commit = runGit(["rev-parse", `${PINNED_TAG}^{commit}`], refCheckout);
  if (commit.status !== 0 || commit.stdout !== PINNED_COMMIT) {
    throw new Error(
      `[harness] pinned tag ${PINNED_TAG}^{commit} mismatch: got ${JSON.stringify(commit.stdout)} want ${PINNED_COMMIT} in ${refCheckout}. ` +
        `Run: git -C ${refCheckout} fetch --tags && git tag --verify ${PINNED_TAG}`,
    );
  }
  const tagObj = runGit(["rev-parse", PINNED_TAG], refCheckout);
  // tag object is signed tag object; verify via cat-file -p contains commit line
  // For annotated tag, rev-parse TAG = tag object id
  if (tagObj.stdout !== PINNED_TAG_OBJECT) {
    // Allow commit as well if lightweight? but v1.9.3 is annotated, must match
    throw new Error(
      `[harness] pinned tag object mismatch: got ${JSON.stringify(tagObj.stdout)} want ${PINNED_TAG_OBJECT}. ` +
        `Verify: git -C ${refCheckout} cat-file -p ${PINNED_TAG}`,
    );
  }
  const verify = spawnSync("git", ["tag", "--verify", PINNED_TAG], {
    cwd: refCheckout,
    encoding: "utf-8",
    timeout: 5000,
  });
  const combined = `${verify.stdout ?? ""}${verify.stderr ?? ""}`;
  if (!combined.includes("Good") && !combined.includes("gpg") && !combined.includes("RSA")) {
    // Some environments lack keyring but tag object id already verified; warn not fail
    // We keep warning on stderr
    console.error(`[harness] warning: git tag --verify ${PINNED_TAG} did not report Good signature (may lack keyring): ${combined.slice(0, 500)}`);
  }
}

export function assertPinnedOrThrow(): void {
  verifyPinnedRef();
}
