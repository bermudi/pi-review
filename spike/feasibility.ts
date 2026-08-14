#!/usr/bin/env bun
// @ts-nocheck
// Spike: Pi 0.82.1 public SDK feasibility gate (Phase 1)
// Uses only documented exports from @earendil-works/pi-coding-agent + a local HTTP server.
// Proves OCR round accounting, dynamic allowlist, grace, empty-round, compression, isolation, abort.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const PI = await import("@earendil-works/pi-coding-agent");
const { createAgentSession, SessionManager, SettingsManager } = PI as any;

// ---------- helpers ----------
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function logPass(name: string, detail: string) {
  console.log(`✓ PASS ${name}: ${detail}`);
}
function logFail(name: string, detail: string) {
  console.log(`✗ FAIL ${name}: ${detail}`);
}
async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-spike-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(()=>{}); }
}

// ---------- local OpenAI-compatible server ----------
type Scripted = { responses: any[], requests: any[] };
function startServer(scripted: Scripted, opts: { delayMs?: number } = {}) {
  let idx = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      let body: any;
      try { body = await req.json(); } catch { body = {}; }
      scripted.requests.push({ url: url.pathname + url.search, body, headers: Object.fromEntries(req.headers.entries()) });
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      const resp = scripted.responses[idx++] ?? scripted.responses[scripted.responses.length - 1];
      if (!resp) return new Response(JSON.stringify({ error: "no scripted response" }), { status: 500, headers: { "content-type": "application/json" } });
      // Support both streaming and non-streaming: if client sent stream:true, return SSE
      const wantsStream = body.stream === true;
      if (wantsStream) {
        const id = resp.id ?? "chatcmpl-test";
        const created = Math.floor(Date.now()/1000);
        const model = resp.model ?? body.model ?? "test-model";
        // Build SSE chunks: one for content/tool_calls, one for finish + usage
        const choices = resp.choices ?? [];
        // For simplicity, emit one chunk with delta containing the first choice's message
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
  return { server, port: server.port, url: `http://localhost:${server.port}/v1` };
}

function openAIToolCall(id: string, name: string, args: any) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function openAIResp({ content, tool_calls, finish_reason }: { content?: string, tool_calls?: any[], finish_reason?: string }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Math.floor(Date.now()/1000),
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: content ?? null, tool_calls: tool_calls ?? undefined }, finish_reason: finish_reason ?? (tool_calls ? "tool_calls" : "stop") }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ---------- test harness ----------
type ToolDef = { name: string, description: string, parameters: any, execute: any };

async function runOne(providerUrl: string, prompt: string, tools: ToolDef[], opts: { allowedTools?: string[], sessionId?: string, signal?: AbortSignal } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-spike-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spike-agent-"));
  // write auth.json and models.json to make ModelRuntime find provider
  const modelsPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");
  // Pi's ModelRuntime expects models.json with providers field; we use file provider registration via AgentSession's ModelRegistry instead of file,
  // but to keep spike simple we will use pi-coding-agent's public extension provider registration via createAgentSession's resourceLoader.
  // Instead we just create minimal files and rely on manual provider registration via extension.
  await writeFile(authPath, JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }));
  // provider config for test-openai
  const modelsJson = {
    providers: {
      "test-openai": {
        baseUrl: `${providerUrl}`,
        apiKey: "test-key",
        api: "openai-completions",
        models: [
          { id: "test-model", name: "Test Model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
        ]
      }
    }
  };
  await writeFile(modelsPath, JSON.stringify(modelsJson));
  // Also need a write for discovery: AgentSession will use DefaultResourceLoader which reads agentDir for models.json
  try {
    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } } as any);
    // Need to create a resourceLoader that registers our provider tools and provider override
    // Use extension to register provider baseUrl override - simplest is to rely on models.json file being read via ModelRuntime inside createAgentSession
    // But createAgentSession's ModelRuntime creation uses agentDir, so it should pick up our file.
    const { createAgentSession: realCreate } = PI as any;
    // extra: provide customTools directly
    const customTools = tools.map(t => ({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      execute: t.execute,
    }));
    // Try to get createAgentSession to use our agentDir
    const { session } = await realCreate({
      cwd,
      agentDir,
      model: undefined, // let it pick first available (our test-model)
      customTools,
      tools: opts.allowedTools ?? tools.map(t=>t.name),
      sessionManager,
      settingsManager,
    });
    const events: any[] = [];
    const unsub = session.subscribe((e: any) => events.push(e));
    // Attempt to set model explicitly to test-openai/test-model if not auto-selected
    // Use session.model? Need to set via setModel if needed
    // If no model selected, try to find available
    // For debugging, list
    // console.log("model before", session.model);
    // If session.model is undefined, try to set
    if (!session.model) {
      // try to find via session.modelRuntime?
      const runtime = (session as any).modelRuntime ?? (session as any)._modelRuntime;
      // fallback: try to list via pi's model registry?
    }
    await session.prompt(prompt);
    await session.waitForIdle();
    unsub();
    const messages = session.messages;
    const toolResults: any[] = [];
    // Collect tool results from messages?
    // AgentSession doesn't expose toolResults directly, but we can infer from events
    const out = { session, messages, events, sessionFile: session.sessionFile, model: session.model };
    // Need to dispose but keep data
    session.dispose();
    await rm(cwd, { recursive: true, force: true }).catch(()=>{});
    await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
    return out;
  } catch (e) {
    await rm(cwd, { recursive: true, force: true }).catch(()=>{});
    await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
    throw e;
  }
}

