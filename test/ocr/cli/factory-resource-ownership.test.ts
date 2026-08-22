// No-network resource ownership boundary tests.
import { expect, test } from "bun:test";
import { withOwnedTransport, type RuntimeTransport } from "../../../src/ocr/cli/factory.js";

function transport(dispose: () => Promise<void>): RuntimeTransport {
  return {
    complete: async () => ({ content: "", toolCalls: [] }),
    dispose,
    modelIdentity: () => ({ provider: "test", model: "model" }),
  };
}

test("review and scan ownership success disposes exactly once", async () => {
  for (const _factory of ["review", "scan"]) {
    let count = 0;
    await withOwnedTransport(transport(async () => { count += 1; }), async () => "ok");
    expect(count).toBe(1);
  }
});

test("ownership disposes once for primary failure and preserves both errors", async () => {
  let count = 0;
  let thrown: unknown;
  try {
    await withOwnedTransport(
      transport(async () => { count += 1; throw new Error("dispose failure"); }),
      async () => { throw new Error("primary failure"); },
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AggregateError);
  const aggregate = thrown as AggregateError;
  expect(aggregate.errors.map((item) => String((item as Error).message))).toEqual(["primary failure", "dispose failure"]);
  expect(count).toBe(1);
});

test("ownership surfaces a dispose-only failure", async () => {
  await expect(withOwnedTransport(
    transport(async () => { throw new Error("dispose only"); }),
    async () => undefined,
  )).rejects.toThrow("dispose only");
});
