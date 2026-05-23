import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AskUserAnnotation,
  ClaudePermissionMode,
  ClientMsg,
  PermissionDecision,
  PermissionRequest,
  RunnerKind,
  Session,
  SessionMessage,
  ServerMsg,
} from "../../../shared/events.ts";
import { WSClient, type WSStatus } from "../api/ws";

export type PermissionResponsePayload = {
  answers?: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
};

const DEFAULT_URL = "ws://127.0.0.1:4567/ws";

type State = {
  sessions: Session[];
  activeId: string | null;
  pendingPermissions: PermissionRequest[];
  rules: string[];
  // True once the server's `hello` has been processed. The WS status flips to
  // "open" before `hello` arrives, so callers that need the authoritative
  // session list (e.g. the empty-list bootstrap) must wait on this instead.
  helloReceived: boolean;
};

const initialState: State = {
  sessions: [],
  activeId: null,
  pendingPermissions: [],
  rules: [],
  helloReceived: false,
};

function reduce(state: State, msg: ServerMsg): State {
  switch (msg.type) {
    case "hello": {
      const sessions = msg.sessions;
      const activeId = state.activeId
        ? sessions.find((s) => s.id === state.activeId)?.id ?? sessions[0]?.id ?? null
        : sessions[0]?.id ?? null;
      return {
        ...state,
        sessions,
        activeId,
        rules: msg.permissions,
        helloReceived: true,
      };
    }

    case "session_updated": {
      const next = upsert(state.sessions, msg.session);
      return {
        ...state,
        sessions: next,
        activeId: state.activeId ?? msg.session.id,
      };
    }

    case "session_deleted": {
      const sessions = state.sessions.filter((s) => s.id !== msg.sessionId);
      const activeId =
        state.activeId === msg.sessionId ? sessions[0]?.id ?? null : state.activeId;
      const pendingPermissions = state.pendingPermissions.filter(
        (p) => p.sessionId !== msg.sessionId,
      );
      return { ...state, sessions, activeId, pendingPermissions };
    }

    case "message_started": {
      const sessions = state.sessions.map((s) =>
        s.id === msg.sessionId
          ? {
              ...s,
              messages: [...s.messages, msg.message],
              streaming: msg.message.role === "assistant" ? true : s.streaming,
              updatedAt: msg.message.createdAt,
            }
          : s,
      );
      return { ...state, sessions };
    }

    case "event": {
      const sessions = state.sessions.map((s) => {
        if (s.id !== msg.sessionId) return s;
        const messages = s.messages.map((m) => {
          if (m.id !== msg.messageId) return m;
          // Mirror the server's dedupe: tool_log events with an `id` replace
          // any earlier event sharing that id. Keeps the local events array
          // consistent with what a fresh client receives via `hello`.
          let events: SessionMessage["events"];
          if (msg.event.type === "tool_log" && msg.event.log.id) {
            const id = msg.event.log.id;
            const idx = m.events.findIndex(
              (e) => e.type === "tool_log" && e.log.id === id,
            );
            if (idx >= 0) {
              events = m.events.slice();
              events[idx] = msg.event;
            } else {
              events = [...m.events, msg.event];
            }
          } else {
            events = [...m.events, msg.event];
          }
          const text =
            msg.event.type === "text_delta" ? m.text + msg.event.delta : m.text;
          return { ...m, text, events };
        });
        return { ...s, messages };
      });
      return { ...state, sessions };
    }

    case "message_done": {
      const sessions = state.sessions.map((s) =>
        s.id === msg.sessionId ? { ...s, streaming: false } : s,
      );
      return { ...state, sessions };
    }

    case "permission_request": {
      if (state.pendingPermissions.some((p) => p.requestId === msg.request.requestId)) {
        return state;
      }
      return {
        ...state,
        pendingPermissions: [...state.pendingPermissions, msg.request],
      };
    }

    case "permission_resolved": {
      const pendingPermissions = state.pendingPermissions.filter(
        (p) => p.requestId !== msg.requestId,
      );
      if (pendingPermissions.length === state.pendingPermissions.length) return state;
      return { ...state, pendingPermissions };
    }

    case "permissions":
      return { ...state, rules: msg.rules };

    case "error":
      // Surfaced via status bar / toast in v2. For now, keep state stable.
      return state;
  }
}

