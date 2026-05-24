// Collective primitives for fan-out over many lightweight Claude workers.
//
// See ./worker.ts for the per-call substrate (raw messages.create with
// retries + prompt caching) and ./primitives.ts for scatterMap / mapReduce /
// allReduce / treeReduce. The MCP wrapper in ./mcp.ts exposes the same
// operations to an orchestrator agent via createCollectivesMcpServer().

export {
  AnthropicWorker,
  type Worker,
  type WorkerRequest,
  type WorkerResult,
  type AnthropicWorkerOptions,
} from "./worker.js";

export {
  WorkerPool,
  unwrapText,
  aggregateUsage,
  type PoolResult,
  type PoolOptions,
} from "./pool.js";

export {
  scatter,
  scatterMap,
  mapReduce,
  allReduce,
  treeReduce,
  type ScatterMapRequest,
  type MapReduceRequest,
  type AllReduceRequest,
  type TreeReduceRequest,
  type ScatterOptions,
  type CollectiveStats,
} from "./primitives.js";

export {
  createCollectivesMcpServer,
  type CollectivesMcpOptions,
} from "./mcp.js";

export { getCollectivesMcpServer, COLLECTIVES_ALLOWED_TOOLS } from "./runtime.js";
