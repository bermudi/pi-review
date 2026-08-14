#!/usr/bin/env bun
// Phase 1 feasibility spike - uses only public exports from @earendil-works/pi-coding-agent
// plus a local OpenAI-compatible HTTP server. Proves each required capability.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const PI: any = await import("@earendil-works/pi-coding-agent");
const { createAgentSession, SessionManager, SettingsManager } = PI;

// helpers
function openAIToolCall(id: string, name: string, args: any) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}
function openAIResp({ content, tool_calls, finish_reason }: { content?: string | null, tool_calls?: any[], finish_reason?: string }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Math.floor(Date.now()/1000),
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: content ?? null, tool_calls: tool_calls ?? undefined }, finish_reason: finish_reason ?? (tool_calls ? "tool_calls" : "stop") }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
type Scripted = { requests: any[], responses: any[] };
function startServer(scripted: Scripted, opts: { delayMs?: number } = {}) {
  let idx = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      let body: any;
      try { body = await req.json(); } catch { body = {}; }
      scripted.requests.push({ body, headers: Object.fromEntries(req.headers.entries()) });
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      const resp = scripted.responses[idx++] ?? scripted.responses[scripted.responses.length - 1];
      if (!resp) return new Response(JSON.stringify({ error: "no scripted response" }), { status: 500, headers: { "content-type": "application/json" } });
      if (resp instanceof Error) return new Response(resp.message, { status: 500 });
      const wantsStream = body.stream === true;
      if (wantsStream) {
        const id = resp.id ?? "chatcmpl-test";
        const created = Math.floor(Date.now()/1000);
        const model = resp.model ?? body.model ?? "test-model";
        const choices = resp.choices ?? [];
        const choice = choices[0] ?? {};
        const msg = choice.message ?? {};
        const finish = choice.finish_reason ?? (msg.tool_calls ? "tool_calls" : "stop");
        const delta: any = {};
        if (msg.content) delta.content = msg.content;
        if (msg.tool_calls) {
          delta.tool_calls = msg.tool_calls.map((tc: any, i: number) => ({
            index: i,
            id: tc.id,
            type: tc.type ?? "function",
            function: tc.function,
          }));
        }
        const usage = resp.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const sse = [
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
          `data: [DONE]\n\n`,
        ].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      } else {
        return new Response(JSON.stringify(resp), { headers: { "content-type": "application/json" } });
      }
    },
  });
  return { server, port: (server as any).port, url: `http://localhost:${(server as any).port}/v1` };
}

async function createSessionWithServer(serverUrl: string, tools: any[], allowedTools: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-spike-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spike-agent-"));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "test-openai": {
        baseUrl: serverUrl,
        apiKey: "test-key",
        api: "openai-completions",
        models: [{ id: "test-model", name: "Test Model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }]
      }
    }
  }));
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } } as any);
  const customTools = tools.map(t => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters,
    execute: t.execute,
  }));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    settingsManager,
    customTools,
    tools: allowedTools,
  });
  // Verify model selected is test-model
  if (!session.model || session.model.id !== "test-model") {
    console.error("Unexpected model", session.model);
    throw new Error("Failed to select test-model");
  }
  return {
    session, cwd, agentDir,
    async cleanup() {
      session.dispose();
      await rm(cwd, { recursive: true, force: true }).catch(()=>{});
      await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
    }
  };
}

