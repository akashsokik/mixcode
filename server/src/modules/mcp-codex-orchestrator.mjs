// Stdio MCP server spawned as a child of the Codex CLI. Exposes
// orchestrator tools (`delegate_run`, `validate_run`, task/collab helpers, and
// workflow authoring) so a Codex turn can hand work off to peer agents or
// propose an approval-gated workflow DAG.
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
      "Delegate subtasks to a peer agent with `delegate_run`. Optionally use `validate_run` " +
      "when you want a peer agent to adversarially review your work and return a structured " +
      "verdict (pass / needs_changes / fail) — it is an available tool, not a required step. " +
      "If you use it, treat needs_changes and fail as work to do. " +
      "For active Claude <-> Codex collaboration, write a shared plan with `plan_create`, " +
      "start it with `collab_start`, and ask bounded peer turns with `collab_ask_peer`. " +
      "For dependency-ordered DAGs, call `workflow_add_node` once per node and " +
      "`workflow_run` to show the graph for user approval.",
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
      "Optional adversarial peer review of your just-completed work. Call this when you want " +
      "a second opinion before declaring a task done — it is not required. A peer agent " +
      "(default: the other runner) reads the actual repo state, tries to find flaws in your " +
      "claim, and returns a structured verdict (pass / fail / needs_changes) plus an issues " +
      "list. Treat fail and needs_changes as work to do.",
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

