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

// Short run-id for the transcript chip, matching the TUI's shortId() so a peer
// block in the transcript reads the same id as its node on the workflow card
// (and any other delegated run). Lets the user correlate `[ollama][run-id]` in
// the scroll with the `[ollama][run-id]` node row in the card/DAG view.
function shortRunId(runId: string): string {
  if (!runId) return "";
  return runId.length <= 9 ? runId : runId.slice(0, 8) + "…";
}

// The `[runner][run-id]` chip prefix prepended to every forwarded peer event.
// run-id is omitted only when the record has none (it always should).
function peerTag(runner: string, runId: string): string {
  const short = shortRunId(runId);
  return short ? `[${runner}][${short}]` : `[${runner}]`;
}

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
    const tag = peerTag(record.runner, record.runId);
    if (event.type === "text_delta") {
      s.textBuf += event.delta;
      onEvent({
        type: "tool_log",
        log: {
          id: `peer:${record.runId}:text:${s.chunk}`,
          name: `${tag} reply`,
          output: s.textBuf,
        },
      });
    } else if (event.type === "tool_log") {
      flushText(s);
      onEvent({
        type: "tool_log",
        log: {
          ...event.log,
          name: `${tag} ${event.log.name}`,
        },
      });
    } else if (event.type === "thinking" && typeof event.text === "string") {
      flushText(s);
      onEvent({
        type: "tool_log",
        log: {
          id: `peer:${record.runId}:think:${s.chunk}`,
          name: `${tag} thinking`,
          output: `(${event.seconds}s) ${event.text}`,
        },
      });
      s.chunk += 1;
    } else if (event.type === "error") {
      flushText(s);
      onEvent({
        type: "error",
        message: `${tag} ${event.message}`,
      });
    }
  };
}
