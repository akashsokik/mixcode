import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { nanoid } from "nanoid";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

// Set by startServer() once the listener is bound. Reads of this from
// request handlers (e.g. the codex orchestrator URL) always happen after
// the server is up, so the lazy binding is safe.
let boundPort = 0;
import type {
  ClientMsg,
  ConsensusReady,
  ContextUsage,
  DelegationStats,
  RunEvent,
  RunnerKind,
  ServerMsg,
  SessionSkillEntry,
  TurnUsage,
  WorkflowRun,
} from "../../shared/events.js";
import { SessionManager } from "./sessions.js";
import { resolveEffortInfo } from "./effort-capability.js";
import { clampEffort } from "../../shared/effort.js";
import { runClaude } from "./runners/claude.js";
import { runCodex } from "./runners/codex.js";
import { runVercel } from "./runners/vercel.js";
import { runOllama, listOllamaModels } from "./runners/ollama.js";
import type { ModelMessage } from "ai";
import {
  buildDelegateMcpServer,
  cancelRunsForSession,
  clearDelegationStats,
  executeCancelRun,
  executeDelegate,
  executeGetRun,
  registerParentCallbacks,
  unregisterParentCallbacks,
} from "./runners/delegate.js";
import { executeValidate } from "./runners/validate.js";
import {
  awaitTask,
  cancelTask,
  cancelTasksForSession,
  clearTasksForSession,
  createTask,
  doneTask,
  observeTask,
  registerTaskEmitter,
  spawnSubtasks,
  unregisterTaskEmitter,
} from "./orchestrator/tasks.js";
import {
  askPeer,
  cancelCollab,
  cancelCollabsForSession,
  clearCollabsForSession,
  donePhase,
  finishCollab,
  handoffPhase,
  observeCollab,
  readPlan,
  registerCollabEmitter,
  sendCollabMessage,
  startCollab,
  startPhase,
  unregisterCollabEmitter,
  writePlan,
  type CollabMessageKind,
  type PeerRole,
} from "./orchestrator/collab.js";
import {
  clearConsensusReady,
  getConsensusReady,
  runConsensus,
  setConsensusReady,
} from "./orchestrator/consensus.js";
import {
  cancelWorkflowRuns,
  clearWorkflowRun,
  createRealDispatcher,
  buildWorkflowCompletionContext,
  getWorkflowRun,
  isWorkflowActive,
  runWorkflow,
  setWorkflowRun,
  withWorkflowCompletionContext,
  type WorkflowController,
} from "./orchestrator/workflow.js";
import { clearDraft } from "./orchestrator/workflow-draft.js";
import {
  executeWorkflowAddNode,
  executeWorkflowReset,
  executeWorkflowRun,
  type WorkflowAddNodeInput,
} from "./orchestrator/workflow-tools.js";
import { PermissionStore } from "./permissions.js";
import { gitInfoEquals, readGitInfo } from "./git.js";
import { buildPeerEventForwarder } from "./orchestrator/peer-forwarding.js";

// Shared secret used to authenticate the Codex-side MCP child's HTTP
// callbacks. Generated once per server start; rotates on restart.
const ORCHESTRATOR_TOKEN = nanoid();
// Absolute path to the stdio MCP server spawned as a child of Codex CLI.
// Resolved relative to this file so it works whether tsx is run from the
// repo root, the server workspace, or via the bin/start.mjs launcher.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SCRIPT_PATH = path.join(
  __dirname,
  "modules",
  "mcp-codex-orchestrator.mjs",
);

// Appended to the Claude SDK's system prompt for every turn. Tells the agent
// that validate_run is available as an option — not a required step. The model
// decides whether to use it; nothing here forces a validation pass.
const ADVERSARIA_SYSTEM_PROMPT_APPEND =
  "The `validate_run` tool is available if you want a peer agent to " +
  "adversarially review your work: pass a concise `claim` describing what you " +
  "did and it returns a verdict (pass / needs_changes / fail) plus an issues " +
  "list. Using it is optional and entirely your choice — it is not required " +
  "before declaring a task complete. If you do use it, treat needs_changes " +
  "and fail as work to do.";

const sessions = new SessionManager();
const permissions = new PermissionStore();
// Map sessionId -> AbortController for the in-flight turn, so deleting a
// session or starting a new turn can cancel pending permission prompts.
const turnAborts = new Map<string, AbortController>();
// Map sessionId -> the live WorkflowController for an approved+running
// workflow. The engine's per-session run store (getWorkflowRun) holds the
// snapshot for replay; this holds the scheduler handle so workflow_cancel /
// /clear / delete_session can reach controller.cancel() (which aborts
// in-flight node runs, marks pending nodes skipped, and emits the terminal
// snapshot). Populated at approve, deleted when the run settles. One active
// workflow per session, so a single entry suffices - mirrors the consensus
// per-session model rather than a workflowId-keyed registry.
const workflowControllers = new Map<string, WorkflowController>();
// Map sessionId -> last SDK-reported skill listing, tagged with the runner
// that produced it. Populated when the Claude runner sees its `system init`
// message (so it's empty until the first turn). Codex doesn't expose an
// equivalent stream — its sessions stay unset and the TUI falls back to its
// filesystem walk. The runner tag lets the client ignore stale entries when
// the user switches runners mid-session.
const sessionSkills = new Map<
  string,
  { runner: RunnerKind; entries: SessionSkillEntry[] }
>();

function resolveSessionSkills(
  runner: RunnerKind,
  skills: string[],
  _plugins: { name: string; path: string }[],
): SessionSkillEntry[] {
  // _plugins is reserved for future description resolution out of the plugin
  // cache. The current palette only needs name + classification.
  const fsSkillsDir = path.join(homedir(), runner === "claude" ? ".claude" : ".codex", "skills");
  const out: SessionSkillEntry[] = [];
  for (const raw of skills) {
    if (typeof raw !== "string" || !raw) continue;
    const colon = raw.indexOf(":");
    if (colon > 0) {
      out.push({
        name: raw,
        source: "sdk",
        pluginName: raw.slice(0, colon),
        isFsRemovable: false,
      });
      continue;
    }
    // Bare name: removable only when it lives as a symlink under the user's
    // skills dir. Built-in CLI skills and project-local skills won't qualify.
    let removable = false;
    const target = path.join(fsSkillsDir, raw);
    try {
      removable = existsSync(target) && lstatSync(target).isSymbolicLink();
    } catch {
      removable = false;
    }
    out.push({ name: raw, source: "sdk", isFsRemovable: removable });
  }
  // Stable order — names already come in SDK order, but sort so two clients
  // looking at the same session see the same palette regardless of init race.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function updateSessionSkills(
  sessionId: string,
  runner: RunnerKind,
  skills: string[],
  plugins: { name: string; path: string }[],
): void {
  const entries = resolveSessionSkills(runner, skills, plugins);
  sessionSkills.set(sessionId, { runner, entries });
  sessions.broadcast({ type: "session_skills", sessionId, runner, skills: entries });
}

// Resolve the active runner+model effort capability and attach it to the
// session so the TUI slider can render it. Fire-and-forget: the Anthropic path
// is async but cached, and a failure just yields empty levels.
function refreshEffortInfo(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  const modelOverride = s.models[s.activeRunner];
  void resolveEffortInfo(s.activeRunner, modelOverride)
    .then((info) => {
      // Re-fetch — the session may have changed runner/model while awaiting.
      // Guard on BOTH runner and the model override we resolved against, so a
      // mid-flight model switch on the same runner can't overwrite the new
      // model's effortInfo with the old model's levels.
      const cur = sessions.get(sessionId);
      if (
        cur &&
        cur.activeRunner === s.activeRunner &&
        cur.models[s.activeRunner] === modelOverride
      ) {
        sessions.setEffortInfo(sessionId, info);
      }
    })
    .catch(() => {});
}

