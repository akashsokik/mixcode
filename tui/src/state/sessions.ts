import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ClientMsg,
  RunnerKind,
  Session,
  ServerMsg,
} from "../../../shared/events.ts";
import { WSClient, type WSStatus } from "../api/ws";

const DEFAULT_URL = "ws://127.0.0.1:4567/ws";

type State = {
  sessions: Session[];
  activeId: string | null;
};

const initialState: State = { sessions: [], activeId: null };

function reduce(state: State, msg: ServerMsg): State {
  switch (msg.type) {
    case "hello": {
      const sessions = msg.sessions;
      const activeId = state.activeId
        ? sessions.find((s) => s.id === state.activeId)?.id ?? sessions[0]?.id ?? null
        : sessions[0]?.id ?? null;
      return { sessions, activeId };
    }

    case "session_updated": {
      const next = upsert(state.sessions, msg.session);
      return {
        sessions: next,
        activeId: state.activeId ?? msg.session.id,
      };
    }

    case "session_deleted": {
      const sessions = state.sessions.filter((s) => s.id !== msg.sessionId);
      const activeId =
        state.activeId === msg.sessionId ? sessions[0]?.id ?? null : state.activeId;
      return { sessions, activeId };
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
          const events = [...m.events, msg.event];
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

    case "error":
      // Surfaced via status bar / toast in v2. For now, keep state stable.
      return state;
  }
}

function upsert(list: Session[], session: Session): Session[] {
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx === -1) return [session, ...list];
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
      send(client, { type: "create_session", title, runner });
    },
    deleteSession(id: string): void {
      send(client, { type: "delete_session", sessionId: id });
    },
    setRunner(runner: RunnerKind): void {
      if (!activeId) return;
      send(client, { type: "set_runner", sessionId: activeId, runner });
    },
    send(text: string): void {
      if (!activeId) return;
      send(client, { type: "send", sessionId: activeId, text });
    },
  };
}

function send(client: WSClient, msg: ClientMsg): void {
  client.send(msg);
}

export type SessionsApi = ReturnType<typeof useSessions>;
