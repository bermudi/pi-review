// SPDX-License-Identifier: Apache-2.0
// Ported from spike/feasibility-v2.ts PiTransport seam at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Tests the public Pi adapter without a live model, via a fake session.

import { describe, it, expect } from "bun:test";
import { PiTransport } from "../../src/ocr-v193/pi-adapter/pi-transport.js";
import type { ChatRequest } from "../../src/ocr-v193/llmloop/types.js";
import { newTextMessage } from "../../src/ocr-v193/llmloop/compression.js";

function fakeSession(overrides: Record<string, unknown> = {}): any {
  return {
    state: { messages: [] as unknown[] },
    messages: [] as unknown[],
    agent: { state: { messages: [] as unknown[] } },
    isIdle: true,
    isStreaming: false,
    sessionId: "test-session",
    // Minimal Pi API for PiTransport fallback path: if subscribe/waitForIdle missing, PiTransport returns stub
    ...overrides,
  };
}

describe("ocr-v193 pi-adapter", () => {
  it("is exported from public index", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof (mod as any).PiTransport).toBe("function");
    expect(typeof (mod as any).createPiTransportForFile).toBe("function");
  });

  it("PiTransport complete with fake session returns stub without crashing", async () => {
    const session = fakeSession();
    const transport = new PiTransport(session as any);
    const req: ChatRequest = {
      model: "test-model",
      messages: [newTextMessage("system", "sys"), newTextMessage("user", "hello")],
      tools: [{ type: "function", function: { name: "code_comment", description: "c" } }],
      maxTokens: 100,
      sessionId: "s",
    };
    const signal = AbortSignal.timeout(1000);
    const res = await transport.complete(req, signal);
    expect(res).toBeDefined();
    expect(Array.isArray(res.toolCalls)).toBe(true);
  });

  it("PiTransport syncs allowlist via setActiveToolsByName before prompt", async () => {
    let capturedNames: string[] | null = null;
    const session = fakeSession({
      setActiveToolsByName: (names: string[]) => { capturedNames = names; },
      subscribe: (l: (e: unknown) => void) => { void l; return () => {}; },
      waitForIdle: async () => {},
      prompt: async () => {},
    });
    // Provide a minimal subscribe that captures turn_end immediately
    const transport = new PiTransport(session as any);
    const req: ChatRequest = {
      model: "test-model",
      messages: [newTextMessage("user", "hi")],
      tools: [
        { type: "function", function: { name: "code_comment", description: "c" } },
        { type: "function", function: { name: "task_done", description: "d" } },
      ],
      maxTokens: 100,
      sessionId: "s",
    };
    // Mock session to have setActiveToolsByName and prompt
    // PiTransport will call setActiveToolsByName with ["code_comment","task_done"] before prompt
    await transport.complete(req, AbortSignal.timeout(1000));
    expect(capturedNames!).toEqual(["code_comment", "task_done"]);
  });

  it("PiTransport forwards abort signal to session.abort", async () => {
    let abortCalled = false;
    const session = fakeSession({
      setActiveToolsByName: () => {},
      subscribe: () => () => {},
      waitForIdle: async () => { await new Promise(r => setTimeout(r, 100)); },
      prompt: async () => { await new Promise(r => setTimeout(r, 100)); },
      abort: async () => { abortCalled = true; },
    });
    const transport = new PiTransport(session as any);
    const req: ChatRequest = {
      model: "test-model",
      messages: [newTextMessage("user", "hi")],
      tools: [],
      maxTokens: 100,
      sessionId: "s",
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    try {
      await transport.complete(req, controller.signal);
    } catch (e) {
      expect((e as Error).name === "AbortError" || (e as Error).message.includes("Aborted")).toBe(true);
    }
    // Allow abort to propagate
    await new Promise(r => setTimeout(r, 50));
    expect(abortCalled).toBe(true);
  });
});
