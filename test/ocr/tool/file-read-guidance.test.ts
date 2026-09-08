// pi-reviewer extension: missing file_read guides to file_find.
// The model guessed non-existent paths (skill-cmd, model-cmd, wrong spec).
import { describe, test, expect } from "bun:test";
import { FileReader, FileReadProvider, ReviewMode } from "../../../src/ocr/tool/filereader.ts";

describe("file_read missing-file guidance", () => {
  test("not-found error suggests file_find", async () => {
    const fr = new FileReader({ RepoDir: "/tmp/does-not-exist-xyz", Mode: ReviewMode.ModeWorkspace, Ref: "" });
    const prov = new FileReadProvider(fr);
    let msg = "";
    try {
      await prov.Execute(undefined, { file_path: "src/commands/skill-cmd.ts", start_line: 1, end_line: 10 });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("not found");
    expect(msg).toContain("file_find");
  });
});
