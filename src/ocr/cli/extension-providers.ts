// User-level pi extension provider harvesting for model selection.
//
// pi-reviewer resolves `--model` selectors and its no-flag fallback model
// through Pi's public ModelRuntime. Built-in SDK providers cover most cases,
// but user-level pi extensions can register additional providers (proxies,
// aggregators). To keep such selectors resolvable, this module executes ONLY
// user-scope extension code discovered under the agent directory, in a neutral
// working directory (the agent dir itself — never the reviewed repository),
// and harvests just the pending provider registrations. Every other extension
// contribution — tools, commands, event handlers, prompts, skills, themes —
// is discarded here and never reaches a review session; the review session's
// resource loader stays extension-free.
//
// Failure semantics are warn-and-continue: a broken extension costs its own
// provider only; a total harvest failure degrades to built-in providers with
// a warning. Warnings carry paths and short reasons, never configuration
// contents (provider configs may contain auth wiring).

import {
  DefaultPackageManager,
  discoverAndLoadExtensions,
  SettingsManager,
  type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";

/** A classic provider-config registration queued by an extension factory. */
export type ExtensionProviderRegistration = ExtensionRuntime["pendingProviderRegistrations"][number];

/** A native pi-ai provider registration queued by an extension factory. */
export type ExtensionNativeProviderRegistration = ExtensionRuntime["pendingNativeProviderRegistrations"][number];

export interface ExtensionProviderHarvest {
  readonly registrations: readonly ExtensionProviderRegistration[];
  readonly nativeRegistrations: readonly ExtensionNativeProviderRegistration[];
}

const MAX_WARNING_DETAIL = 160;

/** First-line, bounded error detail — never a full config or stack dump. */
export function shortErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine.length > MAX_WARNING_DETAIL ? `${firstLine.slice(0, MAX_WARNING_DETAIL)}…` : firstLine;
}

export const EMPTY_EXTENSION_HARVEST: ExtensionProviderHarvest = {
  registrations: [],
  nativeRegistrations: [],
};

/**
 * Execute user-scope pi extensions from `agentDir` and collect their pending
 * provider registrations. Never throws: total failures are reported via
 * `onWarning` and yield an empty harvest (built-in providers only).
 */
export async function harvestExtensionProviders(
  agentDir: string,
  onWarning?: (message: string) => void,
): Promise<ExtensionProviderHarvest> {
  try {
    // Neutral working directory: discovery is agent-dir-relative only, so the
    // reviewed repository (whatever the process cwd is) is never scanned or
    // executed. `discoverAndLoadExtensions` auto-discovers `<cwd>/.pi/extensions`
    // and `<agentDir>/extensions` in addition to the configured paths below.
    const neutralCwd = agentDir;
    const settingsManager = SettingsManager.create(neutralCwd, agentDir);
    const packageManager = new DefaultPackageManager({ cwd: neutralCwd, agentDir, settingsManager });
    // onMissing=skip performs no installs and no network access; npm version
    // matching reads the installed package.json only, and git sources are
    // refreshed only for temporary-scope unpinned sources (never user scope).
    const resolved = await packageManager.resolve(async () => "skip");
    // Belt and braces: the neutral cwd already excludes project-scope
    // discovery, but filter the resolved resources to user scope regardless —
    // a settings file must never smuggle project-scope code into execution.
    const userPaths = resolved.extensions
      .filter((resource) => resource.enabled && resource.metadata.scope === "user")
      .map((resource) => resource.path);

    const loaded = await discoverAndLoadExtensions(userPaths, neutralCwd, agentDir);
    for (const loadError of loaded.errors) {
      onWarning?.(
        `pi extension provider harvest: failed to load extension at ${loadError.path}: ${shortErrorReason(loadError.error)}`,
      );
    }
    return {
      registrations: [...loaded.runtime.pendingProviderRegistrations],
      nativeRegistrations: [...loaded.runtime.pendingNativeProviderRegistrations],
    };
  } catch (error) {
    // Total harvest failure: today's built-in-provider behavior plus a warning.
    onWarning?.(
      `pi extension provider harvest failed; continuing with built-in providers: ${shortErrorReason(error)}`,
    );
    return EMPTY_EXTENSION_HARVEST;
  }
}
