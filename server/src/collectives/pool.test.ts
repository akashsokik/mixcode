// Unit tests for WorkerPool. Uses a MockWorker so they run without an API
// key and finish in well under a second.
//
// Run: npm --workspace server run test
import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkerPool, unwrapText, aggregateUsage } from "./pool.js";
import type { Worker, WorkerRequest, WorkerResult } from "./worker.js";

type MockOpts = {
  // Per-request delay in ms (defaults to 5).
  delayMs?: number;
  // Indices to fail with the given error. If `transient`, only the first
  // call at each index fails — useful for retry-ish patterns, though the
  // pool itself doesn't retry (the Worker does).
  failAt?: Set<number>;
  failError?: Error;
};

class MockWorker implements Worker {
  inFlight = 0;
  peakConcurrency = 0;
  calls: WorkerRequest[] = [];
  private idx = 0;
  constructor(private readonly opts: MockOpts = {}) {}

  async run(req: WorkerRequest): Promise<WorkerResult> {
    const i = this.idx++;
    this.calls.push(req);
    this.inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, this.opts.delayMs ?? 5));
      if (this.opts.failAt?.has(i)) {
        throw this.opts.failError ?? new Error(`fail@${i}`);
      }
      return {
        text: `echo:${req.prompt}`,
        usage: {
          inputTokens: req.prompt.length,
          outputTokens: req.prompt.length,
          cacheReadTokens: req.cache ? 100 : 0,
          cacheWriteTokens: 0,
        },
        stopReason: "end_turn",
        attempts: 1,
        model: req.model ?? "mock",
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

test("pool respects concurrency cap", async () => {
  const worker = new MockWorker({ delayMs: 20 });
  const pool = new WorkerPool(worker, { concurrency: 5 });
  const reqs: WorkerRequest[] = Array.from({ length: 50 }, (_, i) => ({
    prompt: `p${i}`,
  }));
  const results = await pool.map(reqs);
  assert.equal(results.length, 50);
  assert.equal(results.every((r) => r.ok), true);
  assert.ok(worker.peakConcurrency <= 5, `peak=${worker.peakConcurrency}`);
  assert.ok(worker.peakConcurrency >= 4, `peak=${worker.peakConcurrency}`);
});

test("pool preserves result order", async () => {
  const worker = new MockWorker({ delayMs: 0 });
  const pool = new WorkerPool(worker, { concurrency: 8 });
  const reqs: WorkerRequest[] = Array.from({ length: 20 }, (_, i) => ({
    prompt: `i=${i}`,
  }));
  const results = await pool.map(reqs);
  for (let i = 0; i < 20; i++) {
    const r = results[i];
    assert.ok(r?.ok);
    if (r.ok) assert.equal(r.value.text, `echo:i=${i}`);
  }
});

test("pool collects partial failures by default", async () => {
  const worker = new MockWorker({ failAt: new Set([1, 4, 7]) });
  const pool = new WorkerPool(worker);
  const results = await pool.map(
    Array.from({ length: 10 }, (_, i) => ({ prompt: `p${i}` })),
  );
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 3);
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 7);
});

test("pool throws on first failure when throwOnError is true", async () => {
  const worker = new MockWorker({ failAt: new Set([2]) });
  const pool = new WorkerPool(worker);
  await assert.rejects(
    () =>
      pool.map(
        Array.from({ length: 10 }, (_, i) => ({ prompt: `p${i}` })),
        { throwOnError: true },
      ),
    /fail@2/,
  );
});

test("unwrapText returns texts in order; throws AggregateError on failure", () => {
  const worker = new MockWorker();
  // Synthesize results inline — we're testing the helper, not the pool.
  const results = [
    { ok: true as const, value: { text: "a" } as WorkerResult, index: 0 },
    { ok: true as const, value: { text: "b" } as WorkerResult, index: 1 },
  ];
  assert.deepEqual(unwrapText(results), ["a", "b"]);

  const withFail = [
    ...results,
    { ok: false as const, error: new Error("boom"), index: 2 },
  ];
  assert.throws(() => unwrapText(withFail), (e: unknown) => e instanceof AggregateError);
  // The mock worker isn't used by the unwrap helper, just here so the import
  // is exercised in this test too.
  void worker;
});

test("aggregateUsage sums tokens across successes only", () => {
  const make = (input: number, output: number, ok = true) =>
    ok
      ? {
          ok: true as const,
          value: {
            text: "",
            usage: {
              inputTokens: input,
              outputTokens: output,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            stopReason: null,
            attempts: 1,
            model: "m",
          },
          index: 0,
        }
      : { ok: false as const, error: new Error("nope"), index: 0 };

  const agg = aggregateUsage([make(10, 5), make(20, 7), make(0, 0, false)]);
  assert.equal(agg.inputTokens, 30);
  assert.equal(agg.outputTokens, 12);
  assert.equal(agg.successCount, 2);
  assert.equal(agg.failureCount, 1);
});

test("progress callback fires once per task", async () => {
  const worker = new MockWorker({ delayMs: 1 });
  const pool = new WorkerPool(worker, { concurrency: 3 });
  let count = 0;
  let lastDone = 0;
  await pool.map(
    Array.from({ length: 10 }, (_, i) => ({ prompt: `p${i}` })),
    {
      onProgress: (done, total) => {
        count += 1;
        assert.equal(total, 10);
        assert.ok(done > lastDone);
        lastDone = done;
      },
    },
  );
  assert.equal(count, 10);
});