function upsert(list: Session[], session: Session): Session[] {
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx === -1) return [...list, session];
  const next = [...list];
  next[idx] = session;
  return next;
}

export function useSessions() {
  const clientRef = useRef<WSClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new WSClient(DEFAULT_URL);
  }
  const client = clientRef.current;

  const [state, dispatch] = useReducer(reduce, initialState);
  const [status, setStatus] = useState<WSStatus>(client.getStatus());
  // Local override of activeId so the UI can switch without a server round-trip.
  const [activeOverride, setActiveOverride] = useState<string | null>(null);

  useEffect(() => {
    const offMsg = client.on((msg) => dispatch(msg));
    const offStatus = client.onStatus(setStatus);
    return () => {
      offMsg();
      offStatus();
    };
  }, [client]);

  const activeId = activeOverride ?? state.activeId;
  const active = useMemo(
    () => state.sessions.find((s) => s.id === activeId) ?? null,
    [state.sessions, activeId],
  );

  return {
    sessions: state.sessions,
    activeId,
    active,
    status,
    helloReceived: state.helloReceived,
    pendingPermissions: state.pendingPermissions,
    rules: state.rules,

    setActive(id: string): void {
      setActiveOverride(id);
    },
    nextSession(): void {
      const i = state.sessions.findIndex((s) => s.id === activeId);
      const next = state.sessions[(i + 1 + state.sessions.length) % Math.max(state.sessions.length, 1)];
      if (next) setActiveOverride(next.id);
    },
    prevSession(): void {
      const i = state.sessions.findIndex((s) => s.id === activeId);
      const next = state.sessions[(i - 1 + state.sessions.length) % Math.max(state.sessions.length, 1)];
      if (next) setActiveOverride(next.id);
    },

    createSession(title?: string, runner?: RunnerKind): void {
      send(client, { type: "create_session", title, runner, cwd: process.cwd() });
    },
    deleteSession(id: string): void {
      send(client, { type: "delete_session", sessionId: id });
    },
    clearSession(id: string): void {
      send(client, { type: "clear_session", sessionId: id });
    },
    setRunner(runner: RunnerKind): void {
      if (!activeId) return;
      send(client, { type: "set_runner", sessionId: activeId, runner });
    },
    setModel(runner: RunnerKind, model: string | null): void {
      if (!activeId) return;
      send(client, { type: "set_model", sessionId: activeId, runner, model });
    },
    setClaudeMode(mode: ClaudePermissionMode): void {
      if (!activeId) return;
      send(client, { type: "set_claude_mode", sessionId: activeId, mode });
    },
    send(text: string): void {
      if (!activeId) return;
      send(client, { type: "send", sessionId: activeId, text });
    },
    interrupt(): void {
      if (!activeId) return;
      send(client, { type: "interrupt", sessionId: activeId });
    },
    respondPermission(
      requestId: string,
      decision: PermissionDecision,
      payload?: PermissionResponsePayload,
    ): void {
      send(client, {
        type: "permission_response",
        requestId,
        decision,
        answers: payload?.answers,
        annotations: payload?.annotations,
      });
    },
    addRule(rule: string): void {
      send(client, { type: "add_permission", rule });
    },
    removeRule(rule: string): void {
      send(client, { type: "remove_permission", rule });
    },
    clearRules(): void {
      send(client, { type: "clear_permissions" });
    },
    refreshRules(): void {
      send(client, { type: "list_permissions" });
    },
  };
}

function send(client: WSClient, msg: ClientMsg): void {
  client.send(msg);
}

export type SessionsApi = ReturnType<typeof useSessions>;