permissions.bind({
  onChange: (rules) => sessions.broadcast({ type: "permissions", rules }),
  onRequest: (request) =>
    sessions.broadcast({ type: "permission_request", request }),
  onResolved: (requestId) =>
    sessions.broadcast({ type: "permission_resolved", requestId }),
});

// Poll git state for every known session on a single interval. Cheaper than
// per-session timers and trivially cancellable.
const GIT_POLL_MS = 5000;
async function refreshGit(): Promise<void> {
  const snapshot = sessions.list();
  await Promise.all(
    snapshot.map(async (s) => {
      const next = await readGitInfo(s.cwd).catch(() => null);
      const current = sessions.get(s.id);
      if (!current) return;
      if (!gitInfoEquals(current.git, next)) sessions.setGit(s.id, next);
    }),
  );
}
setInterval(() => {
  refreshGit().catch(() => {});
}, GIT_POLL_MS).unref();
// Kick off an immediate pass so brand-new sessions show git info quickly.
refreshGit().catch(() => {});

// First session is created by the TUI on connect so it carries the client's
// cwd, not the server's. The server's cwd is a stale fallback if the client
// neglects to send one.

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// Live Ollama model list for the TUI picker. The server owns the daemon
// connection (OLLAMA_BASE_URL), so it does the query and hands the TUI a plain
// list. Daemon-down returns 200 with an `error` field so the picker can render
// a clean message instead of treating it as a transport failure.
app.get("/ollama/models", async (c) => {
  try {
    const models = await listOllamaModels();
    return c.json({ models });
  } catch (err) {
    return c.json({
      models: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Internal callback endpoint hit by the stdio MCP child spawned for Codex
// turns. The child runs in a separate process so it can't reach our delegate
// state directly — it proxies tool calls through this endpoint, which
// dispatches to the same execute* functions the in-process Claude SDK MCP
// server uses. Auth via shared-secret header (ORCHESTRATOR_TOKEN).
app.post("/internal/delegate", async (c) => {
  if (c.req.header("x-delegate-token") !== ORCHESTRATOR_TOKEN) {
    return c.json({ ok: false, payload: { error: "unauthorized" } }, 401);
  }
  let body: {
    action?: string;
    parentRunner?: RunnerKind;
    parentSessionId?: string;
    parentCwd?: string;
    depth?: number;
    args?: Record<string, unknown>;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ ok: false, payload: { error: "invalid json" } }, 400);
  }
  const action = body.action;
  const args = body.args ?? {};

  if (action === "delegate_run") {
    if (!body.parentRunner || !body.parentSessionId || !body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const result = await executeDelegate(
      {
        profileName: args.profileName as RunnerKind,
        prompt: String(args.prompt ?? ""),
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
        wait: args.wait !== false,
        timeoutSec:
          typeof args.timeoutSec === "number" && Number.isFinite(args.timeoutSec)
            ? args.timeoutSec
            : 120,
      },
      {
        parentRunner: body.parentRunner,
        parentSessionId: body.parentSessionId,
        parentCwd: body.parentCwd,
        depth: typeof body.depth === "number" ? body.depth : 0,
      },
    );
    return c.json(result);
  }
  if (action === "get_run") {
    return c.json(executeGetRun(String(args.runId ?? "")));
  }
  if (action === "cancel_run") {
    return c.json(executeCancelRun(String(args.runId ?? "")));
  }
  if (action === "validate_run") {
    if (!body.parentRunner || !body.parentSessionId || !body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const filesIn = args.files;
    const files = Array.isArray(filesIn)
      ? filesIn.filter((f): f is string => typeof f === "string")
      : undefined;
    const result = await executeValidate(
      {
        peer:
          args.peer === "claude" || args.peer === "codex"
            ? (args.peer as RunnerKind)
            : undefined,
        claim: String(args.claim ?? ""),
        context: typeof args.context === "string" ? args.context : undefined,
        files,
        focus: typeof args.focus === "string" ? args.focus : undefined,
        timeoutSec:
          typeof args.timeoutSec === "number" && Number.isFinite(args.timeoutSec)
            ? args.timeoutSec
            : 180,
      },
      {
        parentRunner: body.parentRunner,
        parentSessionId: body.parentSessionId,
        parentCwd: body.parentCwd,
        depth: typeof body.depth === "number" ? body.depth : 0,
      },
    );
    return c.json(result);
  }
  if (action === "workflow_add_node") {
    if (!body.parentSessionId) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const dependsOnIn = args.dependsOn;
    const dependsOn = Array.isArray(dependsOnIn)
      ? dependsOnIn.filter((d): d is string => typeof d === "string")
      : undefined;
    const result = executeWorkflowAddNode(
      {
        id: String(args.id ?? ""),
        title: String(args.title ?? ""),
        runner: args.runner as RunnerKind,
        model: typeof args.model === "string" ? args.model : undefined,
        prompt: String(args.prompt ?? ""),
        dependsOn,
      } satisfies WorkflowAddNodeInput,
      { parentSessionId: body.parentSessionId },
    );
    return c.json(result);
  }
  if (action === "workflow_run") {
    if (!body.parentRunner || !body.parentSessionId) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const result = executeWorkflowRun(
      { goal: String(args.goal ?? "") },
      {
        parentSessionId: body.parentSessionId,
        parentRunner: body.parentRunner,
        onWorkflowProposed: (run) =>
          handleWorkflowProposed(body.parentSessionId!, run),
      },
    );
    return c.json(result);
  }
  if (action === "workflow_reset") {
    if (!body.parentSessionId) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    return c.json(
      executeWorkflowReset({ parentSessionId: body.parentSessionId }),
    );
  }
  if (action === "task_create") {
    if (!body.parentSessionId) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const task = createTask({
      sessionId: body.parentSessionId,
      title: String(args.title ?? ""),
      description:
        typeof args.description === "string" ? args.description : undefined,
    });
    return c.json({ ok: true, payload: { taskId: task.id } });
  }
  if (action === "task_spawn") {
    if (!body.parentRunner || !body.parentSessionId || !body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const subtasksIn = Array.isArray(args.subtasks) ? args.subtasks : [];
    const subtasks = subtasksIn.map((s: Record<string, unknown>) => ({
      runner: s.runner as RunnerKind,
      prompt: String(s.prompt ?? ""),
      sessionId: typeof s.sessionId === "string" ? s.sessionId : undefined,
    }));
    const r = spawnSubtasks(
      String(args.taskId ?? ""),
      subtasks,
      {
        parentRunner: body.parentRunner,
        parentCwd: body.parentCwd,
        depth: (typeof body.depth === "number" ? body.depth : 0) + 1,
        timeoutSec:
          typeof args.timeoutSec === "number" ? args.timeoutSec : 600,
      },
      {
        maxConcurrent:
          typeof args.maxConcurrent === "number" ? args.maxConcurrent : 4,
      },
    );
    if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
    return c.json({ ok: true, payload: { subtaskIds: r.subtaskIds } });
  }
  if (action === "task_await") {
    const r = await awaitTask(String(args.taskId ?? ""), {
      timeoutSec:
        typeof args.timeoutSec === "number" ? args.timeoutSec : 1200,
    });
    if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
    return c.json({ ok: true, payload: r });
  }
  if (action === "task_observe") {
    const r = observeTask(String(args.taskId ?? ""));
    if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
    return c.json({ ok: true, payload: { snapshot: r.snapshot } });
  }
  if (action === "task_done") {
    const r = doneTask(
      String(args.taskId ?? ""),
      typeof args.summary === "string" ? args.summary : undefined,
    );
    if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
    return c.json({
      ok: true,
      payload: { taskId: r.taskId, status: r.status },
    });
  }
  if (action === "task_cancel") {
    const r = cancelTask(String(args.taskId ?? ""));
    if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
    return c.json({
      ok: true,
      payload: { taskId: r.taskId, cancelled: r.cancelled },
    });
  }
  if (action === "plan_create") {
    if (!body.parentRunner || !body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const phases = Array.isArray(args.phases)
      ? args.phases.filter((p): p is string => typeof p === "string")
      : [];
    const risks = Array.isArray(args.risks)
      ? args.risks.filter((r): r is string => typeof r === "string")
      : undefined;
    const verification = Array.isArray(args.verification)
      ? args.verification.filter((v): v is string => typeof v === "string")
      : undefined;
    const r = await writePlan({
      cwd: body.parentCwd,
      owner: body.parentRunner,
      title: String(args.title ?? ""),
      goal: String(args.goal ?? ""),
      phases,
      scope: typeof args.scope === "string" ? args.scope : undefined,
      risks,
      verification,
    });
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "plan_read") {
    if (!body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const r = await readPlan({
      cwd: body.parentCwd,
      planId: typeof args.planId === "string" ? args.planId : undefined,
      path: typeof args.path === "string" ? args.path : undefined,
    });
    return c.json({ ok: r.ok, payload: r.ok ? { plan: r.plan } : { error: r.error } });
  }
  if (action === "collab_start") {
    if (!body.parentRunner || !body.parentSessionId || !body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const r = await startCollab({
      sessionId: body.parentSessionId,
      cwd: body.parentCwd,
      leadRunner: body.parentRunner,
      planId: typeof args.planId === "string" ? args.planId : undefined,
      path: typeof args.path === "string" ? args.path : undefined,
      maxPeerTurns:
        typeof args.maxPeerTurns === "number" && Number.isFinite(args.maxPeerTurns)
          ? args.maxPeerTurns
          : 8,
    });
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "collab_send") {
    if (!body.parentRunner) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const r = sendCollabMessage(String(args.collabId ?? ""), {
      from: body.parentRunner,
      kind: String(args.kind ?? "note") as CollabMessageKind,
      body: String(args.body ?? ""),
      phaseId: typeof args.phaseId === "string" ? args.phaseId : undefined,
    });
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "collab_ask_peer") {
    if (!body.parentCwd) {
      return c.json(
        { ok: false, payload: { error: "missing parent context" } },
        400,
      );
    }
    const r = await askPeer(String(args.collabId ?? ""), {
      phaseId: typeof args.phaseId === "string" ? args.phaseId : undefined,
      request: String(args.request ?? ""),
      role: String(args.role ?? "review") as PeerRole,
      timeoutSec:
        typeof args.timeoutSec === "number" && Number.isFinite(args.timeoutSec)
          ? args.timeoutSec
          : 180,
      maxTurns:
        typeof args.maxTurns === "number" && Number.isFinite(args.maxTurns)
          ? args.maxTurns
          : undefined,
      parentCwd: body.parentCwd,
      depth: (typeof body.depth === "number" ? body.depth : 0) + 1,
    });
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "collab_observe") {
    const r = observeCollab(String(args.collabId ?? ""));
    return c.json({ ok: r.ok, payload: r.ok ? { snapshot: r.snapshot } : { error: r.error } });
  }
  if (action === "phase_start") {
    const r = startPhase(
      String(args.collabId ?? ""),
      typeof args.phaseId === "string" ? args.phaseId : undefined,
    );
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "phase_done") {
    const r = donePhase(
      String(args.collabId ?? ""),
      String(args.phaseId ?? ""),
      typeof args.summary === "string" ? args.summary : undefined,
    );
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "phase_handoff") {
    const owner = args.owner === "claude" || args.owner === "codex"
      ? args.owner
      : undefined;
    if (!owner) return c.json({ ok: false, payload: { error: "invalid owner" } }, 400);
    const r = handoffPhase(String(args.collabId ?? ""), String(args.phaseId ?? ""), {
      owner,
      makeLead: args.makeLead === true,
      note: typeof args.note === "string" ? args.note : undefined,
    });
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "collab_finish") {
    const r = finishCollab(
      String(args.collabId ?? ""),
      typeof args.summary === "string" ? args.summary : undefined,
    );
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  if (action === "collab_cancel") {
    const r = cancelCollab(String(args.collabId ?? ""));
    return c.json({ ok: r.ok, payload: r.ok ? r : { error: r.error } });
  }
  return c.json({ ok: false, payload: { error: `unknown action: ${action}` } }, 400);
});

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      sessions.subscribe(ws);
      sendTo(ws, {
        type: "hello",
        sessions: sessions.list(),
        permissions: permissions.list(),
        sessionSkills: Object.fromEntries(sessionSkills.entries()),
      });
      // Replay any prompts still waiting on a decision so a fresh client can
      // act on them.
      for (const req of permissions.pendingRequests()) {
        sendTo(ws, { type: "permission_request", request: req });
      }
      // Same idea for pending consensus modals — a TUI that reconnects mid
      // /consensus decision should re-receive the ready payload, otherwise
      // the user loses the modal with no way back to it.
      // Same idea for an in-flight or proposed workflow - a reconnecting TUI
      // must re-receive the current DAG snapshot or it loses the card/panel
      // and any pending approval modal. The engine mutates the stored run in
      // place, so getWorkflowRun is always the current snapshot.
      for (const s of sessions.list()) {
        const ready = getConsensusReady(s.id);
        if (ready) sendTo(ws, { type: "consensus_ready", ready });
        const run = getWorkflowRun(s.id);
        if (run) sendTo(ws, { type: "workflow_state", run });
      }
    },
    onClose(_evt, ws) {
      sessions.unsubscribe(ws);
    },
    onMessage(evt, ws) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(evt.data)) as ClientMsg;
      } catch {
        sendTo(ws, { type: "error", message: "invalid json" });
        return;
      }
      handleClientMsg(msg).catch((err) => {
        sendTo(ws, {
          type: "error",
          sessionId: "sessionId" in msg ? msg.sessionId : undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    },
  })),
);

async function handleClientMsg(msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case "subscribe":
      // All connected sockets receive every broadcast in v1. Reserved for
      // per-session filtering — keep the wire type stable so adding it later
      // doesn't churn the protocol.
      return;

    case "create_session": {
      const created = sessions.create({
        title: msg.title,
        runner: msg.runner,
        cwd: msg.cwd,
      });
      refreshEffortInfo(created.id);
      // Eagerly fetch git for the new session so the status bar isn't blank
      // for the polling interval.
      readGitInfo(created.cwd)
        .then((info) => {
          if (!gitInfoEquals(created.git, info)) sessions.setGit(created.id, info);
        })
        .catch(() => {});
      return;
    }

    case "delete_session": {
      turnAborts.get(msg.sessionId)?.abort();
      turnAborts.delete(msg.sessionId);
      cancelRunsForSession(msg.sessionId);
      cancelCollabsForSession(msg.sessionId);
      clearCollabsForSession(msg.sessionId);
      cancelTasksForSession(msg.sessionId);
      clearTasksForSession(msg.sessionId);
      clearConsensusReady(msg.sessionId);
      // Stop the workflow scheduler (if approved+running) and drop its store.
      // session_deleted tears down all client-side state for the session, so
      // no workflow_state broadcast is needed here - any terminal snapshot the
      // engine's cancel() emits is harmless.
      clearWorkflowCompletionContext(msg.sessionId);
      teardownWorkflow(msg.sessionId);
      clearDelegationStats(msg.sessionId);
      sessionSkills.delete(msg.sessionId);
      sessions.delete(msg.sessionId);
      return;
    }

    case "set_runner":
      sessions.setRunner(msg.sessionId, msg.runner);
      refreshEffortInfo(msg.sessionId);
      return;

    case "clear_session": {
      // Cancel any in-flight turn so its abort path can't reach into the
      // freshly-cleared state.
      turnAborts.get(msg.sessionId)?.abort();
      turnAborts.delete(msg.sessionId);
      // Bulk-cancel any peers this session spawned. Their work() finally will
      // try to bump finish stats, but bumpOnFinish skips when the session's
      // stats entry is gone — which we wipe next.
      cancelRunsForSession(msg.sessionId);
      cancelCollabsForSession(msg.sessionId);
      clearCollabsForSession(msg.sessionId);
      cancelTasksForSession(msg.sessionId);
      clearTasksForSession(msg.sessionId);
      if (clearConsensusReady(msg.sessionId)) {
        sessions.broadcast({
          type: "consensus_cleared",
          sessionId: msg.sessionId,
        });
      }
      // Explicitly tear down workflow UI state. The turnAborts.abort() above does
      // NOT reach an approved+running workflow (no live turn holds its
      // controller), so this mirrors the tasks/collab cleanup.
      clearWorkflowCompletionContext(msg.sessionId);
      clearWorkflowForClear(msg.sessionId);
      clearDelegationStats(msg.sessionId);
      sessions.setDelegations(msg.sessionId, null);
      sessions.clearSession(msg.sessionId);
      return;
    }

    case "set_model":
      sessions.setModel(msg.sessionId, msg.runner, msg.model);
      refreshEffortInfo(msg.sessionId);
      return;

    case "set_effort":
      sessions.setEffort(msg.sessionId, msg.runner, msg.effort);
      return;

    case "set_claude_mode":
      sessions.setClaudeMode(msg.sessionId, msg.mode);
      return;

    case "send":
      await runTurn(msg.sessionId, msg.text);
      return;

    case "consensus_start":
      await runConsensusTurn(msg.sessionId, msg.task, {
        maxTurnsPerPeer: msg.maxTurnsPerPeer,
        producer: msg.producer,
      });
      return;

    case "consensus_action":
      await handleConsensusAction(msg);
      return;

    case "workflow_start": {
      // Authoring runs on the session's active runner. Reject overlap so a new
      // proposal cannot orphan an already running scheduler.
      const existing = getWorkflowRun(msg.sessionId);
      if (isWorkflowActive(existing)) {
        sessions.broadcast({
          type: "error",
          sessionId: msg.sessionId,
          message: `a workflow is already ${existing.status}; approve/cancel it before starting another`,
        });
        return;
      }
      clearWorkflowCompletionContext(msg.sessionId);
      if (existing) {
        clearWorkflowRun(msg.sessionId);
        sessions.broadcast({ type: "workflow_cleared", sessionId: msg.sessionId });
      }
      clearDraft(msg.sessionId);
      await runTurn(msg.sessionId, buildWorkflowAuthoringPrompt(msg.goal), {
        displayText: `/workflow ${msg.goal}`,
      });
      return;
    }

    case "workflow_approve":
      handleWorkflowApprove(msg.workflowId);
      return;

    case "workflow_cancel":
      handleWorkflowCancel(msg.workflowId);
      return;

    case "interrupt": {
      // Cancel the in-flight turn — the runner's catch swallows the abort and
      // the `finally` in runTurn finishes the assistant message cleanly.
      turnAborts.get(msg.sessionId)?.abort();
      turnAborts.delete(msg.sessionId);
      return;
    }

    case "permission_response":
      permissions.respond(msg.requestId, {
        decision: msg.decision,
        answers: msg.answers,
        annotations: msg.annotations,
      });
      return;

    case "list_permissions":
      sessions.broadcast({ type: "permissions", rules: permissions.list() });
      return;

    case "add_permission":
      permissions.add(msg.rule);
      return;

    case "remove_permission":
      permissions.remove(msg.rule);
      return;

    case "clear_permissions":
      permissions.clear();
      return;
  }
}

async function runTurn(
  sessionId: string,
  text: string,
  opts?: { displayText?: string; runner?: RunnerKind },
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `unknown session: ${sessionId}`,
    });
    return;
  }

  // The runner that actually executes this turn. Normally the session's active
  // runner; opts.runner is reserved for explicit internal overrides.
  const turnRunner: RunnerKind = opts?.runner ?? session.activeRunner;
  const runtime = sessions.runtime(sessionId)!;
  const workflowCompletionContext =
    opts?.runner === undefined ? runtime.pendingWorkflowCompletionContext : undefined;
  const runnerPrompt = withWorkflowCompletionContext(text, workflowCompletionContext);

  // The user message shows `displayText` (e.g. "/workflow <goal>") while the
  // runner receives `runnerPrompt` (possibly with hidden workflow completion
  // context or the goal wrapped in tool instructions).
  sessions.startMessage(sessionId, "user", opts?.displayText ?? text);
  const asst = sessions.startMessage(sessionId, "assistant", "");
  if (!asst) return;

  const onEvent = (event: RunEvent): void => {
    sessions.appendEvent(sessionId, asst.id, event);
  };
  // Single-source-of-truth usage signals — set once per turn by the runner
  // from the SDK's final aggregate. No client-side summing or max-merging.
  const onTurnUsage = (usage: TurnUsage): void => {
    sessions.setTurnUsage(sessionId, asst.id, usage);
  };
  const onContextUsage = (ctx: ContextUsage | null): void => {
    sessions.setContextUsage(sessionId, ctx);
  };

  const abort = new AbortController();
  turnAborts.get(sessionId)?.abort();
  turnAborts.set(sessionId, abort);
  abort.signal.addEventListener("abort", () => {
    cancelRunsForSession(sessionId);
    cancelTasksForSession(sessionId);
    cancelCollabsForSession(sessionId);
  });

  // Peer events emitted by a delegated run are folded into the parent's
  // assistant message with a `[runner]` chip in the name so the TUI can
  // render them inline alongside the parent's own events. See
  // peer-forwarding.ts for the chunking contract.
  const forwardPeerEvent = buildPeerEventForwarder(onEvent);
  const onStatsChange = (stats: DelegationStats): void => {
    sessions.setDelegations(sessionId, stats);
  };

  // The HTTP-callback path (Codex's stdio MCP child) finds these via the
  // parentSessionId. The in-process Claude path also reads them when
  // executeDelegate is invoked, so register unconditionally.
  registerParentCallbacks(sessionId, {
    onPeerEvent: forwardPeerEvent,
    onStatsChange,
  });
  // task_* tools emit a tool_log per Task snapshot. Same parentSessionId
  // lookup as parentCallbacks — works for both in-process Claude and the
  // HTTP-proxy Codex path.
  registerTaskEmitter(sessionId, onEvent);
  registerCollabEmitter(sessionId, onEvent);

  // Turn-runner effort, clamped to what the resolved model actually supports.
  // effortInfo is for the active runner+model (kept current by refreshEffortInfo).
  const effortLevels = session.effortInfo?.levels ?? [];
  const activeEffort = session.efforts?.[turnRunner] ?? null;
  const clampedEffort =
    activeEffort && effortLevels.length > 0
      ? clampEffort(effortLevels, activeEffort)
      : null;

  try {
    if (turnRunner === "claude") {
      // In-process MCP server — same process, no HTTP hop.
      const orchestrator = buildDelegateMcpServer({
        parentRunner: "claude",
        parentSessionId: sessionId,
        parentCwd: session.cwd,
        depth: 0,
        onPeerEvent: forwardPeerEvent,
        onStatsChange,
        // workflow_run hands the assembled DAG here; store it + broadcast so the
        // approval modal mounts (approve later starts the scheduler). Guard here
        // too because workflow tools are available to any top-level Claude turn,
        // not just /workflow.
        onWorkflowProposed: (run) => handleWorkflowProposed(sessionId, run),
      });
      await runClaude({
        prompt: runnerPrompt,
        cwd: session.cwd,
        resumeId: runtime.claudeSessionId,
        model: session.models.claude,
        effort: clampedEffort ?? undefined,
        allowRules: permissions.list(),
        permissionMode: session.claudeMode,
        abortController: abort,
        mcpServers: { orchestrator },
        systemPrompt: ADVERSARIA_SYSTEM_PROMPT_APPEND,
        canUseTool: async (toolName, input, ctx) => {
          // The SDK routes every tool call through canUseTool when it's set
          // (it adds --permission-prompt-tool stdio), which overrides
          // permissionMode's built-in shortcuts. Honor the mode here instead
          // so bypass/acceptEdits don't degrade into "ask every time".
          // Read live from session so a shift+tab mid-turn takes effect.
          // AskUserQuestion is a user-input channel, not a permission gate.
          // Short-circuiting it would feed the SDK undefined updatedInput,
          // which fails its Zod schema (see buildAskUserUpdatedInput comment)
          // and silently drops the question. Always route it through the UI.
          const mode = session.claudeMode;
          if (toolName !== "AskUserQuestion") {
            if (mode === "bypassPermissions") {
              return { behavior: "allow" };
            }
            if (mode === "acceptEdits" && isEditTool(toolName)) {
              return { behavior: "allow" };
            }
          }

          const resolution = await permissions.request({
            sessionId,
            tool: toolName,
            input,
            title: ctx.title,
            description: ctx.description,
            suggestions: ctx.suggestions,
            signal: ctx.signal,
          });
          const { decision, answers, annotations } = resolution;
          if (decision === "deny") {
            return { behavior: "deny", message: "denied by user" };
          }

          // AskUserQuestion is the SDK's user-input channel: the model gets
          // the user's answers only if we echo them back as `updatedInput`.
          // Without this the SDK's Zod schema rejects the allow decision and
          // the question silently fails.
          const updatedInput = buildAskUserUpdatedInput(
            toolName,
            input,
            answers,
            annotations,
          );

          if (decision === "allow_always" && ctx.suggestions.length > 0) {
            permissions.addMany(ctx.suggestions);
            return {
              behavior: "allow",
              rulesToPersist: ctx.suggestions,
              ...(updatedInput ? { updatedInput } : {}),
            };
          }
          return {
            behavior: "allow",
            ...(updatedInput ? { updatedInput } : {}),
          };
        },
        onEvent,
        onTurnUsage,
        onContextUsage,
        onRaw: (raw) => sessions.logRaw(sessionId, asst.id, "claude", raw),
        onResumeId: (id) => {
          if (id) runtime.claudeSessionId = id;
          else delete runtime.claudeSessionId;
          sessions.logRuntime(sessionId, "claudeSessionId", id);
          sessions.markDirty();
        },
        onSkillInfo: ({ skills, plugins }) => {
          updateSessionSkills(sessionId, "claude", skills, plugins);
        },
      });
    } else if (turnRunner === "codex") {
      // Codex CLI only accepts stdio MCP servers, so wire it to spawn our
      // own child (mcp-codex-orchestrator.mjs) that proxies tool calls back
      // to /internal/delegate. parentSessionId + token + depth are passed via
      // env on the spawn so the child's HTTP callbacks land on this session.
      await runCodex({
        prompt: runnerPrompt,
        cwd: session.cwd,
        threadId: runtime.codexThreadId,
        model: session.models.codex,
        effort: clampedEffort ?? undefined,
        signal: abort.signal,
        onEvent,
        onTurnUsage,
        onContextUsage,
        onRaw: (raw) => sessions.logRaw(sessionId, asst.id, "codex", raw),
        onThreadId: (id) => {
          if (id) runtime.codexThreadId = id;
          else delete runtime.codexThreadId;
          sessions.logRuntime(sessionId, "codexThreadId", id);
          sessions.markDirty();
        },
        // ADVERSARIA_NO_CODEX_ORCH=1 skips wiring the orchestrator MCP, which
        // stops codex from spawning the Node MCP child + handshake per turn.
        // Used to measure that child's TTFT contribution against the perf line;
        // delegation tools are unavailable while set.
        orchestrator:
          process.env.ADVERSARIA_NO_CODEX_ORCH === "1"
            ? undefined
            : {
                url: `http://127.0.0.1:${boundPort}`,
                token: ORCHESTRATOR_TOKEN,
                scriptPath: ORCHESTRATOR_SCRIPT_PATH,
                parentSessionId: sessionId,
                parentRunner: "codex",
                parentCwd: session.cwd,
                depth: 0,
              },
      });
    } else if (turnRunner === "vercel") {
      // Vercel AI SDK runner. Session continuity rides on
      // runtime.vercelMessages since streamText is stateless. Switching
      // model provider mid-session (e.g. gpt-4o -> claude-sonnet) makes the
      // stored ModelMessage[] poisonous because tool-call / tool-result
      // content blocks are shaped per-provider; reset history when the
      // provider family changes.
      const requestedModelId =
        session.models.vercel || process.env.VERCEL_MODEL || "gpt-4o";
      const currentProvider = requestedModelId.startsWith("claude-")
        ? "anthropic"
        : "openai";
      let prior: ModelMessage[] = Array.isArray(runtime.vercelMessages)
        ? (runtime.vercelMessages as ModelMessage[])
        : [];
      if (
        runtime.vercelLastProvider &&
        runtime.vercelLastProvider !== currentProvider &&
        prior.length > 0
      ) {
        prior = [];
        runtime.vercelMessages = [];
        onEvent({
          type: "tool_log",
          log: {
            name: "vercel: provider switch",
            input: {
              from: runtime.vercelLastProvider,
              to: currentProvider,
            },
            output: "message history reset (tool-call shapes differ across providers)",
          },
        });
      }
      runtime.vercelLastProvider = currentProvider;
      await runVercel({
        prompt: runnerPrompt,
        cwd: session.cwd,
        priorMessages: prior,
        model: session.models.vercel,
        effort: clampedEffort ?? undefined,
        systemPromptAppend: ADVERSARIA_SYSTEM_PROMPT_APPEND,
        signal: abort.signal,
        sessionId,
        permissionMode: session.claudeMode,
        permissions,
        allowRules: permissions.list(),
        depth: 0,
        onWorkflowProposed: (run) => handleWorkflowProposed(sessionId, run),
        onEvent,
        onTurnUsage,
        onContextUsage,
        onRaw: (raw) => sessions.logRaw(sessionId, asst.id, "vercel", raw),
        onMessages: (msgs) => {
          runtime.vercelMessages = msgs;
          sessions.logRuntime(sessionId, "vercelMessages", msgs.length);
          sessions.markDirty();
        },
      });
    } else {
      // Ollama runner (local models via the OpenAI-compatible /v1 endpoint).
      // Like Vercel, streamText is stateless, so continuity rides on
      // runtime.ollamaMessages. No provider-switch reset is needed: every
      // ollama turn routes through the same OpenAI-compat client, so swapping
      // models mid-session (e.g. qwen3:8b -> gpt-oss:20b) keeps the stored
      // ModelMessage[] valid. No ADVERSARIA append: ollama has no
      // validate_run tool, so instructing the model to call it would dangle.
      const priorOllama: ModelMessage[] = Array.isArray(runtime.ollamaMessages)
        ? (runtime.ollamaMessages as ModelMessage[])
        : [];
      await runOllama({
        prompt: runnerPrompt,
        cwd: session.cwd,
        priorMessages: priorOllama,
        model: session.models.ollama,
        signal: abort.signal,
        sessionId,
        permissionMode: session.claudeMode,
        permissions,
        allowRules: permissions.list(),
        onWorkflowProposed: (run) => handleWorkflowProposed(sessionId, run),
        onEvent,
        onTurnUsage,
        onContextUsage,
        onRaw: (raw) => sessions.logRaw(sessionId, asst.id, "ollama", raw),
        onMessages: (msgs) => {
          runtime.ollamaMessages = msgs;
          sessions.logRuntime(sessionId, "ollamaMessages", msgs.length);
          sessions.markDirty();
        },
      });
    }
    if (workflowCompletionContext && !abort.signal.aborted) {
      delete runtime.pendingWorkflowCompletionContext;
      sessions.markDirty();
    }
  } catch (err) {
    onEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (turnAborts.get(sessionId) === abort) turnAborts.delete(sessionId);
    unregisterParentCallbacks(sessionId);
    unregisterTaskEmitter(sessionId);
    unregisterCollabEmitter(sessionId);
    sessions.finishMessage(sessionId, asst.id);
  }
}

// /consensus turn — drives the adversarial planning protocol and emits a
// `consensus_ready` server message when both rounds settle. Mirrors runTurn's
// lifecycle (user message + assistant message, peer-event forwarding, abort
// wiring) but doesn't invoke a runner SDK directly — it just orchestrates
// peers via startSubtaskRun. The assistant message hosts the round
// breakdown as folded tool cards; the consensus_ready broadcast is what the
// TUI uses to actually mount the decision modal.
// Default per-peer turn budget when the client doesn't pass one. Eight is
// "read 4-5 files + reason + write a draft" — enough for an agent to
// No default per-peer turn cap. The SDK counts every assistant turn —
// including tool-call turns — so a default like 8 burns through with 3-4
// Read/Grep/Globs before the agent writes the actual draft. Total cost
// of /consensus is bounded by the single-cycle structure (exactly 1
// producer call + 1 critic call) plus the read-only tool whitelist; no
// per-call cap is needed. `max=N` from the slash command is opt-in only;
// we clamp to the ceiling to keep a typo (max=9999) from asking the SDK
// for runaway exploration on a single call.
const CONSENSUS_MAX_TURNS_CEILING = 60;

async function runConsensusTurn(
  sessionId: string,
  task: string,
  opts: {
    maxTurnsPerPeer?: number;
    producer?: RunnerKind;
  },
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `unknown session: ${sessionId}`,
    });
    return;
  }

  // Actor/critic is a claude↔codex pair protocol. Reject vercel- and ollama-
  // active sessions early instead of silently swapping the runner.
  if (session.activeRunner === "vercel" || session.activeRunner === "ollama") {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `/consensus is not available for the ${session.activeRunner} runner. Switch to claude or codex first (/claude or /codex), then re-run.`,
    });
    return;
  }
  const eligible: RunnerKind[] = ["claude", "codex"];
  if (opts.producer && !eligible.includes(opts.producer)) {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `/consensus producer must be claude or codex (got: ${opts.producer})`,
    });
    return;
  }
  const producer: RunnerKind = opts.producer ?? session.activeRunner;
  const critic: RunnerKind = producer === "claude" ? "codex" : "claude";

  sessions.startMessage(sessionId, "user", `/consensus ${task}`);
  const asst = sessions.startMessage(sessionId, "assistant", "");
  if (!asst) return;

  const onEvent = (event: RunEvent): void => {
    sessions.appendEvent(sessionId, asst.id, event);
  };

  const abort = new AbortController();
  turnAborts.get(sessionId)?.abort();
  turnAborts.set(sessionId, abort);
  // Aborting the parent turn cascades to every in-flight peer call so
  // interrupt / takeover actually kills the cycle mid-call. Without this
  // the abort just marks the signal — the peer that's mid-call keeps
  // running and streams into a dead message.
  abort.signal.addEventListener("abort", () => {
    cancelRunsForSession(sessionId);
  });

  const forwardPeerEvent = buildPeerEventForwarder(onEvent);
  const onStatsChange = (stats: DelegationStats): void => {
    sessions.setDelegations(sessionId, stats);
  };

  const turnsClamped: number | undefined =
    typeof opts.maxTurnsPerPeer === "number" && opts.maxTurnsPerPeer > 0
      ? Math.min(opts.maxTurnsPerPeer, CONSENSUS_MAX_TURNS_CEILING)
      : undefined;

  try {
    onEvent({
      type: "tool_log",
      log: {
        id: "consensus:header",
        name: "consensus",
        output:
          `Single actor/critic pass. PRODUCER=${producer}, CRITIC=${critic}. ` +
          `Producer writes one draft; critic reviews it once; cycle ends. ` +
          (turnsClamped !== undefined
            ? `Per-call turn cap: ${turnsClamped}.`
            : `No per-peer turn cap (pass max=N to set one).`),
      },
    });

    const result = await runConsensus(task, {
      parentSessionId: sessionId,
      parentCwd: session.cwd,
      pair: { producer, critic },
      depth: 0,
      timeoutSec: 240,
      maxTurnsPerPeer: turnsClamped,
      signal: abort.signal,
      onPeerEvent: forwardPeerEvent,
      // Emit a backward-fold anchor after each call settles. The TUI's
      // groupDelegations folds the streaming peer events under this anchor
      // so producer + critic each render as a labelled closed card.
      onIterationStep: ({ role, runner, replyChars, verdict, summary, error }) => {
        const charLabel =
          replyChars < 1000 ? `${replyChars} chars` : `${(replyChars / 1000).toFixed(1)}k chars`;
        const headline =
          role === "producer"
            ? `PRODUCER = ${runner} · ${charLabel} draft`
            : `CRITIC = ${runner} · verdict ${verdict ?? "unknown"}`;
        const detailLines: string[] = [headline];
        if (role === "critic" && summary) detailLines.push(summary);
        if (error) detailLines.push(`(note: ${error})`);
        onEvent({
          type: "tool_log",
          log: {
            id: `consensus:step:${role}`,
            name: "consensus_step",
            output: detailLines.join("\n"),
          },
        });
      },
    });

    if (abort.signal.aborted) {
      onEvent({
        type: "tool_log",
        log: {
          id: "consensus:footer",
          name: "consensus",
          output: "Consensus cycle cancelled.",
        },
      });
      return;
    }

    for (const err of result.errors) {
      onEvent({ type: "error", message: err });
    }

    const ready: ConsensusReady = {
      sessionId,
      messageId: asst.id,
      task,
      producer,
      critic,
      iterations: result.iterations,
      finalDraft: result.finalDraft,
      converged: result.converged,
      // The producer wrote the draft, so they're the natural pick for the
      // implementer turn. User can override in the modal.
      suggestedRunner: producer,
    };
    setConsensusReady(ready);

    const verdict = result.iterations[0]?.verdict ?? "unknown";
    onEvent({
      type: "tool_log",
      log: {
        id: "consensus:footer",
        name: "consensus",
        output:
          result.converged
            ? `Cycle complete. Critic AGREED. Awaiting your implementer choice.`
            : verdict === "revise"
              ? `Cycle complete. Critic flagged issues (verdict: revise). Awaiting your implementer choice.`
              : `Cycle complete. Awaiting your implementer choice.`,
      },
    });
    sessions.broadcast({ type: "consensus_ready", ready });
  } catch (err) {
    onEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (turnAborts.get(sessionId) === abort) turnAborts.delete(sessionId);
    sessions.finishMessage(sessionId, asst.id);
  }
}