// Quick sanity: try to createAgentSession without server to see if provider discovery works
async function sanity() {
  console.log("=== sanity check: provider discovery ===");
  const cwd = await mkdtemp(join(tmpdir(), "pi-spike-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spike-agent-"));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "test-openai": {
        baseUrl: "http://localhost:12345/v1",
        apiKey: "test-key",
        api: "openai-completions",
        models: [{ id: "test-model", name: "Test Model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }]
      }
    }
  }));
  try {
    const { createAgentSession: c } = PI as any;
    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory({} as any);
    const { session } = await c({
      cwd,
      agentDir,
      // explicitly request our model
      model: undefined,
      sessionManager,
      settingsManager,
      customTools: [{ name: "code_comment", label: "code_comment", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }],
      tools: ["code_comment"],
    });
    console.log("session.model", session.model);
    console.log("getAllTools", session.getAllTools().map((t:any)=>t.name));
    console.log("getActive", session.getActiveToolNames());
    session.dispose();
  } catch (e) {
    console.error("sanity failed", e);
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(()=>{});
    await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
  }
}

await sanity();

// Now try full server test
console.log("\n=== starting scripted server ===");
const scripted: Scripted = { requests: [], responses: [] };
scripted.responses = [
  openAIResp({ tool_calls: [openAIToolCall("call1", "code_comment", { comments: [{ content: "hi", existing_code: "x" }] }), openAIToolCall("call2", "code_comment", { comments: [{ content: "hi2", existing_code: "y" }] })] }),
  openAIResp({ content: "done", finish_reason: "stop" }),
];
const { server, port, url } = startServer(scripted);
console.log(`server at ${url} port ${port}`);

try {
  const tools: ToolDef[] = [
    { name: "code_comment", description: "comment", parameters: Type.Object({ comments: Type.Array(Type.Object({ content: Type.String() })) }), execute: async (_id: string, args: any) => ({ content: [{ type: "text", text: "ok" }], details: args }) },
    { name: "task_done", description: "done", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) },
    { name: "file_read", description: "read", parameters: Type.Object({ file_path: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "file" }], details: {} }) },
  ];
  console.log("running session with multi-tool response...");
  const cwd = await mkdtemp(join(tmpdir(), "pi-spike-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spike-agent-"));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "test-openai": {
        baseUrl: url,
        apiKey: "test-key",
        api: "openai-completions",
        models: [{ id: "test-model", name: "Test Model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }]
      }
    }
  }));
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } } as any);
  const { createAgentSession: c } = PI as any;
  // Need to specify model explicitly: "test-openai/test-model"
  const modelStr = "test-openai/test-model";
  console.log(`attempting createAgentSession with model ${modelStr} agentDir ${agentDir}`);
  try {
    const { session } = await c({
      cwd,
      agentDir,
      model: (await import("@earendil-works/pi-ai/compat")).getModel ? undefined : undefined, // placeholder
      // Try to use string model spec via internal resolve? createAgentSession expects Model object, not string.
      // Let's try to pass model object directly via getModel
    });
    console.log("??");
    session.dispose();
  } catch (e) {
    console.error("create without model failed", e);
  }
  // Try alternative: use PI's ModelRuntime directly to get model object
  try {
    const { ModelRuntime } = PI as any;
    const rt = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    // Give time to load
    await new Promise(r=>setTimeout(r, 200));
    // Access models
    const all = (rt as any).getAll ? (rt as any).getAll() : (rt as any).models?.getAll?.() ?? [];
    console.log("runtime getAll", all);
    await rm(cwd, { recursive: true, force: true }).catch(()=>{});
    await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
  } catch (e) {
    console.error("ModelRuntime create failed", e);
    await rm(cwd, { recursive: true, force: true }).catch(()=>{});
    await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
  }
} finally {
  server.stop();
  console.log("server stopped, requests", scripted.requests.length);
}

console.log("spike done");
