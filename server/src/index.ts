import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type {
  ClientMsg,
  RunEvent,
  ServerMsg,
} from "../../shared/events.js";
import { SessionManager } from "./sessions.js";
import { runClaude } from "./runners/claude.js";
import { runCodex } from "./runners/codex.js";
import { PermissionStore } from "./permissions.js";
import { gitInfoEquals, readGitInfo } from "./git.js";

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
  try {
    if (session.activeRunner === "claude") {
      await runClaude({
        prompt: text,
        cwd: session.cwd,
        resumeId: runtime.claudeSessionId,
        model: session.models.claude,
        allowRules: permissions.list(),
        permissionMode: session.claudeMode,
        abortController: abort,
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
        onResumeId: (id) => {
          if (id) runtime.claudeSessionId = id;
          else delete runtime.claudeSessionId;
        },
      });
    } else {
      await runCodex({
        prompt: text,
        cwd: session.cwd,
        threadId: runtime.codexThreadId,
        model: session.models.codex,
        signal: abort.signal,
        onEvent,
        onThreadId: (id) => {
          if (id) runtime.codexThreadId = id;
          else delete runtime.codexThreadId;
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
