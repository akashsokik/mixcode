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

const sessions = new SessionManager();
sessions.create({ title: "Session 1" });

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      sessions.subscribe(ws);
      sendTo(ws, { type: "hello", sessions: sessions.list() });
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

    case "create_session":
      sessions.create({ title: msg.title, runner: msg.runner });
      return;

    case "delete_session":
      sessions.delete(msg.sessionId);
      return;

    case "set_runner":
      sessions.setRunner(msg.sessionId, msg.runner);
      return;

    case "send":
      await runTurn(msg.sessionId, msg.text);
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

  const runtime = sessions.runtime(sessionId)!;
  try {
    if (session.activeRunner === "claude") {
      await runClaude({
        prompt: text,
        resumeId: runtime.claudeSessionId,
        onEvent,
        onResumeId: (id) => {
          if (id) runtime.claudeSessionId = id;
          else delete runtime.claudeSessionId;
        },
      });
    } else {
      await runCodex({
        prompt: text,
        threadId: runtime.codexThreadId,
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
    sessions.finishMessage(sessionId, asst.id);
  }
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
