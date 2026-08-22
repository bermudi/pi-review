// SPDX-License-Identifier: GPL-3.0-or-later
// Regression coverage for Pi's public dynamic tool allowlist boundary.

import { expect, test } from "bun:test";
import {
  activateToolsFailClosed,
  assertUniqueToolNames,
  type ActiveToolSession,
} from "../../../src/ocr/pi-adapter/pi-transport.js";
import type { ToolDef } from "../../../src/ocr/llmloop/types.js";

function tool(name: string): ToolDef {
  return { type: "function", function: { name, parameters: { type: "object", properties: {} } } };
}

test("active tools set and verify the exact requested names, including clearing", () => {
  let active = ["report_incorrect_comments"];
  const session: ActiveToolSession = {
    setActiveToolsByName: (names) => { active = [...names]; },
    getActiveToolNames: () => active,
  };
  activateToolsFailClosed(session, ["report_incorrect_comments", "approve_all_comments"]);
  activateToolsFailClosed(session, []);
  expect(active).toEqual([]);
});

test("active tools fail closed on setter errors, ignored names, and stale extras", () => {
  const throwing: ActiveToolSession = {
    setActiveToolsByName: () => { throw new Error("setter broke"); },
    getActiveToolNames: () => [],
  };
  expect(() => activateToolsFailClosed(throwing, ["filter"])).toThrow("failed while setting");

  const ignored: ActiveToolSession = {
    setActiveToolsByName: () => {},
    getActiveToolNames: () => [],
  };
  expect(() => activateToolsFailClosed(ignored, ["unknown"])).toThrow("mismatch");

  const stale: ActiveToolSession = {
    setActiveToolsByName: () => {},
    getActiveToolNames: () => ["filter", "stale"],
  };
  expect(() => activateToolsFailClosed(stale, ["filter"])).toThrow("mismatch");
});

test("supplemental registration rejects duplicate tool names", () => {
  expect(() => assertUniqueToolNames([tool("base")], [tool("base")])).toThrow("duplicate");
});
