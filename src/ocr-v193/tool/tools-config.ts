// SPDX-License-Identifier: Apache-2.0
// Ported from internal/config/toolsconfig/tools.json and toolsconfig.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Tool definitions are verbatim from the pinned OCR checkout.
// Modifications distributed under GPL-3.0-or-later.

import * as fs from "node:fs";
import type { ToolDef } from "../llmloop/types.js";

/**
 * Verbatim tool definitions from ../open-code-review/internal/config/toolsconfig/tools.json
 * at v1.9.3. These are the exact definitions OCR advertises to the model for
 * main_task (and plan_task where applicable). Pi must advertise identical
 * definitions for deep schema equality.
 */
export const DEFAULT_TOOL_DEFS: readonly ToolDef[] = [
  {
    type: "function",
    function: {
      name: "task_done",
      description:
        "Call this tool to terminate task execution when you have completed the user's task, such as when no obvious code issues are found during code review.",
      parameters: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["DONE", "FAILED"],
            description: "Defaults to DONE. Return FAILED if the task cannot be completed using available tools.",
          },
        },
        required: ["state"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_comment",
      description:
        "When you discover that a code change could introduce code issue, please use this tool to report the issue. The tool will pinpoint your feedback to the precise code line (or block) in the current file by inserting a code comment.\n\n**Core Mechanism:**\nThis tool uses a dynamic sliding window algorithm to match corresponding consecutive lines in diff text based on your provided 'existing_code' parameter. Therefore, you must ensure the provided 'existing_code' actually exists in the diff text with exactly matching format. It should contain one or several consecutive lines of code most relevant to your comment.",
      parameters: {
        type: "object",
        properties: {
          comments: {
            type: "array",
            description: "A list of comments. Each item should contain 'content' and 'existing_code'.",
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "Comment content, typically a brief description of code issues and corresponding suggestions.",
                },
                existing_code: {
                  type: "string",
                  description:
                    "Code snippet used to locate comment position. Only return newly added code lines, should not include deleted code or unchanged code lines. Maintain consistent style with diff code for IDE recognition and mounting in current file.",
                },
                suggestion_code: {
                  type: "string",
                  description: "Corresponding suggested code snippet, maintaining consistent code style.",
                },
                category: {
                  type: "string",
                  enum: ["bug", "security", "performance", "maintainability", "test", "style", "documentation", "other"],
                  description: "The category the issue belongs to.",
                },
                severity: {
                  type: "string",
                  enum: ["critical", "high", "medium", "low"],
                  description: "The severity of the issue.",
                },
              },
              required: ["content", "existing_code", "category", "severity"],
            },
          },
        },
        required: ["comments"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Use this tool to read file content when you need to get context for git diff. You can specify start_line and end_line to view specific parts of the file.\n\n**Line Range Strategy:**\n- Git diff hunk header provides guidance on how to get more relevant context.\n- Git diff hunk header \"@@-x,y +m,n@@\" indicates that the old file has y lines starting from line x, and the new file has n lines starting from line m.\n- For example, when you need to read 50 lines above and below the current changed code block in the new file, set start_line = m - 50, end_line = m + n + 50.\n\n**Example output:**\nFile: path/to/example.go (Total lines: 50)\nIS_TRUNCATED: false\nLINE_RANGE: 10-12\n// The following is the original content of the file\nfunc main() {\n  fmt.Println(\"Hello, World!\")\n}\n\n**Limitations:**\n- If the specified range exceeds 500 lines, only 500 lines will be returned with a truncation notice.\n- This tool can only read file content from the modified version (after changes) in git diff.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The relative path of the file to open.",
          },
          start_line: {
            type: "integer",
            description: "The start line number to view. Defaults to 1.",
          },
          end_line: {
            type: "integer",
            description: "The end line number to view. Defaults to end line of file.",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_search",
      description:
        "Use this tool to search for specific text within files. Supports searching in specific files, directories, or across the entire codebase with flexible file pattern filtering. Can use either exact string matching or regular expressions.\n\n**Example output:**\nSearch results for 'toolRequest' (case-insensitive):\nFile: path/to/example.java\n433|      String name = toolRequest.get().getName();\n438|      logToolRequest(newPath, tool, toolRequest.get());\n\n**Regular expression examples (requires use_perl_regexp: true):**\n- Find classes that extend BaseModel: 'class.*extends.*BaseModel'\n- Find function: 'functionName(.*)'\n- Find the function call sites: '\\.functionName(.*)'\n- Match any of multiple strings: 'error|exception|fail'\n\n**File patterns examples:**\n- Single file: ['src/main.go']\n- Multiple files: ['src/main.go', 'lib/utils.js']\n- All Go files: ['*.go']\n- Exclude test files: [':(exclude)*_test.go']\n- Only in src directory: ['src/']\n- Multiple patterns: ['*.go', ':(exclude)vendor/']\n\n**Limitations:**\n- If more than 100 matches are found, only the first 100 results will be returned.\n- Empty search terms will return no results.\n- This tool searches in the current version of files.",
      parameters: {
        type: "object",
        properties: {
          search_text: {
            type: "string",
            description: "The text string or regular expression pattern to search for.",
          },
          file_patterns: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Array of patterns to include/exclude files in the search. Supports Git pathspec syntax for including and excluding files. If omitted, searches the entire codebase.",
          },
          case_sensitive: {
            type: "boolean",
            description: "Whether the search should be case-sensitive. Defaults to false (case-insensitive).",
          },
          use_perl_regexp: {
            type: "boolean",
            description:
              "If true, treats search_text as a Perl-compatible regular expression pattern instead of literal text. Defaults to false.",
          },
        },
        required: ["search_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read_diff",
      description:
        "The tool is used to view the changes made to other files in the list of modifications. Call this tool when you discover suspected code issues but need to check changes in other files to confirm whether the problem actually exists. This tool will respond in git diff format.\n\nOutput example:\n==== FILE: path/to/file1.txt ====\n--- a/path/to/file1.txt\n+++ b/path/to/file1.txt\n@@ -10,1 +10,1 @@\n- old content\n+ new content\n\n==== FILE: path/to/file2.txt ====\n@@ -5,1 +5,2 @@\n  - old content\n  + new content1\n  + new content2",
      parameters: {
        type: "object",
        properties: {
          path_array: {
            type: "array",
            items: {
              type: "string",
            },
            description: "List of file paths to view diff content.",
          },
        },
        required: ["path_array"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_find",
      description:
        "Search for matching files in the current project based on filename keywords. Use this tool when you cannot find the files you need to view in the current change file list.\n\nThis tool searches for filenames containing specified keywords in the project directory and returns a list of matching file paths. Search is case-insensitive by default, adjustable via case_sensitive parameter.\n\nNote: This tool only supports returning the first 100 matching file paths; excess will be truncated.\n\nExample:\nInput:\nquery_name: UserService\nOutput:\nsrc/main/java/UserService.java\nsrc/test/java/UserServiceTest.java",
      parameters: {
        type: "object",
        properties: {
          query_name: {
            type: "string",
            description: "Filename keyword to search for, supports partial matching.",
          },
          case_sensitive: {
            type: "boolean",
            description: "Whether to perform case-sensitive search. Defaults to false.",
          },
        },
        required: ["query_name"],
      },
    },
  },
] as const;

/** Filter by phase: main_task vs plan_task (mirrors toolsconfig.ToolDefsByPhase). */
export function toolDefsForPhase(planOnly: boolean): readonly ToolDef[] {
  // Per tools.json, plan_task true: code_search, file_read_diff, file_find
  // main_task true: all six
  const filtered = planOnly
    ? DEFAULT_TOOL_DEFS.filter((d) => d.function.name === "code_search" || d.function.name === "file_read_diff" || d.function.name === "file_find")
    : DEFAULT_TOOL_DEFS;
  // Attach RawDefinition so formatToolDefs can preserve raw JSON order
  // (pinned c35ddd7223f2b5540ce03aa43c9a25ef643fca27 tools.json). Without it
  // the fallback sorts alphabetically and diverges from OCR's raw order.
  return filtered.map((def) => {
    const fn = def.function as unknown as Record<string, unknown>;
    if (fn["RawDefinition"] !== undefined || fn["rawDefinition"] !== undefined) return def;
    const raw = JSON.stringify({
      name: fn["name"],
      description: fn["description"],
      parameters: fn["parameters"],
    });
    return {
      ...def,
      function: {
        ...(def.function as unknown as Record<string, unknown>),
        RawDefinition: raw,
      } as unknown as ToolDef["function"],
    };
  });
}

/** Main-task defs — the set advertised during review file loops. */
export function mainTaskToolDefs(): readonly ToolDef[] {
  return toolDefsForPhase(false);
}

/** Plan-task defs — tiny set for plan phase (if needed). */
export function planTaskToolDefs(): readonly ToolDef[] {
  return toolDefsForPhase(true);
}

// ---------------------------------------------------------------------------
// Toolsconfig loader — mirrors internal/config/toolsconfig/toolsconfig.go
// ---------------------------------------------------------------------------

/**
 * ToolConfigEntry mirrors Go's toolsconfig.ToolConfigEntry.
 * JSON fields use snake_case as in tools.json; we accept both forms.
 */
export interface ToolConfigEntry {
  readonly name: string;
  readonly plan_task: boolean;
  readonly main_task: boolean;
  readonly definition: unknown;
  // camelCase aliases for convenience (not serialized)
  readonly PlanTask?: boolean;
  readonly MainTask?: boolean;
  readonly Definition?: unknown;
}

function normalizeEntry(raw: unknown): ToolConfigEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("unmarshal tools file: entry must be an object");
  }
  const rec = raw as Record<string, unknown>;
  const name = rec["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("unmarshal tools file: entry missing non-empty string field 'name'");
  }
  const planRaw = rec["plan_task"] ?? rec["PlanTask"] ?? rec["planTask"];
  const mainRaw = rec["main_task"] ?? rec["MainTask"] ?? rec["mainTask"];
  const planTask = typeof planRaw === "boolean" ? planRaw : false;
  const mainTask = typeof mainRaw === "boolean" ? mainRaw : false;
  const def = rec["definition"] ?? rec["Definition"];
  if (def === undefined || def === null) {
    throw new Error(`unmarshal tools file: entry ${JSON.stringify(name)} missing 'definition'`);
  }
  if (typeof def !== "object" || Array.isArray(def)) {
    throw new Error(`unmarshal tools file: entry ${JSON.stringify(name)} definition must be an object`);
  }
  // Object-root validation: if parameters present, type must be object. We warn but do not fail at Load —
  // BuildToolDefs will enforce and skip invalid entries, matching Go's warning behavior.
  return {
    name: name,
    plan_task: planTask,
    main_task: mainTask,
    definition: def,
  } as ToolConfigEntry;
}