async function handleConsensusAction(
  msg: Extract<ClientMsg, { type: "consensus_action" }>,
): Promise<void> {
  const ready = getConsensusReady(msg.sessionId);
  if (!ready) {
    sessions.broadcast({
      type: "error",
      sessionId: msg.sessionId,
      message: "no consensus plan is awaiting a decision",
    });
    return;
  }

  if (msg.action === "cancel") {
    clearConsensusReady(msg.sessionId);
    sessions.broadcast({
      type: "consensus_cleared",
      sessionId: msg.sessionId,
    });
    return;
    return;
  }

  // action === "implement"
  if (!msg.runner) {
    sessions.broadcast({
      type: "error",
      sessionId: msg.sessionId,
      message: "implement action requires a runner",
    });
    return;
  }
  const plan = msg.plan?.trim();
  if (!plan) {
    sessions.broadcast({
      type: "error",
      sessionId: msg.sessionId,
      message: "implement action requires a plan",
    });
    return;
  }

  // Switch runner if the user picked the non-active one. Same path as
  // /claude or /codex from the TUI — sets activeRunner on the session.
  const session = sessions.get(msg.sessionId);
  if (session && session.activeRunner !== msg.runner) {
    sessions.setRunner(msg.sessionId, msg.runner);
  }

  clearConsensusReady(msg.sessionId);
  sessions.broadcast({
    type: "consensus_cleared",
    sessionId: msg.sessionId,
  });

  const implementationPrompt = [
    "Implement the following. It was produced by an actor/critic loop",
    "between you and a peer agent and approved by the user — treat it as",
    "the agreed deliverable. If it's code, apply it. If it's a design,",
    "execute it.",
    "",
    plan,
  ].join("\n");
  await runTurn(msg.sessionId, implementationPrompt);
}

