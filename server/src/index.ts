import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { nanoid } from "nanoid";
import { WebSocketServer } from "ws";
import type {
  ClientMsg,
  DelegationStats,
  RunEvent,
  RunnerKind,
  ServerMsg,
} from "../../shared/events.js";
import type { DelegateRunRecord } from "./runners/delegate.js";
import { SessionManager } from "./sessions.js";
import { runClaude } from "./runners/claude.js";
import { runCodex } from "./runners/codex.js";
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
import { PermissionStore } from "./permissions.js";
import { gitInfoEquals, readGitInfo } from "./git.js";

// Shared secret used to authenticate the Codex-side MCP child's HTTP
// callbacks. Generated once per server start; rotates on restart.
const ORCHESTRATOR_TOKEN = nanoid();
// Absolute path to the stdio MCP server spawned as a child of Codex CLI.
// Resolved relative to this file so it works whether tsx is run from the
// repo root, the server workspace, or via the bin/start.mjs launcher.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SCRIPT_PATH = path.join(__dirname, "mcp-codex-orchestrator.mjs");

const sessions = new SessionManager();
const permissions = new PermissionStore();
// Map sessionId -> AbortController for the in-flight turn, so deleting a
// session or starting a new turn can cancel pending permission prompts.
const turnAborts = new Map<string, AbortController>();

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
      });
      // Replay any prompts still waiting on a decision so a fresh client can
      // act on them.
      for (const req of permissions.pendingRequests()) {
        sendTo(ws, { type: "permission_request", request: req });
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
      sessions.delete(msg.sessionId);
      return;
    }

    case "set_runner":
      sessions.setRunner(msg.sessionId, msg.runner);
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
      clearDelegationStats(msg.sessionId);
      sessions.setDelegations(msg.sessionId, null);
      sessions.clearSession(msg.sessionId);
      return;
    }

    case "set_model":
      sessions.setModel(msg.sessionId, msg.runner, msg.model);
      return;

    case "set_claude_mode":
      sessions.setClaudeMode(msg.sessionId, msg.mode);
      return;

    case "send":
      await runTurn(msg.sessionId, msg.text);
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

