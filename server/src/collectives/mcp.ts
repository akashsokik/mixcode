// In-process MCP server exposing the collective primitives as tools an
// orchestrator agent can call. Wire it into the Agent SDK by passing the
// returned config into `query({ options: { mcpServers: { collectives: ... } } })`.
//
// Each tool returns a JSON CallToolResult with the primitive's payload —
// results, aggregate token usage, and any partial failures. The orchestrator
// sees one tool call → one structured response, not 200 streams of
// intermediate noise (which would blow its context window).

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Worker } from "./worker.js";
import {
  scatterMap,
  mapReduce,
  allReduce,
  treeReduce,
  type CollectiveStats,
} from "./primitives.js";

export type CollectivesMcpOptions = {
  worker: Worker;
  // Concurrency cap shared across all tool invocations. Defaults to 15
  // (the API's per-key concurrent-request limit).
  concurrency?: number;
  // If true, the tools return per-task error detail when some workers fail
  // instead of throwing. Default true — partial failures are recoverable
  // and the orchestrator can decide what to do.
  tolerantPartialFailures?: boolean;
};

const INSTRUCTIONS =
  "Collective primitives for spinning up many lightweight Claude workers in parallel. " +
  "These are SINGLE-SHOT completions, not agent loops — use them for fan-out summarization, " +
  "extraction, scoring, consensus, etc. Available tools: " +
  "`scatter_map` (run one template over many inputs), " +
  "`map_reduce` (fan out then reduce to one result), " +
  "`all_reduce` (each worker drafts, sees all drafts, refines), " +
  "`tree_reduce` (hierarchical reduce when the fan-in is too big for one reducer). " +
  "All tools share a global concurrency cap and return aggregate token-usage stats so you " +
  "can budget further fan-out. Prefer these over spawning subagents when each task is a " +
  "self-contained completion that doesn't need tool use.";