// ----- /workflow dispatch -----
//
// Authoring is no longer a separate planner lifecycle: workflow_start runs a
// normal active-runner turn with an authoring prompt, and the model assembles
// + proposes the DAG via workflow_add_node / workflow_run. The proposal hook
// stores the run + broadcasts workflow_state, so the TUI mounts the approval
// modal. workflow_approve starts the scheduler (runWorkflow), detached from
// any turn: approve opens its own host assistant message to carry per-node
// peer events and pushes a fresh snapshot on every transition via `emit`.
// workflow_cancel / /clear / delete_session tear it down.
//
// The engine (workflow.ts) stays low-level: a per-session run store
// (get/set/clearWorkflowRun), runWorkflow(run, dispatcher, emit) -> controller,
// and cancelWorkflowRuns(sessionId) for the no-controller bulk path. So index.ts
// owns the controller registry and the workflowId -> session resolution.

// Per-node delegate timeout for the real dispatcher (seconds). Generous: a
// node is a full agent run, not a single tool call. Matches the upper end of
// the consensus per-call budget.
const WORKFLOW_NODE_TIMEOUT_SEC = 600;

// The authoring prompt handed to the active runner when the user types
// /workflow <goal>. It is shown to the user as "/workflow <goal>" (runTurn's
// displayText), but the runner receives this fuller instruction so it reaches
// for the workflow tools and encodes the per-node isolation contract.
function buildWorkflowAuthoringPrompt(goal: string): string {
  return [
    "The user invoked /workflow with this goal:",
    "",
    goal,
    "",
    "Design a DAG of agent nodes that accomplishes it, then assemble it with the",
    "orchestrator workflow tools - do NOT do the work yourself, your only job is to",
    "author the graph:",
    "- Call workflow_add_node once per step: give it a short id, a title, the runner",
    "  to use, a self-contained prompt, and dependsOn (ids of steps whose output it",
    "  needs).",
    "- Each node runs as a FRESH, ISOLATED agent that shares no context with any",
    "  other node. The only thing a node receives from a dependency is that",
    "  dependency's final output text, which the engine injects automatically. So",
    "  write each prompt to stand alone and never reference another node by name.",
    "- Steps that do not depend on each other must NOT list each other in dependsOn,",
    "  so they run in parallel.",
    "- When the graph is complete, call workflow_run with a one-line goal summary to",
    "  propose it for the user's approval, then stop.",
    "If the goal is too small to split into 2+ steps, say so plainly instead of",
    "forcing a graph.",
  ].join("\n");
}

