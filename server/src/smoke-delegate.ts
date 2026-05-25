// End-to-end smoke test for the delegate_run MCP tool.
//   1. Connect to ws://127.0.0.1:4567/ws
//   2. Create a fresh Claude session at this repo
//   3. Ask Claude to delegate a trivial prompt to Codex with wait=true
//   4. Stream events until message_done OR hard timeout
//
// Run with: bun --cwd server src/smoke-delegate.ts  (or via tsx)
import { WebSocket } from "ws";

const URL = "ws://127.0.0.1:4567/ws";
const CWD = "/Users/akashswamy/Workspace/fun-projects/adverserial-code";
const TIMEOUT_MS = 120_000;

const PROMPT =
  "Use the delegate_run tool now. profileName='codex', " +
  "prompt='Respond with exactly the word PONG and nothing else.', " +
  "wait=true, timeoutSec=60. Then reply with just the peer's result string.";

type AnyMsg = Record<string, any>;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function log(label: string, payload?: unknown): void {
  if (payload === undefined) console.log(`[${ts()}] ${label}`);
  else console.log(`[${ts()}] ${label}`, payload);
}

const ws = new WebSocket(URL);
let sessionId: string | null = null;
let assistantMsgId: string | null = null;
let textBuf = "";
let done = false;

const hardTimeout = setTimeout(() => {
  log("HARD TIMEOUT", { sessionId, assistantMsgId, textPreview: textBuf.slice(0, 200) });
  ws.close();
  process.exit(2);
}, TIMEOUT_MS);

ws.on("open", () => log("ws open"));

ws.on("close", () => {
  log("ws closed");
  clearTimeout(hardTimeout);
  process.exit(done ? 0 : 1);
});

ws.on("error", (e) => {
  log("ws error", { msg: (e as Error).message });
});

ws.on("message", (raw) => {
  let msg: AnyMsg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    log("bad json", { raw: String(raw).slice(0, 200) });
    return;
  }

  switch (msg.type) {
    case "hello":
      log("hello", { sessionCount: msg.sessions?.length ?? 0 });
      ws.send(
        JSON.stringify({
          type: "create_session",
          title: "delegate smoke",
          runner: "claude",
          cwd: CWD,
        }),
      );
      break;

    case "session_updated":
      if (!sessionId && msg.session?.title === "delegate smoke") {
        sessionId = msg.session.id;
        log("session created", { sessionId });
        ws.send(JSON.stringify({ type: "send", sessionId, text: PROMPT }));
      }
      break;

    case "message_started":
      if (msg.sessionId === sessionId && msg.message?.role === "assistant") {
        assistantMsgId = msg.message.id;
        log("assistant message started", { assistantMsgId });
      } else if (msg.sessionId === sessionId && msg.message?.role === "user") {
        log("user message persisted");
      }
      break;

    case "event": {
      if (msg.sessionId !== sessionId) return;
      const ev = msg.event;
      if (!ev) return;
      if (ev.type === "text_delta") {
        textBuf += ev.delta;
        // Log occasional progress, not every delta.
        if (textBuf.length % 80 === 0) {
          log("text progress", { len: textBuf.length });
        }
      } else if (ev.type === "tool_log") {
        const name = ev.log?.name ?? "?";
        const out =
          typeof ev.log?.output === "string"
            ? ev.log.output.slice(0, 200)
            : JSON.stringify(ev.log?.output ?? null).slice(0, 200);
        log("tool_log", {
          name,
          isError: ev.log?.isError ?? false,
          input: JSON.stringify(ev.log?.input ?? null).slice(0, 200),
          output: out,
        });
      } else if (ev.type === "error") {
        log("ERROR event", { message: ev.message });
      } else {
        log("event", ev);
      }
      break;
    }

    case "message_done":
      if (msg.sessionId === sessionId) {
        done = true;
        log("MESSAGE DONE", { textPreview: textBuf.slice(0, 400), len: textBuf.length });
        ws.send(JSON.stringify({ type: "delete_session", sessionId }));
        setTimeout(() => ws.close(), 500);
      }
      break;

    case "error":
      log("server error", { sessionId: msg.sessionId, message: msg.message });
      break;

    case "permission_request":
      // Auto-allow once so the test can proceed if Claude asks for any tool.
      log("permission_request (auto-allow)", { tool: msg.request?.tool });
      ws.send(
        JSON.stringify({
          type: "permission_response",
          requestId: msg.request.requestId,
          decision: "allow_once",
        }),
      );
      break;

    default:
      // ignore other types (session_deleted, permission_resolved, etc.)
      break;
  }
});