/**
 * Default entries derived from the embedded tools.json (same order as DEFAULT_TOOL_DEFS).
 * These are used when Load("") is called, mirroring Go's embed fallback.
 */
const DEFAULT_TOOL_ENTRIES: readonly ToolConfigEntry[] = (() => {
  const defs = DEFAULT_TOOL_DEFS as readonly ToolDef[];
  const flags: Record<string, { plan: boolean; main: boolean }> = {
    task_done: { plan: false, main: true },
    code_comment: { plan: false, main: true },
    file_read: { plan: false, main: true },
    code_search: { plan: true, main: true },
    file_read_diff: { plan: true, main: true },
    file_find: { plan: true, main: true },
  };
  return defs.map((d) => {
    const n = d.function.name as string;
    const f = flags[n] ?? { plan: false, main: false };
    const rawDef: unknown = {
      name: d.function.name,
      description: d.function.description,
      parameters: d.function.parameters,
    };
    return {
      name: n,
      plan_task: f.plan,
      main_task: f.main,
      definition: rawDef,
    } as ToolConfigEntry;
  });
})();

/**
 * Load parses the tools config file. When path is empty, falls back to
 * the embedded default tools configuration — mirrors Go's toolsconfig.Load.
 * Validates external input at the boundary and preserves order/raw schema.
 */