function handleWorkflowProposed(
  sessionId: string,
  run: WorkflowRun,
): { ok: true } | { ok: false; error: string } {
  const existing = getWorkflowRun(sessionId);
  if (isWorkflowActive(existing) && existing.id !== run.id) {
    return {
      ok: false,
      error: `a workflow is already ${existing.status}; approve/cancel it before proposing another`,
    };
  }
  clearWorkflowCompletionContext(sessionId);
  setWorkflowRun(run);
  sessions.broadcast({ type: "workflow_state", run });
  return { ok: true };
}

// Resolve a workflowId to its session. The store is keyed by sessionId (one
// active workflow per session), but the wire keys approve/cancel on
// workflowId, so scan the live sessions for the run whose id matches.
function findWorkflowSession(
  workflowId: string,
): { sessionId: string; run: WorkflowRun } | null {
  for (const s of sessions.list()) {
    const run = getWorkflowRun(s.id);
    if (run && run.id === workflowId) return { sessionId: s.id, run };
  }
  return null;
}

// Approve a proposed run: flip it to running by starting the scheduler. The
// scheduler is detached from any turn, so this opens its own host assistant
// message to carry per-node peer event text (spec: per-node streaming rides
// the onPeerEvent -> tool_log path) and pushes a fresh snapshot on every node
// transition via `emit`. The controller is retained so workflow_cancel /
// /clear / delete_session can stop it.
function handleWorkflowApprove(workflowId: string): void {
  const found = findWorkflowSession(workflowId);
  if (!found) {
    sessions.broadcast({
      type: "error",
      message: `no workflow awaiting approval: ${workflowId}`,
    });
    return;
  }
  const { sessionId, run } = found;
  if (run.status !== "proposed") {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `workflow ${workflowId} is not awaiting approval (status: ${run.status})`,
    });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `unknown session: ${sessionId}`,
    });
    return;
  }

  // Host assistant message for the detached scheduler's per-node events.
  const asst = sessions.startMessage(sessionId, "assistant", "");
  if (!asst) return;
  const onEvent = (event: RunEvent): void => {
    sessions.appendEvent(sessionId, asst.id, event);
  };
  const forwardPeerEvent = buildPeerEventForwarder(onEvent);
  // Node runs spawn with parentSessionId = this session, so the existing
  // cancelRunsForSession sweep (delete/clear/turn-abort) also catches in-flight
  // node runs; the controller still owns stopping the loop + marking nodes.
  const dispatcher = createRealDispatcher({
    parentRunner: session.activeRunner,
    parentSessionId: sessionId,
    parentCwd: session.cwd,
    depth: 0,
    timeoutSec: WORKFLOW_NODE_TIMEOUT_SEC,
    onPeerEvent: forwardPeerEvent,
  });

  // emit broadcasts the live snapshot: the engine mutates the run in place, and
  // it's the same reference the store holds (set at proposal), so getWorkflowRun
  // stays current for reconnect replay without an explicit re-set here.
  //
  // Guard against late emits after teardown: /clear (or delete) can race an
  // in-flight node that settles async and emits a terminal `cancelled` snapshot
  // AFTER clearWorkflowForClear has already broadcast `workflow_cleared`. That
  // would re-add a card the client just dropped. clearWorkflowRun nulls the
  // store, so once this run is no longer the stored one we stop broadcasting.
  const emit = (r: WorkflowRun): void => {
    if (getWorkflowRun(sessionId) !== r) return;
    sessions.broadcast({ type: "workflow_state", run: r });
  };

  const controller = runWorkflow(run, dispatcher, emit);
  workflowControllers.set(sessionId, controller);
  void controller.done.then(() => {
    const stillCurrent = getWorkflowRun(sessionId) === run;
    if (stillCurrent) {
      const completionContext = buildWorkflowCompletionContext(run);
      if (completionContext) {
        rememberWorkflowCompletionContext(sessionId, completionContext);
        onEvent({ type: "text_delta", delta: `\n\n${completionContext}` });
      }
    }
    // Guard: a delete/clear may have raced and replaced/removed the entry.
    if (workflowControllers.get(sessionId) === controller) {
      workflowControllers.delete(sessionId);
    }
    sessions.finishMessage(sessionId, asst.id);
  });
}

