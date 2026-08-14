// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/definitions.go, internal/tool/response_message.go,
// and internal/tool/stub.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { NotAvailableMsg, Tool, type Tool as ToolType } from "./types.js";

export { NotAvailableMsg, ToolNotFoundMsg, ErrToolNotFound, CommentSucceed } from "./types.js";
export type { Tool } from "./types.js";

// ---------------------------------------------------------------------------
// Provider — mirrors Go `type Provider interface { Tool() Tool; Execute(...) }`
// ---------------------------------------------------------------------------

export interface Provider {
  Tool(): ToolType;
  Execute(ctx: unknown, args: Record<string, unknown>): Promise<string> | string;
  // Allow calling with just args for TS convenience — mirrors Execute with context.Background.
  execute?(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> | string;
}

// Alias for llmloop compatibility: ToolProvider shape
export interface ToolProvider {
  readonly name: string;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> | string;
}

// ---------------------------------------------------------------------------
// Registry — mirrors Go `type Registry struct { providers map[string]Provider; frozen bool }`
// ---------------------------------------------------------------------------

export class Registry {
  private readonly providers = new Map<string, Provider>();
  private frozen = false;

  /** Register adds a tool provider. Panics (throws) if the registry is frozen — mirrors Go. */
  Register(p: Provider): void {
    if (this.frozen) {
      throw new Error("tool: Register called on frozen registry");
    }
    this.providers.set(p.Tool().Name(), p);
  }

  /** Get returns the provider registered under name — mirrors Go `Get`. */
  Get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** Lowercase alias for TS callers. */
  get(name: string): Provider | undefined {
    return this.Get(name);
  }

  /** Freeze prevents further mutations — mirrors Go `Freeze`. */
  Freeze(): void {
    this.frozen = true;
  }

  /** Alias for `Freeze`. */
  freeze(): void {
    this.Freeze();
  }

  /** Returns whether registry is frozen. */
  isFrozen(): boolean {
    return this.frozen;
  }
}

/** Factory — mirrors Go `NewRegistry()`. */
export function NewRegistry(): Registry {
  return new Registry();
}
export const newRegistry = NewRegistry;

// ---------------------------------------------------------------------------
// ToolCallResult / TaskCheckpoint — mirrors internal/tool/response_message.go
// ---------------------------------------------------------------------------

/** Mirrors Go `type ToolCallResult struct { ToolCallID, Name, Result }`. */
export interface ToolCallResult {
  /** OpenAI-compatible tool call ID — mirrors Go `ToolCallID`. */
  ToolCallID: string;
  /** Alias for camelCase consumers. */
  toolCallId?: string;
  /** Tool name (alias) — mirrors Go `Name`. */
  Name: string;
  /** Alias. */
  name?: string;
  /** Output from the tool — mirrors Go `Result`. */
  Result: string;
  /** Alias. */
  result?: string;
}

/** Mirrors Go `type TaskCheckpoint struct { Data string; Completed, Failed bool }`. */
export interface TaskCheckpoint {
  Data: string;
  Completed: boolean;
  Failed: boolean;
  /** Alias for camelCase. */
  data?: string;
  completed?: boolean;
  failed?: boolean;
}

/** Mirrors Go `Complete() TaskCheckpoint`. */
export function Complete(): TaskCheckpoint {
  return { Data: "", Completed: true, Failed: false };
}

/** Mirrors Go `Fail(data string) TaskCheckpoint`. */
export function Fail(data: string): TaskCheckpoint {
  return { Data: data, Completed: false, Failed: true };
}

/** Mirrors Go `Of(data string) TaskCheckpoint`. */
export function Of(data: string): TaskCheckpoint {
  return { Data: data, Completed: false, Failed: false };
}

/** Lowercase aliases. */
export const complete = Complete;
export const fail = Fail;
export const of = Of;

// ---------------------------------------------------------------------------
// Stub / Builtin providers — mirrors internal/tool/stub.go
// ---------------------------------------------------------------------------

/** Mirrors Go `type StubProvider struct { tool Tool }`. */
export class StubProvider implements Provider {
  constructor(private readonly tool: ToolType) {}

  Tool(): ToolType {
    return this.tool;
  }

  async Execute(_ctx: unknown, _args: Record<string, unknown>): Promise<string> {
    return NotAvailableMsg;
  }
}

/** Mirrors Go `NewStub(t Tool) *StubProvider`. */
export function NewStub(t: ToolType): StubProvider {
  return new StubProvider(t);
}
export const newStub = NewStub;

/** Mirrors Go `type BuiltinToolProvider struct { tool Tool; fn func(...) }`. */
export class BuiltinToolProvider implements Provider {
  constructor(
    private readonly tool: ToolType,
    private readonly fn: (ctx: unknown, args: Record<string, unknown>) => Promise<string> | string,
  ) {}

  Tool(): ToolType {
    return this.tool;
  }

  async Execute(ctx: unknown, args: Record<string, unknown>): Promise<string> {
    return this.fn(ctx, args);
  }
}

/** Mirrors Go `NewBuiltin(t Tool, fn ...) *BuiltinToolProvider`. */
export function NewBuiltin(
  t: ToolType,
  fn: (ctx: unknown, args: Record<string, unknown>) => Promise<string> | string,
): BuiltinToolProvider {
  return new BuiltinToolProvider(t, fn);
}
export const newBuiltin = NewBuiltin;
