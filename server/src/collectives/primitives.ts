// Collective primitives over a WorkerPool. These are the user-facing
// operations the orchestrator agent will reach for via the MCP server in
// ./mcp.ts. The library form here is exported so non-agent code paths
// (smoke tests, batch scripts, embedded use) can call them directly.
//
// Naming intentionally borrows from MPI / Ray:
//
//   scatter      — fan out N independent requests, return all results
//   scatterMap   — apply one template over N inputs (the common case)
//   mapReduce    — scatterMap, then reduce to one result via a reducer prompt
//   allReduce    — every worker drafts, then sees all drafts, then refines
//   treeReduce   — hierarchical reduction for when fan-in is too big for one
//                  reducer's context window (log-depth tree of reducers)

import type { Worker, WorkerRequest, WorkerResult } from "./worker.js";
import { WorkerPool, unwrapText, aggregateUsage, type PoolResult } from "./pool.js";

export type CollectiveStats = ReturnType<typeof aggregateUsage>;

// ---- scatter ----------------------------------------------------------

export type ScatterOptions = {
  concurrency?: number;
  throwOnError?: boolean;
};

// The maximally general primitive: caller supplies N fully-formed requests.
// Use this when each task needs a different system / model / params. For
// the common case where everything except a single input field is shared,
// reach for scatterMap instead.
export async function scatter(
  worker: Worker,
  requests: WorkerRequest[],
  opts: ScatterOptions = {},
): Promise<{ results: PoolResult<WorkerResult>[]; stats: CollectiveStats }> {
  const pool = new WorkerPool(worker, { concurrency: opts.concurrency });
  const results = await pool.map(requests, { throwOnError: opts.throwOnError });
  return { results, stats: aggregateUsage(results) };
}

// ---- scatterMap -------------------------------------------------------

export type ScatterMapRequest = {
  system?: string;
  // Template containing the placeholder `{input}`. We do a single string
  // replace rather than a full templating language — collective ops are
  // hot paths, and anything more elaborate belongs in the caller's code.
  template: string;
  inputs: string[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  // System is cached by default — at this scale you almost always want it.
  cacheSystem?: boolean;
};

export async function scatterMap(
  worker: Worker,
  req: ScatterMapRequest,
  opts: ScatterOptions = {},
): Promise<{ texts: string[]; stats: CollectiveStats; results: PoolResult<WorkerResult>[] }> {
  const requests: WorkerRequest[] = req.inputs.map((input) => ({
    system: req.system,
    cache: req.cacheSystem ?? true,
    prompt: req.template.replace("{input}", input),
    model: req.model,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
  }));

  const pool = new WorkerPool(worker, { concurrency: opts.concurrency });
  const results = await pool.map(requests, { throwOnError: opts.throwOnError });

  // unwrapText throws AggregateError on failures; with throwOnError=false
  // (default), callers can introspect `results` for partial failures.
  if (opts.throwOnError === false) {
    const texts = results.map((r) => (r.ok ? r.value.text : ""));
    return { texts, stats: aggregateUsage(results), results };
  }
  return { texts: unwrapText(results), stats: aggregateUsage(results), results };
}

// ---- mapReduce --------------------------------------------------------

export type MapReduceRequest = {
  mapSystem?: string;
  mapTemplate: string;
  inputs: string[];
  reduceSystem?: string;
  reduceTemplate: string; // contains `{items}` placeholder
  mapModel?: string;
  // Reducer typically wants a smarter model than the mappers.
  reduceModel?: string;
  mapMaxTokens?: number;
  reduceMaxTokens?: number;
  itemSeparator?: string;
};

export async function mapReduce(
  worker: Worker,
  req: MapReduceRequest,
  opts: ScatterOptions = {},
): Promise<{ text: string; stats: CollectiveStats; mapped: string[] }> {
  const mapResult = await scatterMap(
    worker,
    {
      system: req.mapSystem,
      template: req.mapTemplate,
      inputs: req.inputs,
      model: req.mapModel,
      maxTokens: req.mapMaxTokens,
    },
    opts,
  );

  const sep = req.itemSeparator ?? "\n---\n";
  const reducer = await worker.run({
    system: req.reduceSystem,
    cache: req.reduceSystem !== undefined,
    prompt: req.reduceTemplate.replace("{items}", mapResult.texts.join(sep)),
    model: req.reduceModel,
    maxTokens: req.reduceMaxTokens,
  });

  // Roll the reducer's usage into the aggregate stats.
  const stats: CollectiveStats = {
    inputTokens: mapResult.stats.inputTokens + reducer.usage.inputTokens,
    outputTokens: mapResult.stats.outputTokens + reducer.usage.outputTokens,
    cacheReadTokens: mapResult.stats.cacheReadTokens + reducer.usage.cacheReadTokens,
    cacheWriteTokens: mapResult.stats.cacheWriteTokens + reducer.usage.cacheWriteTokens,
    successCount: mapResult.stats.successCount + 1,
    failureCount: mapResult.stats.failureCount,
    totalAttempts: mapResult.stats.totalAttempts + reducer.attempts,
  };

  return { text: reducer.text, stats, mapped: mapResult.texts };
}

// ---- allReduce --------------------------------------------------------

export type AllReduceRequest = {
  system?: string;
  // Each entry is the prompt for one worker's first (draft) round. The
  // length of `prompts` determines the worker count.
  prompts: string[];
  // After drafts are in, each worker sees ALL drafts (labeled by index)
  // and is asked to refine. `refineTemplate` receives two placeholders:
  // `{ownDraft}` and `{allDrafts}`.
  refineTemplate: string;
  model?: string;
  maxTokens?: number;
};

export async function allReduce(
  worker: Worker,
  req: AllReduceRequest,
  opts: ScatterOptions = {},
): Promise<{ refined: string[]; drafts: string[]; stats: CollectiveStats }> {
  const draftPool = new WorkerPool(worker, { concurrency: opts.concurrency });
  const draftResults = await draftPool.map(
    req.prompts.map((p) => ({
      system: req.system,
      cache: req.system !== undefined,
      prompt: p,
      model: req.model,
      maxTokens: req.maxTokens,
    })),
    { throwOnError: opts.throwOnError },
  );
  const drafts = unwrapText(draftResults);

  const pooled = drafts.map((d, i) => `[Worker ${i}]\n${d}`).join("\n---\n");

  const refinePool = new WorkerPool(worker, { concurrency: opts.concurrency });
  const refineResults = await refinePool.map(
    drafts.map((ownDraft) => ({
      system: req.system,
      cache: req.system !== undefined,
      prompt: req.refineTemplate
        .replace("{ownDraft}", ownDraft)
        .replace("{allDrafts}", pooled),
      model: req.model,
      maxTokens: req.maxTokens,
    })),
    { throwOnError: opts.throwOnError },
  );
  const refined = unwrapText(refineResults);

  const a = aggregateUsage(draftResults);
  const b = aggregateUsage(refineResults);
  const stats: CollectiveStats = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    successCount: a.successCount + b.successCount,
    failureCount: a.failureCount + b.failureCount,
    totalAttempts: a.totalAttempts + b.totalAttempts,
  };

  return { refined, drafts, stats };
}