export function loadToolConfig(path: string): ToolConfigEntry[] {
  if (path === "" || path === undefined) {
    // Return a shallow copy to prevent mutation
    return [...DEFAULT_TOOL_ENTRIES];
  }
  if (typeof path !== "string") {
    throw new Error(`read tools file ${String(path)}: path must be a string`);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`read tools file ${path}: ${msg}`);
  }
  if (st.isDirectory()) {
    throw new Error(`read tools file ${path}: is a directory`);
  }
  let data: string;
  try {
    data = fs.readFileSync(path, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`read tools file ${path}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`unmarshal tools file: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("unmarshal tools file: top-level JSON must be an array");
  }
  const out: ToolConfigEntry[] = [];
  for (const raw of parsed) {
    out.push(normalizeEntry(raw));
  }
  return out;
}

/**
 * ToolDefsByPhase mirrors Go's (t *ToolConfigEntry) ToolDefsByPhase.
 * planOnly=true returns definition only when plan_task is true.
 */
export function toolDefsByPhase(entry: ToolConfigEntry, planOnly: boolean): [unknown, boolean] {
  const plan = entry.plan_task ?? entry.PlanTask ?? false;
  const main = entry.main_task ?? entry.MainTask ?? false;
  if (planOnly && plan) return [entry.definition ?? entry.Definition, true];
  if (!planOnly && main) return [entry.definition ?? entry.Definition, true];
  return [undefined, false];
}