server.registerTool(
  "task_create",
  {
    description:
      "Open a new Task. Returns a taskId for task_spawn / task_await / task_done. A Task is a " +
      "named goal that groups parallel SubTasks under a single live tool card.",
    inputSchema: {
      title: z.string().min(1),
      description: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("task_create", input)),
);

server.registerTool(
  "task_spawn",
  {
    description:
      "Append SubTasks to a Task and start them in parallel under maxConcurrent. Non-blocking. " +
      "Each SubTask is a peer run via the same machinery as delegate_run.",
    inputSchema: {
      taskId: z.string(),
      subtasks: z
        .array(
          z.object({
            runner: z.enum(["claude", "codex"]),
            prompt: z.string().min(1),
            sessionId: z.string().optional(),
          }),
        )
        .min(1),
      maxConcurrent: z.number().int().min(1).max(16).default(4),
      timeoutSec: z.number().int().min(1).max(3600).default(600),
    },
  },
  async (input) => jsonContent(await callServer("task_spawn", input)),
);

server.registerTool(
  "task_await",
  {
    description:
      "Block until every non-terminal SubTask of the Task settles. Returns aggregated results.",
    inputSchema: {
      taskId: z.string(),
      timeoutSec: z.number().int().min(1).max(3600).default(1200),
    },
  },
  async (input) => jsonContent(await callServer("task_await", input)),
);

server.registerTool(
  "task_observe",
  {
    description: "Non-blocking peek at a Task's current state and partial SubTask results.",
    inputSchema: { taskId: z.string() },
  },
  async (input) => jsonContent(await callServer("task_observe", input)),
);

server.registerTool(
  "task_done",
  {
    description:
      "Mark a Task complete with an optional summary. Errors if any SubTask is still running.",
    inputSchema: {
      taskId: z.string(),
      summary: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("task_done", input)),
);

server.registerTool(
  "task_cancel",
  {
    description: "Cancel a Task and abort every running SubTask under it.",
    inputSchema: { taskId: z.string() },
  },
  async (input) => jsonContent(await callServer("task_cancel", input)),
);

server.registerTool(
  "plan_create",
  {
    description:
      "Write a shared repo-local execution plan under docs/plans/. Use before collab_start " +
      "when Claude and Codex should work from the same phased plan.",
    inputSchema: {
      title: z.string().min(1),
      goal: z.string().min(1),
      phases: z.array(z.string().min(1)).min(1),
      scope: z.string().optional(),
      risks: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
    },
  },
  async (input) => jsonContent(await callServer("plan_create", input)),
);

server.registerTool(
  "plan_read",
  {
    description: "Read a shared repo-local plan by planId or docs/plans path.",
    inputSchema: {
      planId: z.string().optional(),
      path: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("plan_read", input)),
);

server.registerTool(
  "collab_start",
  {
    description:
      "Start a bounded Claude <-> Codex collaboration from a shared plan. The active runner leads.",
    inputSchema: {
      planId: z.string().optional(),
      path: z.string().optional(),
      maxPeerTurns: z.number().int().min(1).max(32).default(8),
    },
  },
  async (input) => jsonContent(await callServer("collab_start", input)),
);

server.registerTool(
  "collab_send",
  {
    description:
      "Append a note, request, response, decision, or phase summary to a collaboration run.",
    inputSchema: {
      collabId: z.string(),
      kind: z.enum(["note", "request", "response", "decision", "phase_summary"]),
      body: z.string().min(1),
      phaseId: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("collab_send", input)),
);

server.registerTool(
  "collab_ask_peer",
  {
    description:
      "Ask the peer runner for one bounded collaboration turn: review, proposal, verification, " +
      "or a clearly scoped implementation slice.",
    inputSchema: {
      collabId: z.string(),
      request: z.string().min(1),
      role: z.enum(["review", "propose", "verify", "implement"]).default("review"),
      phaseId: z.string().optional(),
      timeoutSec: z.number().int().min(1).max(600).default(180),
      maxTurns: z.number().int().min(1).max(60).optional(),
    },
  },
  async (input) => jsonContent(await callServer("collab_ask_peer", input)),
);

server.registerTool(
  "collab_observe",
  {
    description: "Observe a collaboration run's current phase/message/decision counts.",
    inputSchema: { collabId: z.string() },
  },
  async (input) => jsonContent(await callServer("collab_observe", input)),
);

server.registerTool(
  "phase_start",
  {
    description: "Mark a collaboration phase as running. Omitting phaseId starts the next pending phase.",
    inputSchema: {
      collabId: z.string(),
      phaseId: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("phase_start", input)),
);

server.registerTool(
  "phase_done",
  {
    description: "Mark a collaboration phase as done with an optional summary.",
    inputSchema: {
      collabId: z.string(),
      phaseId: z.string(),
      summary: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("phase_done", input)),
);

server.registerTool(
  "phase_handoff",
  {
    description: "Change a phase owner and optionally make that owner the collaboration lead.",
    inputSchema: {
      collabId: z.string(),
      phaseId: z.string(),
      owner: z.enum(["claude", "codex"]),
      makeLead: z.boolean().default(false),
      note: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("phase_handoff", input)),
);

server.registerTool(
  "collab_finish",
  {
    description: "Mark a collaboration run complete.",
    inputSchema: {
      collabId: z.string(),
      summary: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("collab_finish", input)),
);

server.registerTool(
  "collab_cancel",
  {
    description: "Cancel a collaboration run and abort any in-flight peer turn.",
    inputSchema: { collabId: z.string() },
  },
  async (input) => jsonContent(await callServer("collab_cancel", input)),
);

server.registerTool(
  "workflow_add_node",
  {
    description:
      "Add one node to the workflow DAG you are assembling. A node is a single isolated agent run. Dependencies receive only upstream final output text, injected by the engine.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().min(1),
      runner: z.enum(["claude", "codex", "vercel", "ollama"]),
      model: z.string().min(1).optional(),
      prompt: z.string().min(1),
      dependsOn: z.array(z.string()).optional(),
    },
  },
  async (input) => jsonContent(await callServer("workflow_add_node", input)),
);

server.registerTool(
  "workflow_run",
  {
    description:
      "Finalize the workflow DAG assembled with workflow_add_node and propose it for user approval. Do not run the nodes yourself.",
    inputSchema: {
      goal: z.string().min(1),
    },
  },
  async (input) => jsonContent(await callServer("workflow_run", input)),
);

server.registerTool(
  "workflow_reset",
  {
    description: "Discard the workflow DAG draft you have been assembling.",
    inputSchema: {},
  },
  async (input) => jsonContent(await callServer("workflow_reset", input)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
