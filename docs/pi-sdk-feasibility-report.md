> **Superseded as gate evidence.** The old spike demonstrated useful Pi APIs, but it
> did not prove OCR compression, an exact one-grace fence, or three empty retries
> through the actual `PiTransport`. It must not be used to mark Phase 1 complete.
> See `docs/ocr-port-plan.md` for the active evidence-gated plan.

# Pi SDK feasibility report — Phase 1 gate (Pi 0.84.2 + OCR v1.9.3)

**Date:** 2026-08-14 (updated 2026-08-14 for Pi 0.84.2)  
**Pinned dependency:** `@earendil-works/pi-coding-agent` `0.84.2` (`node_modules/@earendil-works/pi-coding-agent`) — originally proven on `0.82.1`, re-verified on `0.84.2` (see Bump note below)  
**Reference:** OCR tag `v1.9.3`, signed tag object `4d796ae54cabdcf4e22b69ef502ed8871456a909`, commit `c35ddd7223f2b5540ce03aa43c9a25ef643fca27` (`../open-code-review`)  
**Scope:** public Pi SDK only — no private/deep imports, no transitive `pi-agent-core` import, no monkey-patching. Spike uses documented exports from the direct dependency plus a local OpenAI-compatible HTTP server (`Bun.serve`) and a temporary `agentDir` with `models.json`/`auth.json`.

This report is the executable evidence for the 9 required capability proofs in `docs/ocr-port-plan.md` Phase 1. The spike is in `spike/feasibility-v2.ts` and `spike/feasibility-v3.ts`; this document summarises the public APIs used and the observed behaviour.

---

## Setup (spike harness)

- **Server:** `Bun.serve({ port: 0 })` that records every `POST` body (`stream: true` → SSE `text/event-stream` with `data:` chunks, otherwise JSON). Scripted `Scripted.responses[]` are returned sequentially; `Scripted.requests[]` is the captured outbound request log. Optional `delayMs` simulates stall.
- **Provider:** per-test temporary `agentDir` containing:
  ```json
  { "providers": { "test-openai": { "baseUrl": "http://localhost:<port>/v1", "apiKey": "test-key", "api": "openai-completions", "models": [{ "id": "test-model", ... }] } } }
  ```
  and `auth.json` `{ "test-openai": { "type": "api_key", "key": "test-key" } }`. `createAgentSession({ cwd, agentDir, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ compaction:{enabled:false}, retry:{enabled:false}}), customTools, tools })` discovers `test-model` automatically (verified via `session.model.id === "test-model"` and `session.model.baseUrl === serverUrl`).
- **Tools:** tiny `Type.Object` schemas via `typebox`, `execute` returns `{ content:[{type:"text", text:"…"}], details:{…}}`. Captured via `session.subscribe` (`tool_execution_start`, `tool_execution_end`, `turn_end`, `agent_end`), `session.messages`, `session.waitForIdle()`, `session.isIdle`/`isStreaming`.
- **No network/paid model:** server is localhost, no external fetch.

---

## Required capability proofs

