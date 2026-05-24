import { nanoid } from "nanoid";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WSContext } from "hono/ws";
import type {
  ClaudePermissionMode,
  DelegationStats,
  GitInfo,
  ModelOverrides,
  RunEvent,
  RunnerKind,
  ServerMsg,
  Session,
  SessionMessage,
} from "../../shared/events.js";
import { TranscriptLogger } from "./transcript.js";

type SessionRuntime = {
  claudeSessionId?: string;
  codexThreadId?: string;
  // Vercel AI SDK has no server-side thread/session resume — we store the
  // running ModelMessage[] here so the next turn can pass them back to
  // streamText. Plain unknown[] to avoid coupling the persistence shape to
  // the SDK's type; the vercel runner narrows when reading.
  vercelMessages?: unknown[];
  // Provider of the last vercel turn ("openai" | "anthropic"). Used to
  // reset the message history when the user switches between provider
  // families mid-session — the on-wire tool-call shapes differ enough
  // that a cross-provider replay rejects on the next call.
  vercelLastProvider?: string;
};

type Stored = Session & { runtime: SessionRuntime };

const STORE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 200;

type StoreFile = {
  version: number;
  sessions: Stored[];
};

function defaultStorePath(): string {
  if (process.env.MIXCODE_SESSION_FILE) return process.env.MIXCODE_SESSION_FILE;
  return path.join(os.homedir(), ".adverserial-code", "sessions.json");
}

export class SessionManager {
  private sessions: Stored[] = [];
  private subscribers = new Set<WSContext>();
  private storePath: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  readonly transcript: TranscriptLogger;

  constructor(storePath: string = defaultStorePath(), transcript?: TranscriptLogger) {
    this.storePath = storePath;
    this.transcript = transcript ?? new TranscriptLogger();
    this.load();
  }

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
    this.transcript.log({
      kind: "session_created",
      sessionId: s.id,
      title: s.title,
      runner: s.activeRunner,
      cwd: s.cwd,
    });
    this.broadcast({ type: "session_updated", session: toWire(s) });
    this.markDirty();
    return s;
  }

  delete(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.transcript.log({ kind: "session_deleted", sessionId: id });
    this.transcript.close(id);
    this.broadcast({ type: "session_deleted", sessionId: id });
    this.markDirty();
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
    this.transcript.log({ kind: "session_cleared", sessionId: id });
    this.broadcast({ type: "session_updated", session: toWire(s) });
    this.markDirty();
    return s;
  }

  setRunner(id: string, runner: RunnerKind): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    s.activeRunner = runner;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "session_updated", session: toWire(s) });
    this.markDirty();
    return s;
  }

  setClaudeMode(id: string, mode: ClaudePermissionMode): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    if (s.claudeMode === mode) return s;
    s.claudeMode = mode;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "session_updated", session: toWire(s) });
    this.markDirty();
    return s;
  }

  setGit(id: string, git: GitInfo | null): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    s.git = git;
    // Don't bump updatedAt — git polling shouldn't make a session appear
    // "active" in the sidebar's recency ordering.
    this.broadcast({ type: "session_updated", session: toWire(s) });
    // Git is re-polled on every boot, so skip the disk write for this one.
    return s;
  }

  setDelegations(id: string, stats: DelegationStats | null): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    if (stats == null) delete s.delegations;
    else s.delegations = stats;
    // Same rationale as setGit — counter updates shouldn't bump recency.
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
    this.markDirty();
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
    this.transcript.log({
      kind: "message_started",
      sessionId,
      messageId: msg.id,
      role,
      text,
    });
    this.broadcast({ type: "message_started", sessionId, message: msg });
    this.markDirty();
    return msg;
  }

  appendEvent(sessionId: string, messageId: string, event: RunEvent): void {
    const s = this.get(sessionId);
    if (!s) return;
    const m = s.messages.find((m) => m.id === messageId);
    if (!m) return;
    // tool_log events with a stable `id` replace any earlier event with the
    // same id (used for streaming peer reply text). Without dedupe, a 1000-
    // delta peer reply would push 1000 ever-growing tool_log entries into the
    // events array. The broadcast still goes out every time so clients see
    // the stream; the persisted array stays compact.
    if (event.type === "tool_log" && event.log.id) {
      const idx = m.events.findIndex(
        (e) => e.type === "tool_log" && e.log.id === event.log.id,
      );
      if (idx >= 0) m.events[idx] = event;
      else m.events.push(event);
    } else {
      m.events.push(event);
    }
    if (event.type === "text_delta") m.text += event.delta;
    s.updatedAt = new Date().toISOString();
    this.transcript.log({ kind: "event", sessionId, messageId, event });
    this.broadcast({ type: "event", sessionId, messageId, event });
    this.markDirty();
  }

  finishMessage(sessionId: string, messageId: string): void {
    const s = this.get(sessionId);
    if (!s) return;
    s.streaming = false;
    s.updatedAt = new Date().toISOString();
    this.transcript.log({ kind: "message_done", sessionId, messageId });
    this.broadcast({ type: "message_done", sessionId, messageId });
    this.markDirty();
  }

  // Called from index.ts when a runner emits a raw SDK message. Kept separate
  // from RunEvents so the audit log captures detail we drop on the way to the
  // wire protocol (system init, raw tool_use ids, result subtype, etc).
  logRaw(sessionId: string, messageId: string, runner: RunnerKind, raw: unknown): void {
    this.transcript.log({ kind: "raw_sdk", sessionId, messageId, runner, raw });
  }

  logRuntime(
    sessionId: string,
    field: "claudeSessionId" | "codexThreadId" | "vercelMessages",
    value: string | number | null,
  ): void {
    this.transcript.log({ kind: "runtime", sessionId, field, value });
  }

  runtime(id: string): SessionRuntime | null {
    return this.get(id)?.runtime ?? null;
  }

  // Public so index.ts can flag a write after mutating the runtime object
  // returned by runtime(). Debounced; safe to call on every keystroke.
  markDirty(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref?.();
  }

  // Synchronous write — call from process exit handlers so pending state
  // survives a SIGINT/SIGTERM.
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const payload: StoreFile = { version: STORE_VERSION, sessions: this.sessions };
    const dir = path.dirname(this.storePath);
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf8");
      renameSync(tmp, this.storePath);
    } catch (err) {
      console.error("[sessions] persist failed:", err);
      // Re-flag so the next mutation retries.
      this.dirty = true;
    }
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

  private load(): void {
    if (!existsSync(this.storePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.storePath, "utf8");
    } catch (err) {
      console.error("[sessions] read failed, starting empty:", err);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("[sessions] parse failed, backing up and starting empty:", err);
      this.backupCorrupt();
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as StoreFile).version !== STORE_VERSION ||
      !Array.isArray((parsed as StoreFile).sessions)
    ) {
      console.error("[sessions] unexpected store shape, backing up and starting empty");
      this.backupCorrupt();
      return;
    }
    const loaded = (parsed as StoreFile).sessions;
    // Any session marked streaming was mid-turn at shutdown — the runner is
    // gone, no more events are coming, so settle it.
    for (const s of loaded) {
      s.streaming = false;
      if (!s.runtime) s.runtime = {};
    }
    this.sessions = loaded;
  }

  private backupCorrupt(): void {
    try {
      const backup = `${this.storePath}.corrupt-${Date.now()}`;
      renameSync(this.storePath, backup);
      console.error(`[sessions] previous store saved to ${backup}`);
    } catch {
      // best-effort
    }
  }
}

function toWire(s: Stored): Session {
  const { runtime: _runtime, ...wire } = s;
  return { ...wire };
}
