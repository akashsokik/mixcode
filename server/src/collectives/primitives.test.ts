// Unit tests for the collective primitives. Uses a deterministic mock
// worker — no API key needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scatterMap, mapReduce, allReduce, treeReduce } from "./primitives.js";
import type { Worker, WorkerRequest, WorkerResult } from "./worker.js";

// A worker whose response is a programmable function of the request. Lets
// each test prescribe the "model" output without mocking HTTP.
class ProgrammableWorker implements Worker {
  calls: WorkerRequest[] = [];
  constructor(private readonly respond: (req: WorkerRequest, i: number) => string) {}
  async run(req: WorkerRequest): Promise<WorkerResult> {
    const i = this.calls.length;
    this.calls.push(req);
    return {
      text: this.respond(req, i),
      usage: {
        inputTokens: req.prompt.length,
        outputTokens: 10,
        cacheReadTokens: req.cache ? 50 : 0,
        cacheWriteTokens: 0,
      },
      stopReason: "end_turn",
      attempts: 1,
      model: req.model ?? "mock",
    };
  }
}

test("scatterMap fans out one prompt per input and substitutes {input}", async () => {
  const worker = new ProgrammableWorker((req) => `OUT:${req.prompt}`);
  const result = await scatterMap(worker, {
    system: "shared system",
    template: "summarize: {input}",
    inputs: ["a", "b", "c"],
  });
  assert.equal(worker.calls.length, 3);
  assert.equal(worker.calls[0]!.prompt, "summarize: a");
  assert.equal(worker.calls[1]!.prompt, "summarize: b");
  assert.equal(worker.calls[2]!.prompt, "summarize: c");
  // System cached by default — each call should carry the cache flag.
  assert.equal(worker.calls.every((c) => c.cache === true), true);
  assert.deepEqual(result.texts, [
    "OUT:summarize: a",
    "OUT:summarize: b",
    "OUT:summarize: c",
  ]);
  assert.equal(result.stats.successCount, 3);
});

test("scatterMap can opt out of system caching", async () => {
  const worker = new ProgrammableWorker(() => "x");
  await scatterMap(worker, {
    system: "shared",
    template: "{input}",
    inputs: ["a"],
    cacheSystem: false,
  });
  assert.equal(worker.calls[0]!.cache, false);
});

test("mapReduce passes mapped joined items into the reducer template", async () => {
  const worker = new ProgrammableWorker((req, i) => {
    // First 3 calls are mappers; 4th is the reducer.
    if (i < 3) return `M${i}`;
    return `REDUCED:${req.prompt}`;
  });
  const result = await mapReduce(worker, {
    mapTemplate: "describe: {input}",
    inputs: ["x", "y", "z"],
    reduceTemplate: "summarize the following items:\n{items}",
  });
  assert.equal(worker.calls.length, 4);
  assert.deepEqual(result.mapped, ["M0", "M1", "M2"]);
  // Reducer prompt should contain joined items with the default separator.
  assert.match(worker.calls[3]!.prompt, /M0\n---\nM1\n---\nM2/);
  assert.match(result.text, /^REDUCED:/);
});

test("mapReduce honors a custom item separator", async () => {
  const worker = new ProgrammableWorker((req, i) =>
    i < 2 ? `m${i}` : `R:${req.prompt}`,
  );
  await mapReduce(worker, {
    mapTemplate: "{input}",
    inputs: ["a", "b"],
    reduceTemplate: "{items}",
    itemSeparator: " || ",
  });
  assert.match(worker.calls[2]!.prompt, /m0 \|\| m1/);
});

test("allReduce sends drafts to refine round with all drafts visible", async () => {
  const worker = new ProgrammableWorker((_req, i) => {
    if (i < 3) return `draft${i}`;
    return `refined${i - 3}`;
  });
  const result = await allReduce(worker, {
    prompts: ["q0", "q1", "q2"],
    refineTemplate:
      "Own:\n{ownDraft}\n\nAll:\n{allDrafts}\n\nProduce final.",
  });
  assert.equal(worker.calls.length, 6);
  assert.deepEqual(result.drafts, ["draft0", "draft1", "draft2"]);
  // Every refine prompt should contain all three labeled drafts.
  for (let i = 3; i < 6; i++) {
    const p = worker.calls[i]!.prompt;
    assert.match(p, /\[Worker 0\]\ndraft0/);
    assert.match(p, /\[Worker 1\]\ndraft1/);
    assert.match(p, /\[Worker 2\]\ndraft2/);
  }
  // Each worker's own draft is filled into {ownDraft}.
  assert.match(worker.calls[3]!.prompt, /Own:\ndraft0/);
  assert.match(worker.calls[4]!.prompt, /Own:\ndraft1/);
  assert.match(worker.calls[5]!.prompt, /Own:\ndraft2/);
});

test("treeReduce collapses in waves of branchFactor", async () => {
  // 17 inputs with branch factor 4 → 17 mappers, then 5 reducers (4+4+4+4+1),
  // then 2 reducers (4+1), then 1 reducer. Total 17 + 5 + 2 + 1 = 25 calls,
  // 3 levels of reduction.
  let mapCount = 0;
  let reduceCount = 0;
  const worker = new ProgrammableWorker((req) => {
    if (req.prompt.startsWith("MAP:")) {
      mapCount += 1;
      return `m${mapCount - 1}`;
    }
    reduceCount += 1;
    return `r${reduceCount - 1}`;
  });
  const result = await treeReduce(worker, {
    mapTemplate: "MAP:{input}",
    inputs: Array.from({ length: 17 }, (_, i) => `in${i}`),
    reduceTemplate: "REDUCE:{items}",
    branchFactor: 4,
  });
  assert.equal(mapCount, 17);
  // Level 1: ceil(17/4) = 5. Level 2: ceil(5/4) = 2. Level 3: ceil(2/4) = 1.
  assert.equal(reduceCount, 5 + 2 + 1);
  assert.equal(result.levels, 3);
  assert.equal(result.text, `r${reduceCount - 1}`);
});

test("treeReduce of a single input short-circuits the tree", async () => {
  const worker = new ProgrammableWorker(() => "only");
  const result = await treeReduce(worker, {
    mapTemplate: "{input}",
    inputs: ["solo"],
    reduceTemplate: "{items}",
    branchFactor: 8,
  });
  // One map call, zero reducers (current.length is already 1).
  assert.equal(worker.calls.length, 1);
  assert.equal(result.levels, 0);
  assert.equal(result.text, "only");
});