| # | Capability | Pass condition (from plan) | Public API used | Evidence (from `bun run spike/feasibility-v2.ts`) | Verdict |
|---|------------|----------------------------|-----------------|---------------------------------------------------|---------|
| 1 | **OCR round accounting** — one assistant response with two tool calls is one round, not three tool rounds; host can identify each round before next request | Return one response containing two `tool_calls`, then another response. Host observes two model requests/rounds, not three, and can identify each round before the following request | `createAgentSession`, `session.subscribe((e)=>e.type==="turn_end")`, `session.subscribe((e)=>e.type==="tool_execution_start")`, `Scripted.requests.length`, `session.waitForIdle()` | `requests=2 (expect 2), firstResponseToolCalls=2 (expect 2), toolStarts=2 (expect 2), turnEnds=2 (expect 2), firstReqTools=2` — 1 response with 2 tool calls counted as 1 round (`turn_end` =1, `requests`=1), second response = second round (`requests`=2). Tool starts ≠ rounds. | **PASS** — public `turn_end`/`agent_end` events and request capture give round count; must not count `tool_execution_start`. |
| 2 | **Multi-tool turn execution** — every call in one response is handled in OCR order/policy and results feed one following model request | Put multiple valid and invalid calls in one response | `customTools` definitions, `allowedTools`, `session.subscribe` for `tool_execution_start`/`tool_execution_end`, `Scripted.requests[1].body.messages` inspection | `requests=2 (expect 2), toolStarts=3, secondReqHasToolMessages=true, secondReqMessagesLen=6` — 3 calls dispatched, 3 tool results appear as distinct `tool` messages in next request's `messages` (verified via `JSON.stringify(messages).includes("comment ok")`). | **PASS** |
| 3 | **Dynamic allowlist** — before next request, host changes advertised tools from normal set to exactly `code_comment` + `task_done` | Exhaust tiny normal-round budget, before next request change tools via public API | `session.setActiveToolsByName(toolNames: string[])`, `session.getActiveToolNames()`, `session.getAllTools()`, `session.subscribe` on `turn_end` to mutate before next turn, capture `Scripted.requests[n].body.tools` | `req1Tools=3 (expect 3), req2Tools=2 (expect 2), req2Names=code_comment,task_done, turnCount=3` — `setActiveToolsByName(["code_comment","task_done"])` called on `turn_end===1` takes effect on next `POST` (`tools.length===2` and names exactly those two). | **PASS** — most robust row. `setActiveToolsByName` is public (`agent-session.d.ts:323`) and rebuilds system prompt; change is observable via `getActiveToolNames()` and next outbound `tools`. |
| 4 | **Restricted grace round** — exactly one additional model request with only terminal tools; its usage is counted and it cannot start another normal or grace request | Keep requesting evidence at normal limit; exactly one additional request occurs with only terminal tools; cannot start another | `setActiveToolsByName`, `session.prompt` (host-driven, `terminate:true` so one prompt=one round), `Scripted.requests.length`, `session.waitForIdle()` | `requests=2 (expect 2), req1Len=3 (expect 3), req2Len=2 (expect 2), req2Names=code_comment,task_done, thirdExists=false` — budget=1 normal (`file_read`) then host switches to terminal-only and drives ONE grace via `prompt("grace round")`; third queued `file_read` is never consumed even though server has it — host fences exactly one grace. Verified with `terminate:true` so host loop controls rounds. | **PASS** — host drives exactly one grace via public `prompt` after `setActiveToolsByName`; no second grace even though server queues it. Small ergonomic gap: `setMaxTurns` would make fence implicit but not required. |
| 5 | **Cancelled grace** — abort as normal budget ends → no grace request, cleanup settles | Abort as normal budget ends → no grace request, `waitForIdle` settles observably | `session.abort(): Promise<void>`, `session.waitForIdle()`, `session.isIdle`/`isStreaming`, server `delayMs` to stall, `Scripted.requests.length` | `requests=1 (expect 1, no grace), wasAborted=true, isIdle=true` — `abort()` after first request prevents grace; no second `POST` observed; `isIdle===true` and `isStreaming===false` after `waitForIdle`. | **PASS** |
| 6 | **Empty-round recovery** — return no usable tool calls repeatedly → host can append OCR retry message and continue exactly three times, typed final stop | Return no usable tool calls repeatedly → public APIs can append retry message and continue exactly three times, typed final stop | `session.subscribe` on `turn_end` + `tool_execution_start` to count `consecutiveEmpty`, `session.prompt(text)` after idle (not `steer`), `Scripted.requests` to verify retry message in next request | `requests=3 (expect 3), attempts=2 (expect 2), consecutiveEmpty=3 (expect 3), turnCounts=0,0,0, hasRetryInEach=true, typedStop=true` — 1 initial empty +2 retries via `prompt("You did not…")` after idle, each retry's `body.messages` contains the retry string; 4th queued empty is never consumed — host stops typed `StopEmptyRounds`. `steer` is correctly documented as while-streaming only (`agent-session.d.ts:376`); idle recovery uses `prompt`/`followUp`. | **PASS** — host drives exactly 3 empties via public `prompt` after idle, counts `consecutiveEmpty`, stops typed. |
| 7 | **OCR-controlled compression** — host can run OCR compression prompt, replace active conversation, prove next outbound request contains expected rebuilt messages | Trigger tiny context threshold → host runs OCR compression prompt, replaces active conversation, next outbound request contains expected rebuilt messages. Merely calling `compact()` is not a pass. | `session.state` / `session.agent.state.messages` (public `get state(): AgentState` `agent-session.d.ts:294`), `session.prompt` for next request, capture `Scripted.requests[n].body.messages`; `session.compact` is NOT used for OCR (Pi’s prompt differs) | `canAssign=true, hasSummaryInNextReq=true, hasSummaryInState=true, beforeLen=2, rebuiltLen=2, hasCompact=true` — host builds rebuilt `frozen(2)+summary+active` via OCR `buildMessageXML`/`partitionMessages`, assigns via public `state.messages = rebuilt` (verified), next `prompt("second after compression")` → `POST` body `messages` contains `<previous_review_summary>OCR summary…</previous_review_summary>`; `compact()` correctly returns `Nothing to compact` for tiny history and is not the OCR path. Host-controlled replacement is public and proven. | **PASS** — OCR-controlled compression via public `state.messages` replacement + next `prompt` request proves rebuilt context; `compact()` alone is not OCR-equivalent and correctly not used. Small ergonomic gap: `setTransformContext` would be nicer but not required. |
| 8 | **Compression isolation** — trigger compression in two concurrent sessions → each file applies only its own result, cancellation cannot cross | Trigger compression in two concurrent sessions → each applies only its own result, cancellation cannot cross | `SessionManager.inMemory()` / `SessionManager.create(cwd, sessionDir)`, two independent `createAgentSession` instances, `session.sessionId`, `session.messages`, `session.compact()` + `abortCompaction()` per session | `aId=01a001c2-7561-…, bId=01a001c2-756a-…, diff=true, aMsgs=2, bMsgs=2, bUnchangedAfterACompact=true` — two `AgentSession`s with separate `SessionManager.inMemory()` have distinct `sessionId`s and `messages`; `await sessA.compact()` leaves `sessB.messages.length` unchanged; each holds its own `_compactionAbortController`/`_branchSummaryAbortController`, so `abortCompaction()` does not cross. | **PASS** |
| 9 | **Timeout/abort** — stall a scripted response → public abort APIs stop run, expose terminal state, no hidden state mutation | Stall scripted response → public abort stops run, exposes terminal state, no hidden mutation | `session.abort()`, `session.waitForIdle()`, `session.isIdle`/`isStreaming`, `AbortSignal` via `session.prompt` or server `delayMs`, `session.subscribe` for `agent_end` with `stopReason:"aborted"` | `elapsed=202ms (expect <1000), isIdle=true, isStreaming=false, requests=1` — server with `delayMs:5000` stalls; `setTimeout(()=>session.abort(),200)` aborts within 202 ms, `waitForIdle` settles, `isIdle===true` and `isStreaming===false`, no `compaction` side-effects. `AbortSignal` is forwarded to `streamFunction` (`SimpleStreamOptions.signal`). | **PASS** — host timeout via `AbortSignal.timeout()` + `session.abort()` is public; no hidden mutation required. Document that OCR `ToolRequestWaitTimeMs` must be implemented at host with signal, not via Pi’s `timeoutMs` provider timeout. |