// ---- treeReduce -------------------------------------------------------

export type TreeReduceRequest = {
  mapSystem?: string;
  mapTemplate: string;
  inputs: string[];
  reduceSystem?: string;
  // `{items}` will be replaced with `branchFactor` joined map/intermediate
  // results at each level of the tree.
  reduceTemplate: string;
  branchFactor?: number;
  mapModel?: string;
  reduceModel?: string;
  mapMaxTokens?: number;
  reduceMaxTokens?: number;
  itemSeparator?: string;
};

// Hierarchical reduction. Map all inputs in parallel, then collapse the
// results in waves of `branchFactor` until one remains. Use when a single
// reducer call wouldn't fit (e.g. 500 mapped outputs into one context).
export async function treeReduce(
  worker: Worker,
  req: TreeReduceRequest,
  opts: ScatterOptions = {},
): Promise<{ text: string; stats: CollectiveStats; levels: number }> {
  const branchFactor = Math.max(2, req.branchFactor ?? 8);
  const sep = req.itemSeparator ?? "\n---\n";

  // Level 0: map.
  const mapResult = await scatterMap(
    worker,
    {
      system: req.mapSystem,
      template: req.mapTemplate,
      inputs: req.inputs,
      model: req.mapModel,
      maxTokens: req.mapMaxTokens,
    },
    opts,
  );

  let current = mapResult.texts;
  const total: CollectiveStats = { ...mapResult.stats };
  let levels = 0;

  while (current.length > 1) {
    levels += 1;
    const batches: string[][] = [];
    for (let i = 0; i < current.length; i += branchFactor) {
      batches.push(current.slice(i, i + branchFactor));
    }
    const reducerRequests: WorkerRequest[] = batches.map((batch) => ({
      system: req.reduceSystem,
      cache: req.reduceSystem !== undefined,
      prompt: req.reduceTemplate.replace("{items}", batch.join(sep)),
      model: req.reduceModel,
      maxTokens: req.reduceMaxTokens,
    }));
    const pool = new WorkerPool(worker, { concurrency: opts.concurrency });
    const results = await pool.map(reducerRequests, { throwOnError: opts.throwOnError });
    current = unwrapText(results);

    const u = aggregateUsage(results);
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheReadTokens += u.cacheReadTokens;
    total.cacheWriteTokens += u.cacheWriteTokens;
    total.successCount += u.successCount;
    total.failureCount += u.failureCount;
    total.totalAttempts += u.totalAttempts;
  }

  return { text: current[0]!, stats: total, levels };
}
