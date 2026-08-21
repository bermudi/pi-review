// SPDX-License-Identifier: Apache-2.0
// Ported from spike/feasibility-v2.ts PiTransport seam at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Tests the public Pi adapter without a live model, via a fake session.

import { describe, it, expect, spyOn } from "bun:test";
import { PiTransport } from "../../src/ocr-v193/pi-adapter/pi-transport.js";
import type { ChatRequest } from "../../src/ocr-v193/llmloop/types.js";
import { newTextMessage } from "../../src/ocr-v193/llmloop/compression.js";

function fakeSession(overrides: Record<string, unknown> = {}): unknown {
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

function toolRequest(): ChatRequest {
  return {
    model: "test-model",
    messages: [newTextMessage("user", "review")],
    tools: [{ type: "function", function: { name: "task_done", description: "finish" } }],
    maxTokens: 100,
    sessionId: "s",
  };
}

function eventSession(message: unknown): unknown {
  let listener: ((event: unknown) => void) | undefined;
  return fakeSession({
    setActiveToolsByName: () => {},
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {};
    },
    prompt: async () => {
      listener?.({ type: "turn_end", message });
    },
    waitForIdle: async () => {},
    abort: () => {},
  });
}

function transportFor(session: unknown): PiTransport {
  return new PiTransport(session as ConstructorParameters<typeof PiTransport>[0]);
}

describe("ocr-v193 pi-adapter", () => {
  it("is exported from public index", async () => {
    const mod = await import("../../src/index.js");
    const exports = mod as unknown as Record<string, unknown>;
    expect(typeof exports["PiTransport"]).toBe("function");
    expect(typeof exports["createPiTransportForFile"]).toBe("function");
  });

  it("PiTransport complete with fake session returns stub without crashing", async () => {
    const session = fakeSession();
    const transport = transportFor(session);
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
    const transport = transportFor(session);
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

  // OCR v1.9.3: TestOpenAIClient_StreamingCancellation
  it("PiTransport forwards abort signal to session.abort", async () => {
    let abortCalled = false;
    const session = fakeSession({
      setActiveToolsByName: () => {},
      subscribe: () => () => {},
      waitForIdle: async () => { await new Promise(r => setTimeout(r, 100)); },
      prompt: async () => { await new Promise(r => setTimeout(r, 100)); },
      abort: async () => { abortCalled = true; },
    });
    const transport = transportFor(session);
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

  it("classifies text-only assistant responses without logging their content", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = eventSession({
        role: "assistant",
        content: [{ type: "text", text: "SECRET_ASSISTANT_TEXT" }],
        stopReason: "stop",
      });
      const transport = transportFor(session);

      const response = await transport.complete(toolRequest(), AbortSignal.timeout(1000));

      expect(response.toolCalls).toHaveLength(0);
      expect(warning).toHaveBeenCalledTimes(1);
      const line = String(warning.mock.calls[0]?.[0]);
      expect(line).toContain("kind=assistant_text_only");
      expect(line).toContain("source=turn_end");
      expect(line).toContain("text=present");
      expect(line).not.toContain("SECRET_ASSISTANT_TEXT");
    } finally {
      warning.mockRestore();
    }
  });

  it("distinguishes malformed Pi tool blocks from text-only responses", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = eventSession({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", arguments: { secret: "SECRET_ARGUMENT" } }],
        stopReason: "toolUse",
      });
      const transport = transportFor(session);

      await transport.complete(toolRequest(), AbortSignal.timeout(1000));

      const line = String(warning.mock.calls[0]?.[0]);
      expect(line).toContain("kind=tool_call_extraction_failed");
      expect(line).toContain("tool_blocks=1");
      expect(line).toContain("invalid_tool_blocks=1");
      expect(line).not.toContain("SECRET_ARGUMENT");
    } finally {
      warning.mockRestore();
    }
  });

  it("reports provider/session error stops without leaking error details", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = eventSession({
        role: "assistant",
        content: [{ type: "text", text: "SECRET_PROVIDER_ERROR" }],
        stopReason: "error",
        errorMessage: "SECRET_ERROR_DETAIL",
      });
      const transport = transportFor(session);

      await transport.complete(toolRequest(), AbortSignal.timeout(1000));

      const line = String(warning.mock.calls[0]?.[0]);
      expect(line).toContain("kind=session_error");
      expect(line).toContain("stop_reason=error");
      expect(line).not.toContain("SECRET_PROVIDER_ERROR");
      expect(line).not.toContain("SECRET_ERROR_DETAIL");
    } finally {
      warning.mockRestore();
    }
  });

  it("does not emit an empty-tool diagnostic for a valid tool call", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = eventSession({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "task_done", arguments: { state: "DONE" } }],
        stopReason: "toolUse",
      });
      const transport = transportFor(session);

      const response = await transport.complete(toolRequest(), AbortSignal.timeout(1000));

      expect(response.toolCalls).toHaveLength(1);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("does not diagnose plain-text plan and filter requests that advertise no tools", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = eventSession({
        role: "assistant",
        content: [{ type: "text", text: "plain structured response" }],
        stopReason: "stop",
      });
      const transport = transportFor(session);
      const req: ChatRequest = {
        ...toolRequest(),
        tools: undefined,
      };

      const response = await transport.complete(req, AbortSignal.timeout(1000));

      expect(response.content).toBe("plain structured response");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("reports a prompt failure as a fixed stage without logging the exception", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const session = fakeSession({
        setActiveToolsByName: () => {},
        subscribe: () => () => {},
        prompt: async () => {
          throw new Error("SECRET_PROMPT_FAILURE");
        },
        waitForIdle: async () => {},
      });
      const transport = transportFor(session);

      await transport.complete(toolRequest(), AbortSignal.timeout(1000));

      const line = String(warning.mock.calls[0]?.[0]);
      expect(line).toContain("kind=session_error");
      expect(line).toContain("stage=prompt");
      expect(line).not.toContain("SECRET_PROMPT_FAILURE");
    } finally {
      warning.mockRestore();
    }
  });
});