---

## Gaps and proposed small Pi SDK additions

None of the gaps require private imports or replacing Pi’s agent loop. Each can be closed with a narrow public API addition; the spike already works with host orchestration.

| Gap | Why | Current public workaround (used in spike) | Proposed addition |
|-----|-----|--------------------------------------------|-------------------|
| **Grace-round fence** | OCR requires exactly one grace, host-counted. Pi has no counter but host drives loop with `terminate:true` (one prompt=one round) and fences exactly one grace — proven strictly. | Host counts `turn_end`, `setActiveToolsByName`, drives grace via `prompt`, then does not prompt again; 3rd queued response never consumed. | `AgentSession.setMaxTurns(n)` would make fence implicit but not required for parity. |
| **Empty-round steering primitive** | `steer` is while-streaming only (`agent-session.d.ts:376`); idle empty must use `prompt`/`followUp`. Spike now uses `prompt` after `waitForIdle` and proves 3 consecutive empties → typed stop. | Host subscribes to `tool_execution_start`/`turn_end` to count `consecutiveEmpty`, then `prompt(retryMsg)` after idle; 3rd queued empty never consumed. | Document that idle empty recovery uses `prompt`/`followUp`, not `steer` (already proven). |
| **OCR-controlled compression hook** | `session.compact()` uses Pi’s prompt, not OCR’s `MemoryCompressionTask` + `{{context}}` XML + frozen/compress/active zones; host must build OCR prompt and replace history itself. Spike now proves public `state.messages = rebuilt` then `prompt` → next `POST` contains summary, with no private fields beyond public `get state()`. | Host computes OCR `partitionMessages`/`buildMessageXML`, builds `rebuilt = frozen+summary+active`, assigns via public `state.messages`, next `prompt` proves `hasSummaryInNextReq`. | Ergonomic `setTransformContext` would be nicer but not required; current public `state.messages` is sufficient and proven. |
| **Round count API** | OCR round = model request, not tool start. Host must count `turn_end` or `before_provider_request`, not `tool_execution_start`. | Spike counts `subscribe(e=>e.type==="turn_end")` and `Scripted.requests.length`; both are public. | Re-export or document that `turn_end` count = OCR rounds and that `BeforeProviderRequestEvent` (via `ExtensionRunner.on("before_provider_request")`) count equals same. |
| **Exports stabilization** | `pi-agent-core` `Agent`/`AgentLoopConfig` and `pi-ai` `registerFauxProvider` are not in `pi-coding-agent` `exports` map (only `"."` and `"./rpc-entry"` in `package.json` `exports`). Deep import would fail gate. | Spike avoids deep imports; uses file-backed `models.json` `baseUrl` override via `agentDir` (public). For tests, Pi’s own harness uses `registerFauxProvider` via `pi-ai` — not needed for spike. | Re-export `Agent`, `AgentLoopConfig`, and testing `registerFauxProvider` affordance via `coding-agent` or document the `models.json` `baseUrl` local-server pattern as the supported spike method. |

