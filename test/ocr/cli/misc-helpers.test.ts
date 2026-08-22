// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/misc_helpers_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reviewModeFromOptions } from "../../../src/ocr/cli/review.js";
import { sanitizeEndpointHost } from "../../../src/ocr/cli/shared.js";
import { shortSessionID, completeSessionIDs } from "../../../src/ocr/cli/session.js";

// OCR v1.9.3: TestReviewModeFromOptions
test("TestReviewModeFromOptions precedence and fallbacks", () => {
  type Case = { name: string; opts: Record<string, string>; want: string };
  const cases: Case[] = [
    { name: "commit", opts: { commit: "abc" }, want: "commit" },
    { name: "range", opts: { from: "main", to: "dev" }, want: "range" },
    { name: "workspace", opts: {}, want: "workspace" },
    { name: "from only falls back to workspace", opts: { from: "main" }, want: "workspace" },
  ];

  for (const c of cases) {
    const got = reviewModeFromOptions(c.opts as never);
    expect(got, c.name).toBe(c.want);
  }
});

// OCR v1.9.3: TestSanitizeEndpointHost
test("TestSanitizeEndpointHost edge handling", () => {
  type Case = { name: string; in: string; want: string };
  const cases: Case[] = [
    { name: "empty", in: "", want: "" },
    { name: "whitespace", in: "   ", want: "" },
    { name: "strips credentials and path", in: "https://user:pass@API.example.com:8080/v1/chat?k=1#frag", want: "api.example.com:8080" },
    { name: "lowercases host", in: "https://Example.COM", want: "example.com" },
    { name: "no host yields empty", in: "mailto:foo@bar.com", want: "" },
    { name: "unparseable yields empty", in: "://:::", want: "" },
  ];

  for (const c of cases) {
    const got = sanitizeEndpointHost(c.in);
    expect(got, `${c.name}: sanitizeEndpointHost(${JSON.stringify(c.in)})`).toBe(c.want);
  }
});

// OCR v1.9.3: TestShortSessionID
test("TestShortSessionID truncation and pass-through", () => {
  expect(shortSessionID("0123456789abcdef")).toBe("01234567");
  expect(shortSessionID("short")).toBe("short");
  expect(shortSessionID("12345678")).toBe("12345678");
  // Additional edges mirroring Go len checks
  expect(shortSessionID("")).toBe("");
  expect(shortSessionID("012345678")).toBe("01234567");
});

// OCR v1.9.3: TestCompleteSessionIDs
test("TestCompleteSessionIDs with args and fresh repo yields no completions", () => {
  // with args returns no completions (no filtering by toComplete, early exit)
  {
    const cmd = {
      Flags: {
        GetString(_name: string) {
          return "";
        },
      },
    } as unknown as Parameters<typeof completeSessionIDs>[0];
    const [comps, directive] = completeSessionIDs(cmd, ["already"], "");
    // Go expects nil completions; TS returns [] — both length 0. Verify length 0 and NoFileComp.
    expect(comps.length).toBe(0);
    expect(directive).toBe(4); // cobra.ShellCompDirectiveNoFileComp
  }

  // fresh repo yields empty completions (no sessions persisted)
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
    try {
      const cmd = {
        Flags: {
          GetString(name: string) {
            if (name === "repo") return repoDir;
            return "";
          },
        },
      } as unknown as Parameters<typeof completeSessionIDs>[0];
      const [comps, directive] = completeSessionIDs(cmd, null as unknown as [], "");
      expect(comps.length).toBe(0);
      expect(directive).toBe(4);
      // also with prefix filter on empty store
      const [comps2, directive2] = completeSessionIDs(cmd, [], "any");
      expect(comps2.length).toBe(0);
      expect(directive2).toBe(4);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }
});