/**
 * buildToolDefs converts ToolConfigEntry slice into ToolDef[], filtering by phase
 * and preserving order and raw definition — mirrors Go's agent.BuildToolDefs.
 * Validates object-root schemas and bounded capabilities at the boundary:
 * - parameters must be object-root when present
 * - mutation tools (shell/edit/write/exec) are not granted via registry; they remain stubbed
 */
export function buildToolDefs(entries: readonly ToolConfigEntry[], planOnly: boolean): readonly ToolDef[] {
  const out: ToolDef[] = [];
  for (const e of entries) {
    const [defRaw, ok] = toolDefsByPhase(e, planOnly);
    if (!ok) continue;
    if (defRaw === undefined || defRaw === null) continue;
    // Validate that defRaw is an object with at least a name
    if (typeof defRaw !== "object" || Array.isArray(defRaw)) {
      // Mimic Go's warning and skip
      try {
        console.error(`[pi-review] WARNING: failed to parse tool definition ${JSON.stringify(e.name)}: definition must be an object`);
      } catch {}
      continue;
    }
    const rec = defRaw as Record<string, unknown>;
    const fnName = typeof rec["name"] === "string" ? (rec["name"] as string) : e.name;
    // Object-root validation: if parameters present, must be type object
    const params = rec["parameters"] as Record<string, unknown> | undefined;
    if (params !== undefined && params !== null) {
      if (typeof params !== "object" || Array.isArray(params)) {
        try { console.error(`[pi-review] WARNING: failed to parse tool definition ${JSON.stringify(e.name)}: parameters must be an object`);} catch {}
        continue;
      }
      const pType = (params as Record<string, unknown>)["type"];
      if (pType !== undefined && pType !== "object") {
        try { console.error(`[pi-review] WARNING: failed to parse tool definition ${JSON.stringify(e.name)}: parameters.type must be "object"`);} catch {}
        continue;
      }
    }
    // Bounded capabilities: deny explicit mutation tool names via custom config.
    // This does not affect the 6 built-in allowlisted tools.
    const lower = fnName.toLowerCase();
    const isBuiltIn = ["task_done", "code_comment", "file_read", "code_search", "file_read_diff", "file_find"].includes(lower);
    if (!isBuiltIn) {
      const denyList = ["shell", "exec", "edit", "write", "apply_patch", "run_shell", "bash", "sh", "mutation"];
      const isDenied = denyList.some((d) => lower.includes(d));
      if (isDenied) {
        try { console.error(`[pi-review] WARNING: tool ${JSON.stringify(fnName)} denied: mutation capabilities not allowed via custom tools config`);} catch {}
        continue;
      }
    }
    const raw = JSON.stringify(defRaw);
    const fn: Record<string, unknown> = {
      name: fnName,
      description: typeof rec["description"] === "string" ? rec["description"] : "",
      parameters: rec["parameters"] ?? { type: "object", properties: {} },
      RawDefinition: raw,
    };
    out.push({
      type: "function",
      function: fn as unknown as ToolDef["function"],
    });
  }
  return out;
}

/**
 * Convenience: load and build in one step for factory wiring.
 */
export function loadToolDefs(path: string, planOnly: boolean): readonly ToolDef[] {
  const entries = loadToolConfig(path);
  return buildToolDefs(entries, planOnly);
}
