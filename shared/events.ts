// Wire protocol between the TUI client and the Hono server.
// Transport is a single persistent WebSocket at GET /ws.

export type RunnerKind = "claude" | "codex" | "vercel";

export type ToolLog = {
  // Stable identifier used to update a tool_log in place. When the server
  // re-emits a tool_log event whose `id` matches one already in the message's
  // events array, the new event REPLACES the old one rather than appending.
  // Used to stream growing output (e.g. a peer agent's reply text) without
  // accumulating one block per delta. Omit for one-shot tool calls.
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

// Streaming events emitted by an SDK runner while a turn is in flight.
//
// `thinking` collapses thought content into a "> Thought (Ns)" block. Two
// shapes:
//   - marker mode (text omitted) — the client reclassifies the immediately
//     preceding run of text_delta events as the thought. Used when the
//     runner streamed the thinking text as deltas.
//   - atomic mode (text present) — the thought is delivered in one event;
//     no prior text_delta belongs to it. Used in non-streaming fallback
//     paths where event ordering can't carry a preceding-text contract.
export type RunEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_log"; log: ToolLog }
  | { type: "thinking"; seconds: number; text?: string }
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
  vercel?: string;
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

// Per-session counters for peer-agent delegations spawned via the
// orchestrator's `delegate_run` MCP tool. Updated by the server whenever a
// peer run starts or terminates. `total` is lifetime within the session
// process; `running` is the current in-flight count. `activePeer` names the
// peer for the most recent run-start (cleared once nothing is running).
export type DelegationStats = {
  total: number;
  running: number;
  ok: number;
  error: number;
  cancelled: number;
  activePeer?: RunnerKind;
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
  delegations?: DelegationStats;
};

// One skill as exposed to a runner session. SDK-sourced entries come from the
// Claude SDK's `system init` message (`skills: string[]` + `plugins`) and
// reflect what the agent actually has loaded for the turn — including
// plugin-bundled and built-in CLI skills the TUI can't see by scanning
// `~/.<runner>/skills`. FS-sourced entries are the legacy filesystem walk
// used as a bootstrap before the first turn (and the only source for Codex,
// whose SDK stream carries no equivalent skill listing).
export type SessionSkillEntry = {
  // Bare name (e.g. "use-railway") or plugin-qualified ("superpowers:brainstorming").
  name: string;
  source: "sdk" | "fs";
  // Set for SDK-sourced entries that originate from a plugin. Used by the
  // TUI to resolve descriptions out of the installed plugin cache.
  pluginName?: string;
  // True only for entries that live as a symlink under
  // `~/.<runner>/skills/<name>` and can be removed via /skills remove. SDK
  // entries from plugins / built-ins are false (the d action is hidden).
  isFsRemovable: boolean;
};

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

// /consensus is a single-cycle actor/critic pass: the producer writes ONE
// draft, the critic reviews it ONCE, and the loop ends regardless of the
// verdict. No retries — the user sees the draft + verdict and picks who
// implements it. `index` is always 0; the field is kept for forward
// compatibility but `iterations` always has length 1.
export type ConsensusVerdict = "agree" | "revise" | "unknown";
export type ConsensusIteration = {
  index: number;
  producerText: string;
  criticText: string;
  verdict: ConsensusVerdict;
  summary: string;
  // Set when the critic emitted a JSON block we couldn't parse. Treated
  // as "unknown" so the UI doesn't falsely claim agreement.
  parseError?: string;
};

// Final consensus output presented to the user. `finalDraft` is the
// producer's single-pass text. `converged` reflects whether the critic
// emitted AGREE on that one pass — it's informational only (no loop to
// converge), but the UI uses it to color the modal header.
// `suggestedRunner` defaults to the producer; the user can override.
export type ConsensusReady = {
  sessionId: string;
  messageId: string;
  task: string;
  producer: RunnerKind;
  critic: RunnerKind;
  iterations: ConsensusIteration[];
  finalDraft: string;
  converged: boolean;
  suggestedRunner: RunnerKind;
};

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
      type: "consensus_start";
      sessionId: string;
      task: string;
      // Per-call tool budget (Claude maxTurns / Vercel maxSteps). Opt-in;
      // unset = no per-peer SDK cap. The single-cycle bound (one producer
      // call + one critic call) is the primary safety guard.
      maxTurnsPerPeer?: number;
      // Producer override. Default: the session's active runner. The other
      // runner becomes the critic.
      producer?: RunnerKind;
    }
  | {
      type: "consensus_action";
      sessionId: string;
      action: "implement" | "cancel";
      runner?: RunnerKind;
      plan?: string;
    }
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
  | {
      type: "hello";
      sessions: Session[];
      permissions: string[];
      // Per-session SDK-sourced skill listings captured on the most recent
      // init. Empty for sessions that haven't run a turn yet. The runner tag
      // lets the client discard stale entries after the user switches runners
      // mid-session (e.g. claude -> codex).
      sessionSkills: Record<
        string,
        { runner: RunnerKind; entries: SessionSkillEntry[] }
      >;
    }
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
  | {
      type: "session_skills";
      sessionId: string;
      runner: RunnerKind;
      skills: SessionSkillEntry[];
    }
  | { type: "consensus_ready"; ready: ConsensusReady }
  | { type: "consensus_cleared"; sessionId: string }
  | { type: "error"; sessionId?: string; message: string };
