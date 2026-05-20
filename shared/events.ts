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

export type Session = {
  id: string;
  title: string;
  activeRunner: RunnerKind;
  messages: SessionMessage[];
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};

// Client -> server.
export type ClientMsg =
  | { type: "subscribe"; sessionId: string }
  | { type: "create_session"; title?: string; runner?: RunnerKind }
  | { type: "delete_session"; sessionId: string }
  | { type: "set_runner"; sessionId: string; runner: RunnerKind }
  | { type: "send"; sessionId: string; text: string };

// Server -> client.
export type ServerMsg =
  | { type: "hello"; sessions: Session[] }
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
  | { type: "error"; sessionId?: string; message: string };