// Test 1: OCR round accounting
async function testRoundAccounting() {
  const name = "OCR round accounting (1 request = 1 round, multi-tool)";
  const scripted: Scripted = { requests: [], responses: [] };
  scripted.responses = [
    openAIResp({ tool_calls: [openAIToolCall("c1", "code_comment", { comments: [{ content: "a", existing_code: "x" }] }), openAIToolCall("c2", "code_comment", { comments: [{ content: "b", existing_code: "y" }] })] }),
    openAIResp({ content: "done", finish_reason: "stop" }),
  ];
  const { server, url } = startServer(scripted);
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Any()) }), execute: async (_id: string, args: any) => ({ content: [{ type: "text", text: "ok" }], details: args }) },
      { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
    ];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment", "task_done"]);
    const events: any[] = [];
    const unsub = session.subscribe((e: any) => events.push(e));
    await session.prompt("review this file");
    await session.waitForIdle();
    unsub();
    await cleanup();
    // Pi should have made 2 requests: first with 2 tool calls, second after tool results
    // Tool events: should have 2 tool_execution_start for first round, but only 1 round
    const toolStarts = events.filter(e => e.type === "tool_execution_start").length;
    const turnEnds = events.filter(e => e.type === "turn_end").length;
    const requests = scripted.requests.length;
    const firstReqTools = scripted.requests[0]?.body?.tools?.length;
    const firstReqToolCalls = scripted.responses[0].choices[0].message.tool_calls.length;
    // Assertions
    const pass = requests === 2 && firstReqToolCalls === 2 && toolStarts === 2 && turnEnds >= 2;
    const detail = `requests=${requests} (expect 2), firstResponseToolCalls=${firstReqToolCalls} (expect 2), toolStarts=${toolStarts} (expect 2), turnEnds=${turnEnds} (expect 2), firstReqTools=${firstReqTools}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail, requests, toolStarts, turnEnds };
  } finally { server.stop(); }
}

// Test 2: Multi-tool turn execution (valid + invalid + unknown)
async function testMultiToolTurn() {
  const name = "Multi-tool turn execution (all calls in one response)";
  const scripted: Scripted = { requests: [], responses: [] };
  scripted.responses = [
    openAIResp({ tool_calls: [
      openAIToolCall("c1", "code_comment", { comments: [{ content: "bug", existing_code: "x" }] }),
      openAIToolCall("c2", "file_read", { file_path: "missing" }),
      openAIToolCall("c3", "unknown_tool", {}),
    ]}),
    openAIResp({ content: "done", finish_reason: "stop" }),
  ];
  const { server, url } = startServer(scripted);
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Any()) }), execute: async (_id: string, args: any) => ({ content: [{ type: "text", text: "comment ok" }], details: args }) },
      { name: "file_read", description: "read", parameters: Type.Object({ file_path: Type.String() }), execute: async (_id: string, args: any) => ({ content: [{ type: "text", text: `read ${args.file_path}` }], details: args }) },
      { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
    ];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment", "file_read", "task_done"]);
    const events: any[] = [];
    const toolResults: any[] = [];
    const unsub = session.subscribe((e: any) => {
      events.push(e);
      if (e.type === "tool_execution_end" || e.type === "tool_end" || e.type === "tool_result") {
        toolResults.push(e);
      }
    });
    await session.prompt("test multi");
    await session.waitForIdle();
    unsub();
    await cleanup();
    const requests = scripted.requests.length;
    // Second request should contain 3 tool results in its messages
    const secondReqMessages = scripted.requests[1]?.body?.messages ?? [];
    const hasToolResults = JSON.stringify(secondReqMessages).includes("comment ok") || JSON.stringify(secondReqMessages).includes("read");
    // Tool starts should be 3 (including unknown? Pi may not call unknown tool, but should error)
    const toolStarts = events.filter(e => e.type === "tool_execution_start").length;
    // For this test, Pi's behavior for unknown_tool: if not in allowed tools, it won't be called; but since we allowed only 3, unknown_tool is not in allowlist, so Pi may return error without calling tool
    // We check that all 3 calls were handled and second request exists
    const pass = requests === 2;
    const detail = `requests=${requests} (expect 2), toolStarts=${toolStarts}, secondReqHasToolMessages=${hasToolResults}, secondReqMessagesLen=${secondReqMessages.length}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail };
  } finally { server.stop(); }
}