// Cancel a workflow by id: prefer the live controller (purpose-built - aborts
// in-flight node runs, marks pending nodes skipped, settles, and emits the
// terminal snapshot), falling back to cancelWorkflowRuns for a proposed run
// that was never approved (no controller, so push the terminal snapshot here).
function handleWorkflowCancel(workflowId: string): void {
  const found = findWorkflowSession(workflowId);
  if (!found) {
    sessions.broadcast({
      type: "error",
      message: `no workflow to cancel: ${workflowId}`,
    });
    return;
  }
  const { sessionId, run } = found;
  const controller = workflowControllers.get(sessionId);
  if (controller) {
    controller.cancel();
    workflowControllers.delete(sessionId);
    // controller.cancel() emits the terminal cancelled snapshot via `emit`.
    return;
  }
  // No live scheduler (proposed, or already settled). Mark the stored run
  // cancelled and push the terminal snapshot so the approval modal tears down.
  cancelWorkflowRuns(sessionId);
  sessions.broadcast({ type: "workflow_state", run });
}

// delete_session teardown: stop the scheduler and drop the store. No snapshot
// broadcast - session_deleted drops all client-side state for the session.
function teardownWorkflow(sessionId: string): void {
  const controller = workflowControllers.get(sessionId);
  if (controller) {
    controller.cancel();
    workflowControllers.delete(sessionId);
  } else {
    cancelWorkflowRuns(sessionId);
  }
  clearWorkflowRun(sessionId);
  clearDraft(sessionId);
}

