// Wire protocol between the TUI client and the Hono server.
// Transport is a single persistent WebSocket at GET /ws.

export type RunnerKind = "claude" | "codex";

export type ToolLog = {
  name: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

// Streaming events emitted by an SDK runner while a turn is in flight.
export type RunEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_log"; log: ToolLog }
  | {
      type: "usage";
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | { type: "error"; message: string };

export type SessionMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  events: RunEvent[];
  createdAt: string;
};

// Per-runner model override. Unset means the runner's SDK default is used.
export type ModelOverrides = {
  claude?: string;
  codex?: string;
};

// Claude SDK permission modes that we expose through the UI. Subset of the
// SDK's full enum — we omit `dontAsk` and `auto` until there's a use case.
//   default          — prompt for dangerous ops via canUseTool
//   acceptEdits      — auto-allow file edits, still prompt for other tools
//   plan             — propose a plan; no tools execute
//   bypassPermissions — skip every prompt (dangerous; requires SDK opt-in flag)
// Claude only — Codex SDK has no equivalent; the field is ignored when
// activeRunner === "codex".
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

// Snapshot of git state at the session's cwd. `null` outside a repo or
// before the first probe completes. Refreshed periodically by the server.
export type GitInfo = {
  branch: string | null;
  dirty: boolean;
};

export type Session = {
  id: string;
  title: string;
  activeRunner: RunnerKind;
  cwd: string;
  messages: SessionMessage[];
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  models: ModelOverrides;
  claudeMode: ClaudePermissionMode;
  git: GitInfo | null;
};

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

// One pending tool-permission prompt. `suggestions` are SDK-generated rule
// strings (e.g. "Bash(npm install)"); the client should persist them verbatim
// when the user picks "allow always".
export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  tool: string;
  input: unknown;
  title?: string;
  description?: string;
  suggestions: string[];
};

// AskUserQuestion uses canUseTool as its user-input channel: the model emits
// the questions as the tool input, and the user's answers must be echoed back
// to the model via `updatedInput`. Keyed by question text (matches the SDK
// AskUserQuestionOutput shape). For multiSelect questions, the value is a
// comma-separated list of selected option labels.
export type AskUserAnnotation = {
  preview?: string;
  notes?: string;
};

// Client -> server.
export type ClientMsg =
  | { type: "subscribe"; sessionId: string }
  | { type: "create_session"; title?: string; runner?: RunnerKind; cwd?: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "set_runner"; sessionId: string; runner: RunnerKind }
  | { type: "clear_session"; sessionId: string }
  | {
      type: "set_model";
      sessionId: string;
      runner: RunnerKind;
      // null clears the override and returns to the SDK default
      model: string | null;
    }
  | { type: "set_claude_mode"; sessionId: string; mode: ClaudePermissionMode }
  | { type: "send"; sessionId: string; text: string }
  | { type: "interrupt"; sessionId: string }
  | {
      type: "permission_response";
      requestId: string;
      decision: PermissionDecision;
      answers?: Record<string, string>;
      annotations?: Record<string, AskUserAnnotation>;
    }
  | { type: "list_permissions" }
  | { type: "add_permission"; rule: string }
  | { type: "remove_permission"; rule: string }
  | { type: "clear_permissions" };

// Server -> client.
export type ServerMsg =
  | { type: "hello"; sessions: Session[]; permissions: string[] }
  | { type: "session_updated"; session: Session }
  | { type: "session_deleted"; sessionId: string }
  | { type: "message_started"; sessionId: string; message: SessionMessage }
  | {
      type: "event";
      sessionId: string;
      messageId: string;
      event: RunEvent;
    }
  | { type: "message_done"; sessionId: string; messageId: string }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "permissions"; rules: string[] }
  | { type: "error"; sessionId?: string; message: string };