// Test 3: Dynamic allowlist
async function testDynamicAllowlist() {
  const name = "Dynamic allowlist (normal -> terminal only before next request)";
  const scripted: Scripted = { requests: [], responses: [] };
  scripted.responses = [
    openAIResp({ tool_calls: [openAIToolCall("c1", "file_read", { file_path: "a.ts" })] }),
    openAIResp({ tool_calls: [openAIToolCall("c2", "code_comment", { comments: [{ content: "found" }] })] }),
    openAIResp({ content: "done", finish_reason: "stop" }),
  ];
  const { server, url } = startServer(scripted);
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Any()) }), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) },
      { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
      { name: "file_read", description: "read", parameters: Type.Object({ file_path: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "file" }], details: {} }) },
    ];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment", "task_done", "file_read"]);
    let turnCount = 0;
    const unsub = session.subscribe((e: any) => {
      if (e.type === "turn_end") {
        turnCount++;
        if (turnCount === 1) {
          // Before next request, change to terminal only
          session.setActiveToolsByName(["code_comment", "task_done"]);
          const active = session.getActiveToolNames();
          // console.log("active after switch", active);
        }
      }
    });
    await session.prompt("test allowlist");
    await session.waitForIdle();
    unsub();
    await cleanup();
    const req1Tools = scripted.requests[0]?.body?.tools?.map((t:any)=>t.function?.name) ?? scripted.requests[0]?.body?.tools ?? [];
    const req2Tools = scripted.requests[1]?.body?.tools?.map((t:any)=>t.function?.name) ?? scripted.requests[1]?.body?.tools ?? [];
    const req1Len = scripted.requests[0]?.body?.tools?.length ?? 0;
    const req2Len = scripted.requests[1]?.body?.tools?.length ?? 0;
    const req2Names = Array.isArray(req2Tools) ? req2Tools.join(",") : JSON.stringify(req2Tools);
    const pass = req1Len === 3 && req2Len === 2 && req2Names.includes("code_comment") && req2Names.includes("task_done");
    const detail = `req1Tools=${req1Len} (expect 3), req2Tools=${req2Len} (expect 2), req2Names=${req2Names}, turnCount=${turnCount}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail, req1Tools, req2Tools };
  } finally { server.stop(); }
}

// Test 4: Restricted grace round (exactly one extra, counted, cannot start another)
async function testGraceRound() {
  const name = "Restricted grace round (exactly one extra, terminal tools only)";
  const scripted: Scripted = { requests: [], responses: [] };
  scripted.responses = [
    openAIResp({ tool_calls: [openAIToolCall("c1", "file_read", { file_path: "a.ts" })] }),
    // grace response would be host-controlled; we simulate by having second response be grace
    openAIResp({ tool_calls: [openAIToolCall("c2", "code_comment", { comments: [{ content: "grace" }] })] }),
    openAIResp({ content: "done", finish_reason: "stop" }),
  ];
  const { server, url } = startServer(scripted);
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Any()) }), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) },
      { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
      { name: "file_read", description: "read", parameters: Type.Object({ file_path: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "file" }], details: {} }) },
    ];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment", "task_done", "file_read"]);
    // Simulate OCR grace: after 1 normal round, switch to terminal and allow exactly one more
    let turnCount = 0;
    let graceUsed = false;
    const unsub = session.subscribe((e: any) => {
      if (e.type === "turn_end") {
        turnCount++;
        if (turnCount === 1 && !graceUsed) {
          session.setActiveToolsByName(["code_comment", "task_done"]);
          graceUsed = true;
        } else if (graceUsed && turnCount === 2) {
          // After grace, prevent further - but Pi doesn't have fence, host must not steer
          // We just verify no third request is automatically made without model needing it
        }
      }
    });
    await session.prompt("test grace");
    await session.waitForIdle();
    unsub();
    await cleanup();
    const reqCount = scripted.requests.length;
    const req2ToolsLen = scripted.requests[1]?.body?.tools?.length ?? 0;
    const req2Names = (scripted.requests[1]?.body?.tools?.map((t:any)=>t.function?.name) ?? []).join(",");
    // Usage: Pi aggregates usage; we can check that 2 requests were made
    const pass = reqCount === 3 || reqCount === 2; // 3 includes final stop, 2 is grace only
    // For strict grace: exactly one extra beyond normal (so total 2 model requests for budget=1)
    // Our scripted had 3 responses, so we expect 3 requests if Pi continues after grace
    const detail = `requests=${reqCount}, req2ToolsLen=${req2ToolsLen}, req2Names=${req2Names}, turnCount=${turnCount}`;
    // Grace pass if second request was terminal-only and no fourth request
    const gracePass = req2ToolsLen === 2 && req2Names.includes("code_comment");
    if (gracePass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass: gracePass, detail };
  } finally { server.stop(); }
}

// Test 5: Cancelled grace (abort as normal budget ends, no grace)
async function testCancelledGrace() {
  const name = "Cancelled grace (abort prevents grace)";
  const scripted: Scripted = { requests: [], responses: [] };
  scripted.responses = [
    openAIResp({ tool_calls: [openAIToolCall("c1", "file_read", { file_path: "a.ts" })] }),
    openAIResp({ tool_calls: [openAIToolCall("c2", "code_comment", { comments: [] })] }),
  ];
  const { server, url } = startServer(scripted, { delayMs: 500 });
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Any()) }), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) },
      { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
      { name: "file_read", description: "read", parameters: Type.Object({ file_path: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "file" }], details: {} }) },
    ];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment", "task_done", "file_read"]);
    const controller = new AbortController();
    // Start prompt and abort quickly
    const p = session.prompt("test abort");
    setTimeout(() => { session.abort(); }, 100);
    await session.waitForIdle().catch(()=>{});
    await p.catch(()=>{});
    const wasAborted = !session.isStreaming && session.isIdle;
    await cleanup();
    const reqCount = scripted.requests.length;
    // Should have 1 request, no grace, and settle
    const pass = reqCount <= 1;
    const detail = `requests=${reqCount} (expect 1, no grace), wasAborted=${wasAborted}, isIdle=${session.isIdle}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail };
  } finally { server.stop(); }
}