// /clear teardown: stop the scheduler, drop the store, and tell every client to
// remove the card/panel/approval-modal. A terminal `cancelled` snapshot is NOT
// enough - the inline card renders every non-`proposed` status (the "pill on
// completion" state), so it would just flip to "cancelled" and linger. The
// explicit `workflow_cleared` removal signal is what actually tears it down.
function clearWorkflowForClear(sessionId: string): void {
  const controller = workflowControllers.get(sessionId);
  if (controller) {
    controller.cancel();
    workflowControllers.delete(sessionId);
  } else {
    cancelWorkflowRuns(sessionId);
  }
  const had = getWorkflowRun(sessionId) !== null;
  clearWorkflowRun(sessionId);
  clearDraft(sessionId);
  if (had) {
    sessions.broadcast({ type: "workflow_cleared", sessionId });
  }
}

function rememberWorkflowCompletionContext(sessionId: string, context: string): void {
  const runtime = sessions.runtime(sessionId);
  if (!runtime) return;
  runtime.pendingWorkflowCompletionContext = context;
  sessions.markDirty();
}

function clearWorkflowCompletionContext(sessionId: string): void {
  const runtime = sessions.runtime(sessionId);
  if (!runtime?.pendingWorkflowCompletionContext) return;
  delete runtime.pendingWorkflowCompletionContext;
  sessions.markDirty();
}

