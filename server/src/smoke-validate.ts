// End-to-end smoke test for the validate_run MCP tool.
//   1. Connect to ws://127.0.0.1:4567/ws
//   2. Create a fresh Claude session at this repo
//   3. Ask Claude to call validate_run with peer=codex against a trivial
//      claim that the validator can check by reading the repo
//   4. Stream events until message_done OR hard timeout
//   5. Confirm the validate_run tool_log carries a parsed verdict field
//
// Run with: bun --cwd server src/smoke-validate.ts  (or via tsx)
import { WebSocket } from "ws";

const URL = "ws://127.0.0.1:4567/ws";
const CWD = "/Users/akashswamy/Workspace/fun-projects/adverserial-code";
const TIMEOUT_MS = 240_000;

const PROMPT =
  "Use the validate_run tool now. peer='codex', " +
  "claim='The file server/src/runners/validate.ts exists in this repo and exports a function called executeValidate.', " +
  "timeoutSec=180. Then reply with just the verdict string from the tool result.";

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
let observedVerdict: string | null = null;
let verdictPayload: Record<string, unknown> | null = null;

const hardTimeout = setTimeout(() => {
  log("HARD TIMEOUT", {
    sessionId,
    assistantMsgId,
    textPreview: textBuf.slice(0, 200),
  });
  ws.close();
  process.exit(2);
}, TIMEOUT_MS);

ws.on("open", () => log("ws open"));

ws.on("close", () => {
  log("ws closed");
  clearTimeout(hardTimeout);
  // Exit codes: 0 = parsed verdict (pass/fail/needs_changes/unknown all OK),
  // 1 = message_done but no verdict found, 2 = hard timeout.
  if (done && observedVerdict) process.exit(0);
  if (done) process.exit(1);
  process.exit(1);
});

ws.on("error", (e) => {
  log("ws error", { msg: (e as Error).message });
});

function parseValidateOutput(output: unknown): Record<string, unknown> | null {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  if (typeof output !== "string") return null;
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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
          title: "validate smoke",
          runner: "claude",
          cwd: CWD,
        }),
      );
      break;

    case "session_updated":
      if (!sessionId && msg.session?.title === "validate smoke") {
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
        if (textBuf.length % 80 === 0) {
          log("text progress", { len: textBuf.length });
        }
      } else if (ev.type === "tool_log") {
        const name: string = ev.log?.name ?? "?";
        // Strip MCP namespacing the SDK adds (e.g. mcp__orchestrator__validate_run)
        const bare = name.replace(/^mcp__[^_]+__/, "");
        const isValidateAnchor = bare === "validate_run" && !name.startsWith("[");
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
        if (isValidateAnchor) {
          const parsed = parseValidateOutput(ev.log?.output);
          if (parsed && typeof parsed.verdict === "string") {
            verdictPayload = parsed;
            observedVerdict = parsed.verdict as string;
            log("VALIDATE VERDICT", {
              verdict: parsed.verdict,
              summary: parsed.summary,
              issueCount: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
            });
          } else {
            log("validate_run anchor lacked parseable verdict", { parsed });
          }
        }
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
        log("MESSAGE DONE", {
          textPreview: textBuf.slice(0, 400),
          len: textBuf.length,
          verdict: observedVerdict,
          verdictPayload,
        });
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
