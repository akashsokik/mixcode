// WorkerPool: bounded-concurrency executor for fan-out over a Worker.
//
// `messages.create` is async — JS doesn't need threads to fan out 100s of
// requests, it just needs a Promise per request and an event loop. The pool
// adds two things on top:
//
//   1. Concurrency cap (default 15, matching the API's per-key concurrent-
//      request ceiling). Set higher only if you're rotating keys.
//   2. Per-task isolation: a failing task doesn't poison the batch unless
//      `throwOnError` is true. Callers get an array of {ok, value | error}.
//
// The pool is *not* a queue server. It exists for the lifetime of a single
// scatter/gather invocation. Long-lived workloads should construct a pool
// per batch and let it be garbage-collected.

import type { Worker, WorkerRequest, WorkerResult } from "./worker.js";

export type PoolResult<T> =
  | { ok: true; value: T; index: number }
  | { ok: false; error: unknown; index: number };

export type PoolOptions = {
  concurrency?: number;
  // If true, the first failure rejects the whole batch (cancels in-flight
  // work via the AbortController if the underlying client honors it).
  throwOnError?: boolean;
  // Optional per-task progress callback. Fires once per task on completion.
  onProgress?: (done: number, total: number, result: PoolResult<WorkerResult>) => void;
};

const DEFAULT_CONCURRENCY = 15;

export class WorkerPool {
  private readonly worker: Worker;
  private readonly concurrency: number;

  constructor(worker: Worker, opts: { concurrency?: number } = {}) {
    this.worker = worker;
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  // Fan out `requests` and return results in the same order. By default,
  // collects exceptions per task (caller can filter). With throwOnError,
  // the first failure aborts the batch.
  async map(
    requests: WorkerRequest[],
    opts: PoolOptions = {},
  ): Promise<PoolResult<WorkerResult>[]> {
    const total = requests.length;
    const results: PoolResult<WorkerResult>[] = new Array(total);
    let nextIndex = 0;
    let done = 0;
    let cancelled = false;
    let abortError: unknown = null;
    const concurrency = Math.min(opts.concurrency ?? this.concurrency, total);

    const runOne = async (): Promise<void> => {
      while (true) {
        if (cancelled) return;
        const i = nextIndex++;
        if (i >= total) return;

        let r: PoolResult<WorkerResult>;
        try {
          const value = await this.worker.run(requests[i]!);
          r = { ok: true, value, index: i };
        } catch (error) {
          r = { ok: false, error, index: i };
        }

        results[i] = r;
        done += 1;
        opts.onProgress?.(done, total, r);

        if (!r.ok && opts.throwOnError) {
          cancelled = true;
          abortError = r.error;
          return;
        }
      }
    };

    const workers = Array.from({ length: concurrency }, () => runOne());
    await Promise.all(workers);

    if (cancelled && opts.throwOnError) throw abortError;
    return results;
  }
}

// Convenience: pull just the text out of successful results, in order.
// Throws an aggregated error if any task failed.
export function unwrapText(results: PoolResult<WorkerResult>[]): string[] {
  const failures: { index: number; error: unknown }[] = [];
  const out: string[] = [];
  for (const r of results) {
    if (r.ok) out[r.index] = r.value.text;
    else failures.push({ index: r.index, error: r.error });
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => (f.error instanceof Error ? f.error : new Error(String(f.error)))),
      `${failures.length}/${results.length} worker tasks failed (indices: ${failures.map((f) => f.index).join(",")})`,
    );
  }
  return out;
}

// Aggregate the usage stats across all successful results. Lets the
// orchestrator surface "this scatter cost X tokens / had Y cache hits".
export function aggregateUsage(results: PoolResult<WorkerResult>[]): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  successCount: number;
  failureCount: number;
  totalAttempts: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let successCount = 0;
  let failureCount = 0;
  let totalAttempts = 0;
  for (const r of results) {
    if (r.ok) {
      inputTokens += r.value.usage.inputTokens;
      outputTokens += r.value.usage.outputTokens;
      cacheReadTokens += r.value.usage.cacheReadTokens;
      cacheWriteTokens += r.value.usage.cacheWriteTokens;
      totalAttempts += r.value.attempts;
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    successCount,
    failureCount,
    totalAttempts,
  };
}