// Build the `updatedInput` payload the SDK requires when the AskUserQuestion
// tool is allowed. The shape matches the SDK's AskUserQuestionOutput: the
// original questions array plus an `answers` map keyed by question text
// (multi-select answers comma-joined as the schema specifies).
function buildAskUserUpdatedInput(
  toolName: string,
  input: Record<string, unknown>,
  answers: Record<string, string> | undefined,
  annotations: Record<string, { preview?: string; notes?: string }> | undefined,
): Record<string, unknown> | undefined {
  if (toolName !== "AskUserQuestion") return undefined;
  if (!answers || Object.keys(answers).length === 0) return undefined;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const out: Record<string, unknown> = { questions, answers };
  if (annotations && Object.keys(annotations).length > 0) {
    out.annotations = annotations;
  }
  return out;
}

// File-mutating built-in tools that acceptEdits mode is documented to
// auto-approve. Matches the SDK's own classification.
const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

function isEditTool(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(toolName);
}

function sendTo(ws: { send: (data: string) => void }, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignored
  }
}

// Server is embedded in the TUI's Bun process — the TUI calls startServer()
// before its render loop, so backend + frontend live and die together. There
// is no separate server process to orphan, no port-spawn race, no SIGTERM
// dance from the launcher. The legacy SIGINT flush below stays so a hard
// `kill -2` on the TUI still persists session state.
export function startServer(
  opts: { port?: number; hostname?: string } = {},
): { port: number; attached: boolean; close: () => Promise<void> } {
  const port =
    opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 4567);
  const hostname = opts.hostname ?? "127.0.0.1";

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname,
      fetch: app.fetch,
      websocket,
    });
  } catch (err) {
    // EADDRINUSE: another mixcode is already serving this project on this
    // port. Attach mode — skip starting a duplicate backend; the TUI will
    // talk to the existing one over the same loopback URL. Tradeoff: when
    // the primary's TUI closes, its embedded server dies and this TUI's WS
    // reconnect loop will start surfacing errors. Documented behavior; the
    // alternative ("refuse to start") was worse for users iterating in two
    // panes.
    const msg = err instanceof Error ? err.message : String(err);
    if (/already in use|EADDRINUSE/i.test(msg)) {
      console.log(
        `mixcode already running on http://${hostname}:${port} — attaching`,
      );
      boundPort = port;
      return { port, attached: true, close: async () => {} };
    }
    throw err;
  }

  // Bun typings let `port` be `number | undefined` (for unix-socket servers).
  // We always pass a numeric port above, so a `?? port` fallback keeps TS
  // honest without lying about runtime behavior.
  const actualPort = server.port ?? port;
  boundPort = actualPort;
  // Backfill effort capability for sessions restored from disk so the slider
  // works on first open without waiting for a model/runner change. Cached per
  // model id, so this is a handful of Models API calls at most.
  for (const s of sessions.list()) refreshEffortInfo(s.id);
  console.log(
    `adverserial backend listening on http://${server.hostname}:${actualPort}`,
  );

  // Sync flush on process exit. `writeFileSync` + `closeSync` are both safe
  // here — they're the only kinds of work we do during shutdown.
  const onExit = () => {
    sessions.flush();
    sessions.transcript.closeAll();
  };
  process.once("exit", onExit);

  // SIGINT/SIGTERM: explicit flush then exit. The TUI's exitOnCtrlC handler
  // also fires on Ctrl-C, but registering here means a `kill` from outside
  // the TUI render loop is still graceful.
  const onSignal = () => {
    onExit();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return {
    port: actualPort,
    attached: false,
    close: async () => {
      onExit();
      server.stop();
    },
  };
}