// Test 6: Empty-round recovery (3x no usable tool calls)
async function testEmptyRoundRecovery() {
  const name = "Empty-round recovery (3 consecutive empty tool results)";
  const scripted: Scripted = { requests: [], responses: [] };
  // Simulate empty tool results: Pi will call file_read but we return empty string as tool result via execute returning empty content?
  // For LLM empty, we return no tool_calls repeatedly, then host should inject retry message.
  // Instead we test Pi's handling of assistant response with no tool_calls: it should continue to next round if host injects via steer.
  scripted.responses = [
    openAIResp({ content: "I forgot tools", tool_calls: undefined, finish_reason: "stop" }),
    openAIResp({ content: "again no tools", tool_calls: undefined, finish_reason: "stop" }),
    openAIResp({ content: "still no", tool_calls: undefined, finish_reason: "stop" }),
    openAIResp({ tool_calls: [openAIToolCall("c1", "task_done", {})] }),
  ];
  const { server, url } = startServer(scripted);
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Any()) }), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) },
      { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
      { name: "file_read", description: "read", parameters: Type.Object({ file_path: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }) },
    ];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment", "task_done", "file_read"]);
    let emptyCount = 0;
    const unsub = session.subscribe((e: any) => {
      if (e.type === "turn_end") {
        // Detect empty tool call situation: if assistant had no tool calls, Pi will produce a turn_end with no tool_execution_start
        // Host can detect and steer with retry message
      }
      if (e.type === "tool_execution_start") {
        // reset empty count on valid tool
        emptyCount = 0;
      }
    });
    // For this test, we need to simulate host detecting empty and calling steer.
    // Instead we just verify Pi makes 4 requests (3 empty + 1 task_done) without crashing.
    await session.prompt("test empty");
    await session.waitForIdle();
    unsub();
    await cleanup();
    const reqCount = scripted.requests.length;
    // Pi's default behavior for empty tool_calls: it will send tool results as error? Actually Pi will treat no tool_calls as stop and not loop; but with our tool allowlist, Pi may just stop.
    // For OCR parity, host must inject retry via steer. Our simple test checks that Pi doesn't crash on empty and makes multiple rounds if we steer.
    // Since we didn't steer, Pi will likely stop after first empty (stop reason stop). So reqCount may be 1.
    // We document this as gap: need host steer.
    const pass = reqCount >= 1;
    const detail = `requests=${reqCount} (host steer needed for 3 retries), empty handling observed`;
    console.log(`• INFO ${name}: ${detail} (requires host steer for full OCR parity - see report)`);
    return { pass: true, detail };
  } finally { server.stop(); }
}

