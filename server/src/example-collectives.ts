// End-to-end orchestrator-driven example. Spins up a real Claude agent
// (Opus by default) with the collectives MCP server registered, gives it a
// fan-out task, and lets it drive scatter_map / map_reduce on its own.
//
// Run:   tsx --env-file=.env server/src/example-collectives.ts
//   or:  bun --cwd server src/example-collectives.ts
//
// The orchestrator should:
//   1. Decide to call scatter_map (or map_reduce) on the supplied list.
//   2. Receive the structured results.
//   3. Surface them back to the user in a final assistant message.

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AnthropicWorker,
  createCollectivesMcpServer,
} from "./collectives/index.js";

const ITEMS = [
  "REST APIs return resource representations over HTTP verbs.",
  "GraphQL clients fetch exactly the fields they declare.",
  "gRPC streams typed messages over HTTP/2 with protobuf.",
  "WebSockets upgrade from HTTP and stay open bidirectionally.",
  "Server-Sent Events push one-way text from server to browser.",
  "MQTT brokers pub/sub topics for IoT devices over TCP.",
  "Kafka is an append-only log of partitioned, replayable messages.",
  "NATS uses subject-based pub/sub with at-most-once delivery by default.",
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("error: ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  const worker = new AnthropicWorker({ defaultMaxTokens: 200 });
  const collectives = createCollectivesMcpServer({
    worker,
    concurrency: 8,
  });

  const itemsJson = JSON.stringify(ITEMS, null, 2);

  const prompt =
    "You have access to a `scatter_map` tool that runs the same task over " +
    "many inputs in parallel using lightweight Haiku workers. Use it to " +
    `classify each of the following ${ITEMS.length} items as either ` +
    '"request/response", "streaming", or "pub/sub". ' +
    "Pass inputs as an array of strings. " +
    "After the tool returns, summarize the counts in a single sentence.\n\n" +
    "Items:\n" +
    itemsJson;

  console.log("orchestrator: sending fan-out task to Opus...\n");

  const it = query({
    prompt,
    options: {
      model: "claude-opus-4-7",
      mcpServers: { collectives },
      allowedTools: [
        "mcp__collectives__scatter_map",
        "mcp__collectives__map_reduce",
        "mcp__collectives__all_reduce",
        "mcp__collectives__tree_reduce",
      ],
      // No filesystem / shell — this orchestrator only fans out.
      settingSources: [],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are a planning orchestrator. Prefer fan-out via the collectives tools over " +
          "answering items one-by-one. Always finish with a single short summary.",
      },
    },
  });

  for await (const msg of it) {
    switch (msg.type) {
      case "assistant": {
        const blocks = (msg as any).message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            process.stdout.write(b.text);
          } else if (b.type === "tool_use") {
            console.log(`\n[tool_use] ${b.name}`);
          }
        }
        break;
      }
      case "user": {
        const blocks = (msg as any).message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "tool_result") {
            // Truncate so the smoke output stays readable.
            const text =
              typeof b.content === "string"
                ? b.content
                : JSON.stringify(b.content).slice(0, 400);
            console.log(`\n[tool_result] ${text.slice(0, 400)}`);
          }
        }
        break;
      }
      case "result": {
        const m = msg as any;
        if (m.subtype === "success" && m.usage) {
          console.log("\n[orchestrator usage]", {
            input: m.usage.input_tokens,
            output: m.usage.output_tokens,
            cacheRead: m.usage.cache_read_input_tokens,
          });
        } else if (m.subtype !== "success") {
          console.error("\n[result error]", m.subtype, m.errors);
          process.exit(2);
        }
        break;
      }
    }
  }

  process.stdout.write("\n");
}

main().catch((err) => {
  console.error("example-collectives failed:", err);
  process.exit(1);
});