export function createCollectivesMcpServer(opts: CollectivesMcpOptions) {
  const { worker } = opts;
  const concurrency = opts.concurrency ?? 15;
  const tolerant = opts.tolerantPartialFailures ?? true;

  return createSdkMcpServer({
    name: "collectives",
    version: "0.1.0",
    instructions: INSTRUCTIONS,
    tools: [
      tool(
        "scatter_map",
        "Run the same task template over N inputs in parallel and return all results. " +
          "The template must contain `{input}` — it is substituted per worker. " +
          "Use when you want to apply one operation (summarize, score, classify, extract) " +
          "to many items and see every result.",
        {
          system: z
            .string()
            .optional()
            .describe(
              "Shared system prompt across all workers. Automatically prompt-cached — at scale " +
                "this is what makes fan-out economical (90% off repeat input tokens).",
            ),
          template: z
            .string()
            .min(1)
            .describe(
              "Per-worker user prompt. Must contain `{input}`, which is replaced by each item in `inputs`.",
            ),
          inputs: z
            .array(z.string())
            .min(1)
            .max(500)
            .describe("Inputs to fan out over. One worker per item."),
          model: z
            .string()
            .optional()
            .describe(
              "Worker model. Defaults to claude-haiku-4-5 (cheap fan-out). Use a larger " +
                "model only if the per-item task actually needs one.",
            ),
          maxTokens: z
            .number()
            .int()
            .min(1)
            .max(8192)
            .optional()
            .describe("Per-worker max output tokens. Default 1024."),
        },
        async (input): Promise<CallToolResult> => {
          const result = await scatterMap(
            worker,
            {
              system: input.system,
              template: input.template,
              inputs: input.inputs,
              model: input.model,
              maxTokens: input.maxTokens,
            },
            { concurrency, throwOnError: !tolerant },
          );
          return jsonResult({
            texts: result.texts,
            stats: result.stats,
            partialFailures: collectFailures(result.results),
          });
        },
      ),
      tool(
        "map_reduce",
        "Fan out a map task over N inputs, then reduce all results to a single output via a " +
          "reducer prompt. Use when you want a *consolidated* answer (themes, summary, ranked " +
          "list) rather than per-item results. The reducer can use a smarter model than the mappers.",
        {
          mapSystem: z.string().optional(),
          mapTemplate: z
            .string()
            .min(1)
            .describe("Per-mapper user prompt. Must contain `{input}`."),
          inputs: z.array(z.string()).min(1).max(500),
          reduceSystem: z.string().optional(),
          reduceTemplate: z
            .string()
            .min(1)
            .describe(
              "Reducer user prompt. Must contain `{items}`, which is replaced by the joined " +
                "mapper outputs.",
            ),
          mapModel: z.string().optional().describe("Defaults to claude-haiku-4-5."),
          reduceModel: z
            .string()
            .optional()
            .describe(
              "Reducer model. Defaults to whatever mapModel resolves to; consider passing a " +
                "larger model (e.g. claude-sonnet-4-6) for the reducer.",
            ),
          mapMaxTokens: z.number().int().min(1).max(8192).optional(),
          reduceMaxTokens: z.number().int().min(1).max(16384).optional(),
        },
        async (input): Promise<CallToolResult> => {
          const result = await mapReduce(
            worker,
            {
              mapSystem: input.mapSystem,
              mapTemplate: input.mapTemplate,
              inputs: input.inputs,
              reduceSystem: input.reduceSystem,
              reduceTemplate: input.reduceTemplate,
              mapModel: input.mapModel,
              reduceModel: input.reduceModel,
              mapMaxTokens: input.mapMaxTokens,
              reduceMaxTokens: input.reduceMaxTokens,
            },
            { concurrency, throwOnError: !tolerant },
          );
          return jsonResult({
            text: result.text,
            stats: result.stats,
            mapped: result.mapped,
          });
        },
      ),
      tool(
        "all_reduce",
        "Two-round consensus. Each worker drafts an answer from its own prompt, then every " +
          "worker is shown ALL drafts and asked to refine. Returns the refined outputs. " +
          "Use for multi-agent debate, ensemble reasoning, or consensus building.",
        {
          system: z.string().optional(),
          prompts: z
            .array(z.string())
            .min(2)
            .max(50)
            .describe("One prompt per worker for the draft round."),
          refineTemplate: z
            .string()
            .min(1)
            .describe(
              "Refine-round user prompt. Must contain `{ownDraft}` (this worker's first " +
                "answer) and `{allDrafts}` (all drafts, labeled by worker index).",
            ),
          model: z.string().optional(),
          maxTokens: z.number().int().min(1).max(8192).optional(),
        },
        async (input): Promise<CallToolResult> => {
          const result = await allReduce(
            worker,
            {
              system: input.system,
              prompts: input.prompts,
              refineTemplate: input.refineTemplate,
              model: input.model,
              maxTokens: input.maxTokens,
            },
            { concurrency, throwOnError: !tolerant },
          );
          return jsonResult({
            refined: result.refined,
            drafts: result.drafts,
            stats: result.stats,
          });
        },
      ),
      tool(
        "tree_reduce",
        "Hierarchical map-reduce for when the mapped outputs are too many to fit one reducer's " +
          "context. Maps in parallel, then collapses in waves of `branchFactor` until one result " +
          "remains. Use when fanning out over hundreds of items.",
        {
          mapSystem: z.string().optional(),
          mapTemplate: z.string().min(1).describe("Must contain `{input}`."),
          inputs: z.array(z.string()).min(1).max(2000),
          reduceSystem: z.string().optional(),
          reduceTemplate: z.string().min(1).describe("Must contain `{items}`."),
          branchFactor: z
            .number()
            .int()
            .min(2)
            .max(32)
            .default(8)
            .describe("How many siblings each reducer call merges. Default 8."),
          mapModel: z.string().optional(),
          reduceModel: z.string().optional(),
          mapMaxTokens: z.number().int().min(1).max(8192).optional(),
          reduceMaxTokens: z.number().int().min(1).max(16384).optional(),
        },
        async (input): Promise<CallToolResult> => {
          const result = await treeReduce(
            worker,
            {
              mapSystem: input.mapSystem,
              mapTemplate: input.mapTemplate,
              inputs: input.inputs,
              reduceSystem: input.reduceSystem,
              reduceTemplate: input.reduceTemplate,
              branchFactor: input.branchFactor,
              mapModel: input.mapModel,
              reduceModel: input.reduceModel,
              mapMaxTokens: input.mapMaxTokens,
              reduceMaxTokens: input.reduceMaxTokens,
            },
            { concurrency, throwOnError: !tolerant },
          );
          return jsonResult({
            text: result.text,
            levels: result.levels,
            stats: result.stats,
          });
        },
      ),
    ],
  });
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function collectFailures(
  results: Array<{ ok: boolean; index: number; error?: unknown }>,
): Array<{ index: number; error: string }> {
  const out: Array<{ index: number; error: string }> = [];
  for (const r of results) {
    if (!r.ok) {
      out.push({
        index: r.index,
        error: r.error instanceof Error ? r.error.message : String(r.error),
      });
    }
  }
  return out;
}

// Re-export for convenience: usage stats type is part of the tool result.
export type { CollectiveStats };