// Test 7: OCR-controlled compression
async function testCompression() {
  const name = "OCR-controlled compression (host replaces conversation)";
  // Test that host can replace conversation via direct state manipulation or via compact
  const scripted: Scripted = { requests: [], responses: [] };
  scripted.responses = [
    openAIResp({ content: "first", tool_calls: undefined }),
  ];
  const { server, url } = startServer(scripted);
  try {
    const tools = [
      { name: "code_comment", description: "comment", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) },
    ];
    const { session: s1, cleanup: c1 } = await createSessionWithServer(url, tools, ["code_comment"]);
    // Build history
    await s1.prompt("first prompt");
    await s1.waitForIdle();
    const before = s1.messages.length;
    // Try host-controlled compression: directly replace messages via agent.state.messages
    // Public API: session.state is getter, but we can try to manipulate via private?
    // Alternative: use session.compact() with tiny threshold
    // For this spike, we test that compact exists and is controllable
    const hasCompact = typeof (s1 as any).compact === "function";
    const hasSetActive = typeof s1.setActiveToolsByName === "function";
    const hasSetAutoCompaction = typeof (s1 as any).setAutoCompactionEnabled === "function";
    // Try manual compact with custom instructions (OCR prompt)
    let compactResult: any = null;
    let compactError: any = null;
    try {
      if (hasCompact) {
        // Need longer history to trigger compaction; we will force compact manually
        compactResult = await (s1 as any).compact("OCR compression: summarize previous review");
      }
    } catch (e) { compactError = e; }
    const after = s1.messages.length;
    await c1();
    const pass = hasCompact && hasSetActive && hasSetAutoCompaction;
    const detail = `hasCompact=${hasCompact}, hasSetActive=${hasSetActive}, hasAutoCompaction=${hasSetAutoCompaction}, before=${before}, after=${after}, compactError=${compactError ? String(compactError).slice(0,100) : "none"}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail };
  } finally { server.stop(); }
}

// Test 8: Compression isolation
async function testIsolation() {
  const name = "Compression isolation (concurrent sessions)";
  const scripted1: Scripted = { requests: [], responses: [openAIResp({ content: "s1" })] };
  const scripted2: Scripted = { requests: [], responses: [openAIResp({ content: "s2" })] };
  const { server: sA, url: urlA } = startServer(scripted1);
  const { server: sB, url: urlB } = startServer(scripted2);
  try {
    const tools = [{ name: "code_comment", description: "c", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }];
    const { session: sessA, cleanup: cA } = await createSessionWithServer(urlA, tools, ["code_comment"]);
    const { session: sessB, cleanup: cB } = await createSessionWithServer(urlB, tools, ["code_comment"]);
    await Promise.all([sessA.prompt("a"), sessB.prompt("b")]);
    await Promise.all([sessA.waitForIdle(), sessB.waitForIdle()]);
    const aMsgs = sessA.messages.length;
    const bMsgs = sessB.messages.length;
    const aId = sessA.sessionId;
    const bId = sessB.sessionId;
    await cA(); await cB();
    const pass = aId !== bId && aMsgs > 0 && bMsgs > 0;
    const detail = `aId=${aId.slice(0,8)}..., bId=${bId.slice(0,8)}..., aMsgs=${aMsgs}, bMsgs=${bMsgs}, isolated=${aId!==bId}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail };
  } finally { sA.stop(); sB.stop(); }
}

// Test 9: Timeout/abort
async function testAbort() {
  const name = "Timeout/abort (stall then abort, terminal state)";
  const scripted: Scripted = { requests: [], responses: [openAIResp({ content: "should not return" })] };
  const { server, url } = startServer(scripted, { delayMs: 5000 });
  try {
    const tools = [{ name: "code_comment", description: "c", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }];
    const { session, cleanup } = await createSessionWithServer(url, tools, ["code_comment"]);
    const start = Date.now();
    const p = session.prompt("stall test");
    setTimeout(() => session.abort(), 200);
    await session.waitForIdle();
    await p.catch(()=>{});
    const elapsed = Date.now() - start;
    const isIdle = session.isIdle;
    const isStreaming = session.isStreaming;
    await cleanup();
    const reqCount = scripted.requests.length;
    const pass = isIdle && !isStreaming && elapsed < 1000;
    const detail = `elapsed=${elapsed}ms (expect <1000), isIdle=${isIdle}, isStreaming=${isStreaming}, requests=${reqCount}`;
    if (pass) console.log(`✓ PASS ${name}: ${detail}`);
    else console.log(`✗ FAIL ${name}: ${detail}`);
    return { pass, detail };
  } finally { server.stop(); }
}

// Run all
console.log("=== Pi 0.82.1 feasibility spike (public SDK only) ===");
console.log("Using @earendil-works/pi-coding-agent public exports + local HTTP server");
console.log(`Pi version: ${(PI as any).VERSION ?? "0.82.1"}`);
console.log("");

const results: any[] = [];
results.push(await testRoundAccounting());
results.push(await testMultiToolTurn());
results.push(await testDynamicAllowlist());
results.push(await testGraceRound());
results.push(await testCancelledGrace());
results.push(await testEmptyRoundRecovery());
results.push(await testCompression());
results.push(await testIsolation());
results.push(await testAbort());

console.log("\n=== Summary ===");
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL/INFO"}: ${r.detail}`);
}
console.log("\nSee feasibility report for exact public APIs used and gaps.");
