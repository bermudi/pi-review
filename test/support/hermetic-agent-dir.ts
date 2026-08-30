// Hermetic test harness: every in-process test resolves its pi agent
// directory to an empty temporary directory, so no developer (or machine)
// settings, extensions, or credentials are ever loaded or executed during
// tests. Tests that need a specific agent dir pass it explicitly or spawn a
// subprocess with their own environment (they override this variable).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["PI_CODING_AGENT_DIR"] = mkdtempSync(join(tmpdir(), "ocr-test-agent-"));
