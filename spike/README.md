# Pi 0.84.2 feasibility spike (Phase 1) — originally 0.82.1

This directory contains the executable Phase 1 gate spike described in
`docs/ocr-v1.9.3-port-plan.md`.

## What it proves

All 9 required capabilities are exercised against a local scripted
OpenAI-compatible HTTP server (Bun.serve) and one public `AgentSession`
from `@earendil-works/pi-coding-agent@0.84.2` (originally `0.82.1`, bumped per request; re-verified on `0.84.2`).

No private/deep Pi imports, no `pi-agent-core` direct import, no monkey-patching.
Only documented exports from the direct dependency:

- `createAgentSession`
- `SessionManager` (`inMemory`, `create`)
- `SettingsManager` (`inMemory`)
- `AgentSession` methods: `prompt`, `subscribe`, `setActiveToolsByName`,
  `getActiveToolNames`, `getAllTools`, `compact`, `setAutoCompactionEnabled`,
  `abort`, `waitForIdle`, `dispose`, `steer`, `followUp`, `sendCustomMessage`,
  properties `model`, `messages`, `isStreaming`, `isIdle`, `sessionId`, `sessionFile`

Provider discovery uses a temporary `agentDir` with `models.json` + `auth.json`
pointing `baseUrl` to the scripted server. This is the public `ModelRuntime`
path (file-backed provider config), not a faux in-memory provider.

## Run

```bash
bun run spike/feasibility-v2.ts   # main spike, 9 rows
bun run spike/feasibility-v3.ts   # detailed empty-round + compression checks
```

## Evidence

See `docs/pi-sdk-feasibility-report.md` for the pass/fail table, captured
requests, session events, usage, and exact public APIs.
