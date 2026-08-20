// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/getters_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import { Agent } from "../../../src/ocr-v193/agent/agent.js";

describe("ocr-v193 agent getters nil-safe (ported from internal/agent/getters_test.go)", () => {
  // OCR v1.9.3: TestAgentGettersNilSafe
  test("TestAgentGettersNilSafe", () => {
    const a = Object.create(Agent.prototype) as unknown as Agent;
    expect(a.SessionID()).toBe("");
    expect(a.RunManifest()).toBeNull();

    const nilAgent = null as unknown as Agent;
    expect((Agent.prototype.SessionID as unknown as (this: unknown) => string).call(nilAgent)).toBe("");
    expect((Agent.prototype.RunManifest as unknown as (this: unknown) => unknown).call(nilAgent)).toBeNull();
  });
});