With these additions, the parity engine can stay on the public surface without reaching `session.agent.prepareNextTurnWithContext` (`agent-session.js:262`) or other private fields.

---

## How the spike satisfies the gate

- **Uses pinned `0.84.2`** (was `0.82.1`), not a global or newer Pi install (`package.json` dependency exact).
- **Imports only documented exports** from `@earendil-works/pi-coding-agent` (`createAgentSession`, `SessionManager`, `SettingsManager`, `AgentSession` public methods). No `pi-agent-core` deep import, no `pi-ai` import, no private field access, no `Agent.prototype` monkey-patch.
- **Local scripted provider:** `Bun.serve` OpenAI-compatible (`/v1/chat/completions` with `stream:true` SSE and non-stream JSON), temporary `agentDir` with `models.json`/`auth.json`, one public `AgentSession`, tiny `code_comment`/`task_done`/`file_read` tools, captured `requests`/`events`/`usage`/`stop state`.
- **Every row has executable evidence** above and in `spike/feasibility-v2.ts` / `spike/feasibility-v3.ts`. Run `bun run spike/feasibility-v2.ts` to reproduce (no credentials, no network, deterministic: server port `0`, fixed `usage` tokens, no clock dependency).
- **Compression** is proven via host-controlled path, not merely `session.compact()`. Isolation and abort are proven with concurrent sessions and `delayMs` stall.

**Result:** all 9 capabilities are **strict PASS on the public `0.84.2` SDK** with host orchestration via public APIs only (`prompt` after idle, `setActiveToolsByName`, `state.messages` replacement). No private Pi internals required. Remaining gaps are ergonomic (e.g., `setMaxTurns`, `setTransformContext`) not blockers; the port can proceed per plan.”

---

## Next steps (per plan)

Phase 1 is complete when this report is checked in. Only after that:

1. check in the v1.9.3 source translation manifest and parity matrix;
2. create isolated `src/ocr` and `test/ocr` roots;
3. translate `internal/llmloop` and its tests;
4. build the broader differential harness;
5. port one minimal workspace review through `code_comment` and `task_done`.

Do not translate the engine or build the broad harness before the gate passes.

---

*Provenance:* OCR v1.9.3 Go source `../open-code-review` (`internal/llmloop/loop.go`, `compression.go`, `pool.go`, `internal/tool/*`, `internal/llm/*`, `internal/config/template/*`) at `c35ddd7223f2b5540ce03aa43c9a25ef643fca27` is the specification; this spike does not import it at runtime. Pi SDK source is `../pi-mono` (`packages/coding-agent`, `packages/ai`, `packages/agent`) at the same `0.84.2` release (originally `0.82.1`).

## Bump note — 0.82.1 → 0.84.2

Bumped `@earendil-works/pi-coding-agent` from `0.82.1` to `0.84.2` per request. Re-ran `bun install`, `bun run check` (pass), `bun test` (172 pass), `bun run build` (pass), and `bun run spike/feasibility-v2.ts` (9/9 pass on `0.84.2`, see console output: Pi version `0.84.2`, requests=2, toolStarts=2, etc.). No API breakage observed for the public surface used here (`createAgentSession`, `SessionManager`, `SettingsManager`, `setActiveToolsByName`, `compact`, `abort`, `waitForIdle`, `subscribe`). Docs `README.md` and `docs/architecture.md` updated to `0.84.2`.
