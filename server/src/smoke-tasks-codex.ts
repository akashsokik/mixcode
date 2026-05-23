// End-to-end smoke for the Task orchestrator tools with CODEX as the
// orchestrator. Exercises the HTTP-proxy path (Codex stdio MCP child ->
// /internal/delegate -> task_* handlers). Fan-out is to two Claude peers.
//
//   1. Connect to ws://127.0.0.1:4567/ws
//   2. Create a Codex session
//   3. Ask Codex to: task_create, task_spawn (two Claude subtasks),
//      task_await, task_done
//   4. Verify a tool_log with name="task" arrives and transitions to done.
//
// Run with: npx tsx server/src/smoke-tasks-codex.ts
import { WebSocket } from "ws";

const URL = "ws://127.0.0.1:4567/ws";
const CWD = process.env.SMOKE_CWD ?? process.cwd();
const TIMEOUT_MS = 240_000;

const PROMPT = [
  "Use the task tools now. Follow these steps in order, exactly:",
  "1) Call task_create with title='codex smoke fan-out'.",
  "2) Call task_spawn with the taskId from step 1 and these 2 subtasks:",
  "   - {runner:'claude', prompt:'Respond with only the word ALPHA.'}",
  "   - {runner:'claude', prompt:'Respond with only the word BETA.'}",
  "   Use maxConcurrent=2 and timeoutSec=90.",
  "3) Call task_await with the taskId and timeoutSec=180.",
  "4) Call task_done with the taskId and summary='ok'.",
  "5) Reply with just the two subtask results separated by a space.",
].join("\n");

type AnyMsg = Record<string, unknown>;
const ts = (): string => new Date().toISOString().slice(11, 23);
const log = (label: string, payload?: unknown): void => {
  if (payload === undefined) console.log(`[${ts()}] ${label}`);
  else console.log(`[${ts()}] ${label}`, payload);
};

const ws = new WebSocket(URL);
let sessionId: string | null = null;
let sawTaskCard = false;
let sawDone = false;
let messageDone = false;
let textBuf = "";

const hardTimeout = setTimeout(() => {
  log("HARD TIMEOUT", { sessionId, sawTaskCard, sawDone, textPreview: textBuf.slice(0, 200) });
  try { ws.close(); } catch {}
  process.exit(2);
}, TIMEOUT_MS);

ws.on("open", () => log("ws open"));
ws.on("close", () => {
  clearTimeout(hardTimeout);
  const ok = messageDone && sawTaskCard && sawDone;
  log("ws closed", { ok, messageDone, sawTaskCard, sawDone });
  process.exit(ok ? 0 : 1);
});
ws.on("error", (e) => log("ws error", { msg: (e as Error).message }));

ws.on("message", (raw) => {
  let msg: AnyMsg;
  try {
    msg = JSON.parse(String(raw)) as AnyMsg;
  } catch {
    log("bad json", { raw: String(raw).slice(0, 200) });
    return;
  }
  switch (msg.type) {
    case "hello":
      log("hello", { sessions: (msg.sessions as unknown[])?.length ?? 0 });
      ws.send(
        JSON.stringify({
          type: "create_session",
          title: "codex task smoke",
          runner: "codex",
          cwd: CWD,
        }),
      );
      break;
    case "session_updated": {
      const sess = msg.session as { id: string; title: string };
      if (!sessionId && sess?.title === "codex task smoke") {
        sessionId = sess.id;
        log("session created (codex)", { sessionId });
        ws.send(JSON.stringify({ type: "send", sessionId, text: PROMPT }));
      }
      break;
    }
    case "event": {
      if (msg.sessionId !== sessionId) return;
      const ev = msg.event as {
        type: string;
        log?: { name?: string; output?: unknown; isError?: boolean };
        delta?: string;
        message?: string;
      };
      if (!ev) return;
      if (ev.type === "tool_log") {
        const name = ev.log?.name ?? "?";
        const out = typeof ev.log?.output === "string"
          ? ev.log.output
          : JSON.stringify(ev.log?.output ?? null);
        if (name === "task") {
          sawTaskCard = true;
          const parsed = ev.log?.output as { status?: string; counts?: Record<string, number> } | undefined;
          log("task snapshot", {
            status: parsed?.status,
            counts: parsed?.counts,
          });
          if (parsed?.status === "done") sawDone = true;
        } else {
          log("tool_log", { name, isError: ev.log?.isError ?? false, outPreview: out.slice(0, 160) });
        }
      } else if (ev.type === "text_delta") {
        textBuf += ev.delta ?? "";
      } else if (ev.type === "error") {
        log("ERROR event", { message: ev.message });
      }
      break;
    }
    case "permission_request": {
      const req = msg.request as { requestId: string; tool: string };
      log("permission_request (auto-allow)", { tool: req?.tool });
      ws.send(
        JSON.stringify({
          type: "permission_response",
          requestId: req.requestId,
          decision: "allow_once",
        }),
      );
      break;
    }
    case "message_done":
      if (msg.sessionId === sessionId) {
        messageDone = true;
        log("MESSAGE DONE", { sawTaskCard, sawDone, textPreview: textBuf.slice(0, 240) });
        ws.send(JSON.stringify({ type: "delete_session", sessionId }));
        setTimeout(() => { try { ws.close(); } catch {} }, 500);
      }
      break;
    case "error":
      log("server error", { sessionId: msg.sessionId, message: msg.message });
      break;
    default:
      break;
  }
});
