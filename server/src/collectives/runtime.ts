// Process-wide singleton wiring for the collectives MCP server.
//
// We share one Worker (and therefore one global concurrency cap) across
// every session — the 15-concurrent-requests ceiling is per API key, so
// counting per-session would over-fan-out at scale. The MCP server itself
// is stateless beyond the worker, so it can also be shared.
//
// Concurrency is tunable via MIXCODE_COLLECTIVES_CONCURRENCY (default 15).
// Worker model defaults to Haiku 4.5 (cheap fan-out); per-call overrides
// flow through the tool's `model` parameter.

import { AnthropicWorker } from "./worker.js";
import { createCollectivesMcpServer } from "./mcp.js";

let cached: ReturnType<typeof createCollectivesMcpServer> | null = null;

export function getCollectivesMcpServer(): ReturnType<typeof createCollectivesMcpServer> {
  if (cached) return cached;
  const concurrency = parsePositiveInt(
    process.env.MIXCODE_COLLECTIVES_CONCURRENCY,
    15,
  );
  const worker = new AnthropicWorker();
  cached = createCollectivesMcpServer({ worker, concurrency });
  return cached;
}

// The bare tool names the SDK will accept under allowedTools. The MCP
// server name (`collectives`) is the prefix the Agent SDK adds.
export const COLLECTIVES_ALLOWED_TOOLS = [
  "mcp__collectives__scatter_map",
  "mcp__collectives__map_reduce",
  "mcp__collectives__all_reduce",
  "mcp__collectives__tree_reduce",
];

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
