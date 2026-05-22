// Stdio MCP server spawned as a child of the Codex CLI. Exposes
// `delegate_run` / `get_run` / `cancel_run` / `validate_run` so a Codex turn
// can hand work off to a peer agent (e.g. ask Claude to do something).
//
// We can't share memory with the parent Hono server (separate process), so
// every tool call proxies via HTTP to `POST <ORCHESTRATOR_URL>/internal/delegate`.
// The parent server runs the actual peer turn in-process and returns the
// result, which we wrap as an MCP CallToolResult.
//
// Env supplied by codex.ts via mcp_servers.<name>.env:
//   ORCHESTRATOR_URL      base URL of the Hono server, e.g. http://127.0.0.1:4567
//   ORCHESTRATOR_TOKEN    shared secret sent as x-delegate-token
//   PARENT_SESSION_ID     the user-facing session this codex turn belongs to
//   PARENT_RUNNER         "codex" (so the depth/self-delegation guards work)
//   PARENT_CWD            working directory the peer should inherit
//   DELEGATION_DEPTH      current depth, integer string (incremented per hop)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_BASE = process.env.ORCHESTRATOR_URL;
const TOKEN = process.env.ORCHESTRATOR_TOKEN;
const PARENT_SESSION_ID = process.env.PARENT_SESSION_ID;
const PARENT_RUNNER = process.env.PARENT_RUNNER ?? "codex";
const PARENT_CWD = process.env.PARENT_CWD ?? process.cwd();
const DEPTH = Number.parseInt(process.env.DELEGATION_DEPTH ?? "0", 10);

if (!URL_BASE || !TOKEN || !PARENT_SESSION_ID) {
  // The codex CLI captures stderr but doesn't render it inline; still useful
  // when running with --verbose / inspecting logs.
  process.stderr.write(
    "[mcp-codex-orchestrator] missing ORCHESTRATOR_URL / ORCHESTRATOR_TOKEN / PARENT_SESSION_ID env\n",
  );
  process.exit(1);
}

async function callServer(action, args) {
  const res = await fetch(`${URL_BASE}/internal/delegate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delegate-token": TOKEN,
    },
    body: JSON.stringify({
      action,
      parentRunner: PARENT_RUNNER,
      parentSessionId: PARENT_SESSION_ID,
      parentCwd: PARENT_CWD,
      depth: DEPTH,
      args,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      payload: { error: `orchestrator http ${res.status}: ${text || res.statusText}` },
    };
  }
  return res.json();
}

function jsonContent({ ok, payload }) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: !ok,
  };
}

const server = new McpServer(
  {
    name: "orchestrator",
    version: "0.1.0",
  },
  {
    // MCP server instructions — surfaced to the model alongside the tool
    // descriptions so the Codex agent knows when to call validate_run.
    instructions:
      "Delegate subtasks to a peer agent with `delegate_run`. Use `validate_run` " +
      "as your FINAL step before declaring a task complete: a peer agent " +
      "adversarially reviews your work and returns a structured verdict " +
      "(pass / needs_changes / fail). Treat needs_changes and fail as work to do.",
  },
);

server.registerTool(
  "delegate_run",
  {
    description:
      "Spawn a peer agent (claude or codex) with a natural-language prompt. " +
      "By default waits for completion and returns the peer's final text. " +
      "Set wait=false to return immediately with a runId you can poll via get_run.",
    inputSchema: {
      profileName: z.enum(["claude", "codex"]),
      prompt: z.string().min(1),
      sessionId: z.string().optional(),
      wait: z.boolean().default(true),
      timeoutSec: z.number().int().min(1).max(600).default(120),
    },
  },
  async (input) => jsonContent(await callServer("delegate_run", input)),
);

server.registerTool(
  "get_run",
  {
    description:
      "Fetch the current status (and result, if finished) of a peer run started with delegate_run.",
    inputSchema: { runId: z.string() },
  },
  async (input) => jsonContent(await callServer("get_run", input)),
);

server.registerTool(
  "cancel_run",
  {
    description:
      "Cancel a peer run started with delegate_run. No-op if it has already finished.",
    inputSchema: { runId: z.string() },
  },
  async (input) => jsonContent(await callServer("cancel_run", input)),
);

server.registerTool(
  "validate_run",
  {
    description:
      "Adversarial peer review of your just-completed work. Call this as the FINAL step " +
      "before declaring a task done. A peer agent (default: the other runner) reads the " +
      "actual repo state, tries to find flaws in your claim, and returns a structured " +
      "verdict (pass / fail / needs_changes) plus an issues list. Treat fail and " +
      "needs_changes as work to do.",
    inputSchema: {
      peer: z.enum(["claude", "codex"]).optional(),
      claim: z.string().min(1),
      context: z.string().optional(),
      files: z.array(z.string()).max(20).optional(),
      focus: z.string().optional(),
      timeoutSec: z.number().int().min(1).max(600).default(180),
    },
  },
  async (input) => jsonContent(await callServer("validate_run", input)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
