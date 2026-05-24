// Live smoke test for the collectives library. Hits the real Anthropic
// API — set ANTHROPIC_API_KEY first.
//
// Run:   tsx --env-file=.env server/src/smoke-collectives.ts
//   or:  bun --cwd server src/smoke-collectives.ts
//
// What it does:
//   1. Constructs an AnthropicWorker (Haiku 4.5 default).
//   2. Runs scatterMap over a tiny set of inputs (8 short strings).
//   3. Runs mapReduce over the same inputs to produce a single summary.
//   4. Prints aggregate token usage + cache-hit stats.
//
// The whole script should finish in ~10s and cost a couple of cents.

import { AnthropicWorker, scatterMap, mapReduce, treeReduce } from "./collectives/index.js";

const inputs = [
  "The early bird catches the worm.",
  "A watched pot never boils.",
  "Actions speak louder than words.",
  "Don't count your chickens before they hatch.",
  "Every cloud has a silver lining.",
  "Fortune favors the bold.",
  "A penny saved is a penny earned.",
  "When in Rome, do as the Romans do.",
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("error: ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  const worker = new AnthropicWorker({ defaultMaxTokens: 80 });

  console.log("\n=== scatterMap (fan-out, return all) ===");
  const t0 = Date.now();
  const s = await scatterMap(worker, {
    system:
      "You are a terse literary critic. Reply with exactly one short sentence — no preamble, no quotes.",
    template: "Rewrite this proverb in modern slang: {input}",
    inputs,
  });
  const elapsedScatter = Date.now() - t0;
  for (let i = 0; i < s.texts.length; i++) {
    console.log(`  [${i}] ${s.texts[i]}`);
  }
  console.log("  stats:", s.stats, `elapsed=${elapsedScatter}ms`);

  console.log("\n=== mapReduce (fan-out, then consolidate) ===");
  const t1 = Date.now();
  const m = await mapReduce(worker, {
    mapSystem: "You are a terse summarizer. One sentence per item.",
    mapTemplate: "What is the core lesson of this proverb? {input}",
    inputs,
    reduceSystem: "You are an essayist.",
    reduceTemplate:
      "Here are several core lessons:\n{items}\n\n" +
      "Identify the 3 most common themes. Reply as a numbered list, one line each.",
    reduceMaxTokens: 200,
  });
  console.log(m.text);
  console.log("  stats:", m.stats, `elapsed=${Date.now() - t1}ms`);

  console.log("\n=== treeReduce (hierarchical, branchFactor=3) ===");
  const t2 = Date.now();
  const tr = await treeReduce(worker, {
    mapTemplate: "Give one keyword that captures this proverb: {input}",
    inputs,
    reduceTemplate:
      "Merge these keywords into a single concept phrase (2-4 words):\n{items}",
    branchFactor: 3,
    reduceMaxTokens: 60,
  });
  console.log(`  text: ${tr.text}`);
  console.log(`  levels: ${tr.levels}`);
  console.log("  stats:", tr.stats, `elapsed=${Date.now() - t2}ms`);
}

main().catch((err) => {
  console.error("smoke-collectives failed:", err);
  process.exit(1);
});
