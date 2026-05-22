import type {
  Session,
  SessionMessage,
  ToolLog,
} from "../../../shared/events.ts";
import { stripMcpPrefix, stripPeerPrefix } from "./format";

// Per-message render units extracted from the raw event stream. The transcript
// renders one of these per row (modulo grouping below); keeping the shape
// stable here means the grouping pass and the rendering pass agree on indices.
export type Block =
  | { kind: "text"; text: string }
  | { kind: "tool"; log: ToolLog }
  | { kind: "error"; message: string }
  | { kind: "thinking"; seconds: number; text: string }
  | { kind: "peer_reply"; runner: string; text: string }
  | { kind: "peer_thinking"; runner: string; text: string };

// "[claude] reply" -> { runner: "claude", kind: "reply" }
export function matchPeerSynthetic(
  name: string,
): { runner: string; kind: "reply" | "thinking" } | null {
  const m = name.match(/^\[([^\]]+)\]\s+(reply|thinking)$/);
  if (!m) return null;
  return { runner: m[1], kind: m[2] as "reply" | "thinking" };
}

export function blocksFromEvents(events: SessionMessage["events"]): Block[] {
  const out: Block[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  for (const ev of events) {
    if (ev.type === "text_delta") {
      buf += ev.delta;
    } else if (ev.type === "tool_log") {
      flush();
      const peer = matchPeerSynthetic(ev.log.name);
      if (peer) {
        const body = typeof ev.log.output === "string" ? ev.log.output : "";
        out.push(
          peer.kind === "reply"
            ? { kind: "peer_reply", runner: peer.runner, text: body }
            : { kind: "peer_thinking", runner: peer.runner, text: body },
        );
      } else {
        out.push({ kind: "tool", log: ev.log });
      }
    } else if (ev.type === "error") {
      flush();
      out.push({ kind: "error", message: ev.message });
    } else if (ev.type === "thinking") {
      if (typeof ev.text === "string") {
        flush();
        out.push({ kind: "thinking", seconds: ev.seconds, text: ev.text });
      } else {
        const text = buf;
        buf = "";
        out.push({ kind: "thinking", seconds: ev.seconds, text });
      }
    }
  }
  flush();
  return out;
}

// A delegate_run / validate_run anchor is the parent's tool_log itself —
// not a sub-delegation made by a peer (which still has a `[peer] ` prefix).
// Returns the group kind for use as a visual tag; null if not an anchor.
export function peerAnchorKind(b: Block): "delegate" | "validate" | null {
  if (b.kind !== "tool") return null;
  const { peer, rest } = stripPeerPrefix(b.log.name);
  if (peer !== null) return null;
  const bare = stripMcpPrefix(rest);
  if (bare === "delegate_run") return "delegate";
  if (bare === "validate_run") return "validate";
  return null;
}

export function isDelegateRunBlock(b: Block): boolean {
  return peerAnchorKind(b) !== null;
}

// Any block that originated from a peer agent (its tool_log carries a
// `[runner] ` prefix, or the synthetic reply/thinking blocks we built above).
export function isPeerBlock(b: Block): boolean {
  if (b.kind === "peer_reply" || b.kind === "peer_thinking") return true;
  if (b.kind === "tool") return stripPeerPrefix(b.log.name).peer !== null;
  return false;
}

// Grouping unit returned by groupDelegations: either a plain Block or a
// folded delegation_group. `header` is the delegate_run tool_log once the
// MCP body returns; while the peer is still running it's null, and the
// pendingRunner inferred from the children carries the runner identity for
// the synthetic header the renderer draws in its place.
export type GroupedBlock =
  | { kind: "passthrough"; block: Block; index: number }
  | {
      kind: "delegation_group";
      id: string;
      // Tag derived from the anchor tool name. Drives header verb ("working"
      // vs "validating") and accent color. Pending groups (anchor not yet
      // landed) default to "delegate" — they reclassify when the anchor lands.
      tag: "delegate" | "validate";
      anchorIndex: number;
      header: ToolLog | null;
      pendingRunner: string | null;
      children: Block[];
    };

// Fold the run of peer-prefixed blocks that PRECEDE a delegate_run anchor
// into that anchor's group. The Claude/Codex SDKs only emit the delegate_run
// tool_log after the MCP body returns, so peer events (forwardPeerEvent
// onEvent calls in server/index.ts) stream first and the anchor lands last.
// Backward grouping matches that wire ordering; visually we still render the
// anchor first (header above its children) for the Claude-Code-style header.
//
// Any trailing run of peer blocks with no closing anchor (i.e. the MCP body
// hasn't returned yet) becomes a "pending" group with header=null — the
// renderer draws a synthetic spinner header so the transcript looks clean
// during streaming rather than churning when the anchor finally lands.
//
// The group `id` is `${messageId}:${anchorBlockIndex}` for closed groups and
// `${messageId}:pending` for the in-flight one so the expand-state store can
// identify them across re-renders.
export function groupDelegations(
  blocks: Block[],
  messageId: string,
): GroupedBlock[] {
  const items: GroupedBlock[] = [];

  const consumeTrailingPeers = (): Block[] => {
    const children: Block[] = [];
    while (items.length > 0) {
      const last = items[items.length - 1];
      if (last.kind !== "passthrough") break;
      if (!isPeerBlock(last.block)) break;
      items.pop();
      children.unshift(last.block);
    }
    return children;
  };

  blocks.forEach((b, i) => {
    const tag = peerAnchorKind(b);
    if (tag !== null && b.kind === "tool") {
      items.push({
        kind: "delegation_group",
        id: `${messageId}:${i}`,
        tag,
        anchorIndex: i,
        header: b.log,
        pendingRunner: null,
        children: consumeTrailingPeers(),
      });
      return;
    }
    items.push({ kind: "passthrough", block: b, index: i });
  });

  const trailing = consumeTrailingPeers();
  if (trailing.length > 0) {
    items.push({
      kind: "delegation_group",
      id: `${messageId}:pending`,
      // Without the anchor yet we can't know — default to "delegate"; the
      // group reclassifies the moment the anchor (delegate_run/validate_run)
      // lands at the end of the message events.
      tag: "delegate",
      anchorIndex: -1,
      header: null,
      pendingRunner: inferRunner(trailing),
      children: trailing,
    });
  }

  return items;
}

function inferRunner(children: Block[]): string | null {
  for (const b of children) {
    if (b.kind === "peer_reply" || b.kind === "peer_thinking") return b.runner;
    if (b.kind === "tool") {
      const { peer } = stripPeerPrefix(b.log.name);
      if (peer) return peer;
    }
  }
  return null;
}

// Walk the active session backwards and return the id of the most recent
// delegation_group (including the pending one synthesized for in-flight
// peer streams). Used by the ctrl+e binding to know which group to toggle
// when the user has no explicit selection.
export function latestDelegationId(session: Session | null): string | null {
  if (!session) return null;
  for (let mi = session.messages.length - 1; mi >= 0; mi--) {
    const m = session.messages[mi];
    if (m.role !== "assistant") continue;
    const grouped = groupDelegations(blocksFromEvents(m.events), m.id);
    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];
      if (g.kind === "delegation_group") return g.id;
    }
  }
  return null;
}
