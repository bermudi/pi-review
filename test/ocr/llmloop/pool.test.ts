// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/pool_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;

import { describe, test, expect } from "bun:test";
import { CommentWorkerPool } from "../../../src/ocr/llmloop/pool.js";
import type { LlmComment } from "../../../src/ocr/model/types.js";

function comment(path: string, content: string): LlmComment {
  return { path, content };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ocr CommentWorkerPool (ported from pool_test.go)", () => {
  // OCR v1.9.3: TestNewCommentWorkerPool_Default
  test("default capacity 8 when 0", () => {
    const p = new CommentWorkerPool(0);
    expect(p.workerCount).toBe(8);
  });

  // OCR v1.9.3: TestNewCommentWorkerPool_Custom
  test("custom capacity", () => {
    const p = new CommentWorkerPool(4);
    expect(p.workerCount).toBe(4);
  });

  // OCR v1.9.3: TestCommentWorkerPool_SubmitAndAwait
  test("SubmitAndAwait collects results", async () => {
    const p = new CommentWorkerPool(2);
    p.Submit(() => [comment("a.go", "issue 1")]);
    p.Submit(() => [comment("b.go", "issue 2"), comment("b.go", "issue 3")]);

    const results = await p.Await();

    expect(results).toHaveLength(3);
    expect(new Set(results.map((result) => result.path))).toEqual(new Set(["a.go", "b.go"]));
  });

  // OCR v1.9.3: TestCommentWorkerPool_ErrorDoesNotBlock
  test("Error does not block", async () => {
    const p = new CommentWorkerPool(2);
    p.Submit(() => {
      throw new Error("oops");
    });
    p.Submit(() => [comment("ok.go", "fine")]);

    const results = await p.Await();

    expect(results).toEqual([comment("ok.go", "fine")]);
  });

  // OCR v1.9.3: TestCommentWorkerPool_AwaitEmpty
  test("AwaitEmpty no submissions", async () => {
    const p = new CommentWorkerPool(2);
    expect(await p.Await()).toEqual([]);
  });

  // OCR v1.9.3: TestCommentWorkerPool_PanicIsIsolated
  test("PanicIsIsolated", async () => {
    const p = new CommentWorkerPool(2);
    p.Submit(() => {
      throw new Error("boom");
    });
    p.Submit(() => [comment("healthy.go", "fine")]);

    const results = await p.Await();

    expect(results).toEqual([comment("healthy.go", "fine")]);
  });

  // OCR v1.9.3: TestCommentWorkerPool_Concurrency
  test("Concurrency never exceeds the configured worker count", async () => {
    const p = new CommentWorkerPool(3);
    const release = deferred();
    let running = 0;
    let maxRunning = 0;

    for (let i = 0; i < 10; i++) {
      p.Submit(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await release.promise;
        running--;
        return [];
      });
    }

    // Let the first three tasks acquire permits before releasing them.
    await Promise.resolve();
    expect(running).toBe(3);
    release.resolve();
    await p.Await();

    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  // OCR v1.9.3: TestCommentWorkerPool_AwaitKeyWaitsForOwnKey
  test("AwaitKey waits for its key but not another key", async () => {
    const p = new CommentWorkerPool(2);
    const ownStarted = deferred();
    const ownRelease = deferred();
    const otherStarted = deferred();
    const otherRelease = deferred();

    p.SubmitFor("own.go", async () => {
      ownStarted.resolve();
      await ownRelease.promise;
      return [comment("own.go", "mine")];
    });
    p.SubmitFor("other.go", async () => {
      otherStarted.resolve();
      await otherRelease.promise;
      return [comment("other.go", "theirs")];
    });

    await Promise.all([ownStarted.promise, otherStarted.promise]);
    let returned = false;
    const awaitOwn = p.AwaitKey("own.go").then(() => {
      returned = true;
    });

    ownRelease.resolve();
    await awaitOwn;
    expect(returned).toBe(true);

    otherRelease.resolve();
    const results = await p.Await();
    expect(results).toHaveLength(2);
  });

  // OCR v1.9.3: TestCommentWorkerPool_AwaitKeyConcurrentSubmitOtherKey
  test("AwaitKey remains isolated while another key keeps submitting", async () => {
    const p = new CommentWorkerPool(4);
    const producerCount = 4;
    const submissionsPerProducer = 200;
    let drained = 0;
    let submitted = 0;

    await Promise.all(
      [
        ...Array.from({ length: producerCount }, async () => {
          for (let j = 0; j < submissionsPerProducer; j++) {
            p.SubmitFor("producer.go", () => []);
            submitted++;
            await Promise.resolve();
          }
        }),
        ...Array.from({ length: producerCount }, async (_, index) => {
          const key = `drainer-${index}.go`;
          for (let j = 0; j < submissionsPerProducer; j++) {
            p.SubmitFor(key, () => [comment(key, "drained")]);
            await p.AwaitKey(key);
            drained++;
            await Promise.resolve();
          }
        }),
      ],
    );

    await p.Await();

    expect(drained).toBe(producerCount * submissionsPerProducer);
    expect(submitted).toBe(producerCount * submissionsPerProducer);
  });

  // OCR v1.9.3: TestCommentWorkerPool_AwaitKeyUnknown
  test("AwaitKey for an unknown key returns immediately", async () => {
    const p = new CommentWorkerPool(2);
    await expect(p.AwaitKey("never-submitted.go")).resolves.toBeUndefined();
  });
});
