import { nanoid } from "nanoid";
import type { WSContext } from "hono/ws";
import type {
  ClaudePermissionMode,
  GitInfo,
  ModelOverrides,
  RunEvent,
  RunnerKind,
  ServerMsg,
  Session,
  SessionMessage,
} from "../../shared/events.js";

type SessionRuntime = {
  claudeSessionId?: string;
  codexThreadId?: string;
};

type Stored = Session & { runtime: SessionRuntime };

export class SessionManager {
  private sessions: Stored[] = [];
  private subscribers = new Set<WSContext>();

  list(): Session[] {
    return this.sessions.map(toWire);
  }

  get(id: string): Stored | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  create(opts: { title?: string; runner?: RunnerKind; cwd?: string } = {}): Stored {
    const now = new Date().toISOString();
    const s: Stored = {
      id: nanoid(),
      title: opts.title?.trim() || `Session ${this.sessions.length + 1}`,
      activeRunner: opts.runner ?? "claude",
      cwd: opts.cwd?.trim() || process.cwd(),
      messages: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      models: {},
      claudeMode: "default",
      git: null,
      runtime: {},
    };
    this.sessions.push(s);
    this.broadcast({ type: "session_updated", session: toWire(s) });
    return s;
  }

  delete(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.broadcast({ type: "session_deleted", sessionId: id });
    return true;
  }

  // Flush messages + the runner-side conversation ids so the next turn starts
  // fresh. Deliberately preserves: title, runner, cwd, models, claudeMode,
  // git, createdAt. /clear should drop context, not preferences.
  clearSession(id: string): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    s.messages = [];
    s.streaming = false;
    s.updatedAt = new Date().toISOString();
    s.runtime = {};
    this.broadcast({ type: "session_updated", session: toWire(s) });
    return s;
  }

  setRunner(id: string, runner: RunnerKind): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    s.activeRunner = runner;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "session_updated", session: toWire(s) });
    return s;
  }

  setClaudeMode(id: string, mode: ClaudePermissionMode): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    if (s.claudeMode === mode) return s;
    s.claudeMode = mode;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "session_updated", session: toWire(s) });
    return s;
  }

  setGit(id: string, git: GitInfo | null): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    s.git = git;
    // Don't bump updatedAt — git polling shouldn't make a session appear
    // "active" in the sidebar's recency ordering.
    this.broadcast({ type: "session_updated", session: toWire(s) });
    return s;
  }

  setModel(id: string, runner: RunnerKind, model: string | null): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    const next: ModelOverrides = { ...s.models };
    if (model && model.trim()) next[runner] = model.trim();
    else delete next[runner];
    s.models = next;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "session_updated", session: toWire(s) });
    return s;
  }

  startMessage(sessionId: string, role: "user" | "assistant", text = ""): SessionMessage | null {
    const s = this.get(sessionId);
    if (!s) return null;
    const msg: SessionMessage = {
      id: nanoid(),
      role,
      text,
      events: [],
      createdAt: new Date().toISOString(),
    };
    s.messages.push(msg);
    s.updatedAt = msg.createdAt;
    if (role === "assistant") s.streaming = true;
    this.broadcast({ type: "message_started", sessionId, message: msg });
    return msg;
  }

  appendEvent(sessionId: string, messageId: string, event: RunEvent): void {
    const s = this.get(sessionId);
    if (!s) return;
    const m = s.messages.find((m) => m.id === messageId);
    if (!m) return;
    m.events.push(event);
    if (event.type === "text_delta") m.text += event.delta;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "event", sessionId, messageId, event });
  }

  finishMessage(sessionId: string, messageId: string): void {
    const s = this.get(sessionId);
    if (!s) return;
    s.streaming = false;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "message_done", sessionId, messageId });
  }

  runtime(id: string): SessionRuntime | null {
    return this.get(id)?.runtime ?? null;
  }

  subscribe(ws: WSContext): void {
    this.subscribers.add(ws);
  }

  unsubscribe(ws: WSContext): void {
    this.subscribers.delete(ws);
  }

  broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.subscribers) {
      try {
        ws.send(payload);
      } catch {
        // dead socket; will be removed on close
      }
    }
  }
}

function toWire(s: Stored): Session {
  const { runtime: _runtime, ...wire } = s;
  return { ...wire };
}
