// End-to-end smoke test for codex-as-primary delegation:
// codex turn -> stdio MCP child -> /internal/delegate -> runClaude -> result.
import { WebSocket } from "ws";

const URL = "ws://127.0.0.1:4567/ws";
const CWD = "/Users/akashswamy/Workspace/fun-projects/adverserial-code";
const TIMEOUT_MS = 180_000;

const PROMPT =
  "Use the delegate_run MCP tool right now. Arguments: profileName=\"claude\", " +
  "prompt=\"Respond with exactly the word PONG and nothing else.\", wait=true, timeoutSec=60. " +
  "Then reply with just the peer's result string and nothing else.";

type AnyMsg = Record<string, any>;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (label: string, payload?: unknown) =>
  payload === undefined
    ? console.log(`[${ts()}] ${label}`)
    : console.log(`[${ts()}] ${label}`, payload);

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
ws.on("error", (e) => log("ws error", { msg: (e as Error).message }));

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
          title: "delegate smoke codex",
          runner: "codex",
          cwd: CWD,
        }),
      );
      break;

    case "session_updated":
      if (!sessionId && msg.session?.title === "delegate smoke codex") {
        sessionId = msg.session.id;
        log("codex session created", { sessionId });
        ws.send(JSON.stringify({ type: "send", sessionId, text: PROMPT }));
      } else if (sessionId && msg.session?.id === sessionId && msg.session?.delegations) {
        log("delegations update", msg.session.delegations);
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
        if (textBuf.length < 200 || textBuf.length % 200 === 0) {
          log("text progress", { len: textBuf.length });
        }
      } else if (ev.type === "tool_log") {
        const name = ev.log?.name ?? "?";
        const out =
          typeof ev.log?.output === "string"
            ? ev.log.output.slice(0, 240)
            : JSON.stringify(ev.log?.output ?? null).slice(0, 240);
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
      break;
  }
});