async function runTurn(sessionId: string, text: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    sessions.broadcast({
      type: "error",
      sessionId,
      message: `unknown session: ${sessionId}`,
    });
    return;
  }

  sessions.startMessage(sessionId, "user", text);
  const asst = sessions.startMessage(sessionId, "assistant", "");
  if (!asst) return;

  const onEvent = (event: RunEvent): void => {
    sessions.appendEvent(sessionId, asst.id, event);
  };

  const abort = new AbortController();
  turnAborts.get(sessionId)?.abort();
  turnAborts.set(sessionId, abort);

  const runtime = sessions.runtime(sessionId)!;

  // Peer events emitted by a delegated run are folded into the parent's
  // assistant message with a `[runner]` chip in the name so the TUI can
  // render them inline alongside the parent's own events. Same forwarder for
  // both branches — a function over the parent's onEvent closure.
  //
  // text_delta and atomic-mode thinking are wrapped in synthetic tool_log
  // events that carry a stable `id` (e.g. `peer:<runId>:text:<chunk>`). The
  // append-event path replaces matching ids in place, so a streaming peer
  // reply renders as a single block whose body grows — without that wrapping,
  // peer deltas would silently merge into the parent's text run via the
  // transcript's text_delta concatenation, which is confusing.
  //
  // We bump the chunk counter whenever the peer transitions OUT of a text
  // run (emits a tool_log, atomic thinking, or error). That way, "text →
  // tool → more text" renders as two separate reply blocks bracketing the
  // peer's tool call, matching the natural interleaving.
  type PeerState = { textBuf: string; chunk: number };
  const peerStates = new Map<string, PeerState>();
  const stateFor = (runId: string): PeerState => {
    let s = peerStates.get(runId);
    if (!s) {
      s = { textBuf: "", chunk: 0 };
      peerStates.set(runId, s);
    }
    return s;
  };
  const flushText = (s: PeerState): void => {
    if (s.textBuf) {
      s.textBuf = "";
      s.chunk += 1;
    }
  };
  const forwardPeerEvent = (record: DelegateRunRecord, event: RunEvent) => {
    const s = stateFor(record.runId);
    if (event.type === "text_delta") {
      s.textBuf += event.delta;
      onEvent({
        type: "tool_log",
        log: {
          id: `peer:${record.runId}:text:${s.chunk}`,
          name: `[${record.runner}] reply`,
          output: s.textBuf,
        },
      });
    } else if (event.type === "tool_log") {
      flushText(s);
      onEvent({
        type: "tool_log",
        log: {
          ...event.log,
          name: `[${record.runner}] ${event.log.name}`,
        },
      });
    } else if (event.type === "thinking" && typeof event.text === "string") {
      // Atomic-mode thinking carries its full text on the event; render it as
      // its own block. Marker-mode (text undefined) is skipped here because
      // we've already wrapped the preceding deltas as a reply block, not as
      // an untyped text run we could reclassify.
      flushText(s);
      onEvent({
        type: "tool_log",
        log: {
          id: `peer:${record.runId}:think:${s.chunk}`,
          name: `[${record.runner}] thinking`,
          output: `(${event.seconds}s) ${event.text}`,
        },
      });
      s.chunk += 1;
    } else if (event.type === "error") {
      flushText(s);
      onEvent({
        type: "error",
        message: `[${record.runner}] ${event.message}`,
      });
    }
  };
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

  try {
    if (session.activeRunner === "claude") {
      // In-process MCP server — same process, no HTTP hop.
      const orchestrator = buildDelegateMcpServer({
        parentRunner: "claude",
        parentSessionId: sessionId,
        parentCwd: session.cwd,
        depth: 0,
        onPeerEvent: forwardPeerEvent,
        onStatsChange,
      });
      await runClaude({
        prompt: text,
        cwd: session.cwd,
        resumeId: runtime.claudeSessionId,
        model: session.models.claude,
        allowRules: permissions.list(),
        permissionMode: session.claudeMode,
        abortController: abort,
        mcpServers: { orchestrator },
        canUseTool: async (toolName, input, ctx) => {
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
        onRaw: (raw) => sessions.logRaw(sessionId, asst.id, "claude", raw),
        onResumeId: (id) => {
          if (id) runtime.claudeSessionId = id;
          else delete runtime.claudeSessionId;
          sessions.logRuntime(sessionId, "claudeSessionId", id);
          sessions.markDirty();
        },
      });
    } else {
      // Codex CLI only accepts stdio MCP servers, so wire it to spawn our
      // own child (mcp-codex-orchestrator.mjs) that proxies tool calls back
      // to /internal/delegate. parentSessionId + token + depth are passed via
      // env on the spawn so the child's HTTP callbacks land on this session.
      await runCodex({
        prompt: text,
        cwd: session.cwd,
        threadId: runtime.codexThreadId,
        model: session.models.codex,
        signal: abort.signal,
        onEvent,
        onRaw: (raw) => sessions.logRaw(sessionId, asst.id, "codex", raw),
        onThreadId: (id) => {
          if (id) runtime.codexThreadId = id;
          else delete runtime.codexThreadId;
          sessions.logRuntime(sessionId, "codexThreadId", id);
          sessions.markDirty();
        },
        orchestrator: {
          url: `http://127.0.0.1:${port}`,
          token: ORCHESTRATOR_TOKEN,
          scriptPath: ORCHESTRATOR_SCRIPT_PATH,
          parentSessionId: sessionId,
          parentRunner: "codex",
          parentCwd: session.cwd,
          depth: 0,
        },
      });
    }
  } catch (err) {
    onEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (turnAborts.get(sessionId) === abort) turnAborts.delete(sessionId);
    unregisterParentCallbacks(sessionId);
    sessions.finishMessage(sessionId, asst.id);
  }
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

function sendTo(ws: { send: (data: string) => void }, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignored
  }
}

const port = Number(process.env.PORT ?? 4567);
const wss = new WebSocketServer({ noServer: true });

serve(
  { fetch: app.fetch, port, hostname: "127.0.0.1", websocket: { server: wss } },
  (info) => {
    console.log(`adverserial backend listening on http://127.0.0.1:${info.port}`);
  },
);

// Flush pending session writes when bin/start.mjs sends SIGTERM on TUI exit.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    sessions.flush();
    sessions.transcript.closeAll();
    process.exit(0);
  });
}
