// Builds the peer-event forwarder used by runTurn and runConsensusTurn.
//
// A delegated peer (via delegate_run, validate_run, task_spawn, or consensus
// rounds) emits its own RunEvents. We fold them into the parent's assistant
// message with a `[runner]` chip so the TUI renders them inline. text_delta
// and atomic-mode thinking are wrapped in synthetic tool_log events that
// carry a stable id (e.g. `peer:<runId>:text:<chunk>`) — the append-event
// path replaces matching ids in place so a streaming peer reply renders as
// one growing block instead of N concatenated blocks. The chunk counter
// bumps whenever the peer transitions OUT of a text run (tool_log, atomic
// thinking, error), so "text → tool → more text" renders as two reply blocks
// bracketing the peer's tool call.

import type { RunEvent } from "../../../shared/events.js";
import type { DelegateRunRecord } from "../runners/delegate.js";

export type PeerEventForwarder = (
  record: DelegateRunRecord,
  event: RunEvent,
) => void;

type PeerState = { textBuf: string; chunk: number };

export function buildPeerEventForwarder(
  onEvent: (event: RunEvent) => void,
): PeerEventForwarder {
  const peerStates = new Map<string, PeerState>();

  const stateFor = (runId: string): PeerState => {
    let s = peerStates.get(runId);
    if (!s) {
      s = { textBuf: "", chunk: 0 };
      peerStates.set(runId, s);
    }
    return s;
  };
  const flushText = (s: PeerState): void => {
    if (s.textBuf) {
      s.textBuf = "";
      s.chunk += 1;
    }
  };

  return (record, event) => {
    const s = stateFor(record.runId);
    if (event.type === "text_delta") {
      s.textBuf += event.delta;
      onEvent({
        type: "tool_log",
        log: {
          id: `peer:${record.runId}:text:${s.chunk}`,
          name: `[${record.runner}] reply`,
          output: s.textBuf,
        },
      });
    } else if (event.type === "tool_log") {
      flushText(s);
      onEvent({
        type: "tool_log",
        log: {
          ...event.log,
          name: `[${record.runner}] ${event.log.name}`,
        },
      });
    } else if (event.type === "thinking" && typeof event.text === "string") {
      flushText(s);
      onEvent({
        type: "tool_log",
        log: {
          id: `peer:${record.runId}:think:${s.chunk}`,
          name: `[${record.runner}] thinking`,
          output: `(${event.seconds}s) ${event.text}`,
        },
      });
      s.chunk += 1;
    } else if (event.type === "error") {
      flushText(s);
      onEvent({
        type: "error",
        message: `[${record.runner}] ${event.message}`,
      });
    }
  };
}
