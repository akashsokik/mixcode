import type {
  Session,
  SessionMessage,
  ToolLog,
} from "../../../shared/events.ts";
import { formatToolLog, stripMcpPrefix, stripPeerPrefix } from "./format";
import type { Notice } from "./notice";

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

// A delegate_run / validate_run / consensus_step anchor is the parent's
// tool_log itself — not a sub-delegation made by a peer (which still has a
// `[peer] ` prefix). Returns the group kind for use as a visual tag; null
// if not an anchor.
//
// `consensus_step` is emitted by runConsensusTurn AFTER each iteration's
// peer call settles, so the streaming peer events for that iteration
// backward-fold into a labelled closed group (one card per producer/critic
// turn) instead of one giant unlabelled run.
export function peerAnchorKind(b: Block): "delegate" | "validate" | "consensus" | null {
  if (b.kind !== "tool") return null;
  const { peer, rest } = stripPeerPrefix(b.log.name);
  if (peer !== null) return null;
  const bare = stripMcpPrefix(rest);
  if (bare === "delegate_run") return "delegate";
  if (bare === "validate_run") return "validate";
  if (bare === "consensus_step") return "consensus";
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
      // vs "validating" vs "consensus step") and accent color. Pending
      // groups (anchor not yet landed) default to "delegate" — they
      // reclassify when the anchor lands.
      tag: "delegate" | "validate" | "consensus";
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
  // Whether the parent message is currently streaming. If false, a trailing
  // run of peer blocks without an anchor is NOT folded into a pending group
  // — the peers ran but their delegate_run anchor never landed (e.g. the
  // process was killed mid-call). Rendering it as "working…" forever would
  // be misleading. We let the peer events render as plain passthrough
  // blocks so the user sees what actually happened.
  messageStreaming = true,
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
    if (messageStreaming) {
      // Inherit "consensus" if the message already shows a closed consensus
      // step — the next iteration is also consensus until proven otherwise.
      // Without this the pending header says "delegate working…" while we
      // are mid-actor/critic loop, which hides the user's actual context.
      const inheritedTag: "delegate" | "validate" | "consensus" = items.some(
        (g) => g.kind === "delegation_group" && g.tag === "consensus",
      )
        ? "consensus"
        : "delegate";
      items.push({
        kind: "delegation_group",
        id: `${messageId}:pending`,
        tag: inheritedTag,
        anchorIndex: -1,
        header: null,
        pendingRunner: inferRunner(trailing),
        children: trailing,
      });
    } else {
      // Orphaned trailing peers from an interrupted/crashed turn: render as
      // plain passthroughs so the user sees the peer's reasoning but no
      // misleading "working…" spinner.
      trailing.forEach((b, j) => {
        items.push({ kind: "passthrough", block: b, index: blocks.length + j });
      });
    }
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

// Returns the navigation order for shift+up / shift+down in the chat area:
// one id per visually-distinct row (user message, notice, assistant block,
// delegation group, tool card, task card). Order matches Transcript's render
// order (chronological by `createdAt`, ties broken by user msg before notice).
export function collectChatItemIds(
  session: Session | null,
  notices: Notice[],
): string[] {
  if (!session) return [];
  type Entry =
    | { kind: "message"; at: string; message: SessionMessage }
    | { kind: "notice"; at: string; notice: Notice };
  const entries: Entry[] = [
    ...session.messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...notices.map((n) => ({ kind: "notice" as const, at: n.createdAt, notice: n })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === "notice") {
      out.push(`notice:${e.notice.id}`);
      continue;
    }
    const m = e.message;
    if (m.role === "user") {
      out.push(`msg:${m.id}`);
      continue;
    }
    const grouped = groupDelegations(blocksFromEvents(m.events), m.id);
    for (const g of grouped) {
      if (g.kind === "delegation_group") {
        out.push(g.id);
        continue;
      }
      out.push(`${m.id}:${g.index}`);
    }
  }
  return out;
}

// Resolve a chat-item id to a plain-text representation suitable for the
// system clipboard. Mirrors the id schemes in collectChatItemIds.
//   - msg:<id>           -> user message text
//   - notice:<id>        -> notice command + lines
//   - <msgId>:d:<i>      -> delegation group (anchor + all children)
//   - <msgId>:<index>    -> single assistant block (text / tool / error / …)
// Returns null when the id can't be matched (e.g. session has changed since
// the selection was made).
export function resolveItemContent(
  session: Session | null,
  notices: Notice[],
  id: string,
): string | null {
  if (id.startsWith("msg:")) {
    if (!session) return null;
    const mid = id.slice(4);
    const m = session.messages.find((x) => x.id === mid);
    return m ? m.text : null;
  }
  if (id.startsWith("notice:")) {
    const nid = id.slice(7);
    const n = notices.find((x) => x.id === nid);
    if (!n) return null;
    return [n.command, ...n.lines].join("\n");
  }
  if (!session) return null;
  // Assistant-block ids have shape `${messageId}:${index}` or
  // `${messageId}:d:${anchorIndex}`. The message id itself can contain colons,
  // so split from the right.
  const lastColon = id.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tailAfterLast = id.slice(lastColon + 1);
  const tailIndex = Number.parseInt(tailAfterLast, 10);
  if (!Number.isFinite(tailIndex)) return null;
  const beforeLast = id.slice(0, lastColon);
  const isGroup = beforeLast.endsWith(":d");
  const messageId = isGroup ? beforeLast.slice(0, -2) : beforeLast;
  const m = session.messages.find((x) => x.id === messageId);
  if (!m) return null;
  const grouped = groupDelegations(blocksFromEvents(m.events), m.id);
  if (isGroup) {
    const g = grouped.find(
      (x) => x.kind === "delegation_group" && x.anchorIndex === tailIndex,
    );
    if (!g || g.kind !== "delegation_group") return null;
    const parts: string[] = [];
    if (g.header) parts.push(renderToolLogPlain(g.header));
    for (const child of g.children) parts.push(renderBlockPlain(child));
    return parts.join("\n\n");
  }
  const g = grouped.find(
    (x) => x.kind === "passthrough" && x.index === tailIndex,
  );
  if (!g || g.kind !== "passthrough") return null;
  return renderBlockPlain(g.block);
}

function renderBlockPlain(b: Block): string {
  if (b.kind === "text") return b.text;
  if (b.kind === "tool") return renderToolLogPlain(b.log);
  if (b.kind === "error") return `error: ${b.message}`;
  if (b.kind === "thinking") return `[thinking ${b.seconds}s]\n${b.text}`;
  if (b.kind === "peer_reply") return `[${b.runner} reply]\n${b.text}`;
  if (b.kind === "peer_thinking") return `[${b.runner} thinking]\n${b.text}`;
  return "";
}

function renderToolLogPlain(log: import("../../../shared/events.ts").ToolLog): string {
  const { header, body } = formatToolLog(log, { expanded: true });
  return body ? `${header}\n${body}` : header;
}

/**
 * Returns the pending delegation_group entries for the most recent assistant
 * message in `session`. A pending group has `header === null` and is only
 * eligible while its owner message is still streaming — matches the gating
 * the Transcript uses to decide whether to render a synthetic PendingHeader.
 *
 * Used by PeersPanel to drive the right-side rail. Empty list = no rail.
 */
export function pendingDelegations(
  session: Session | null,
  streamingMessageId: string | null,
): Extract<GroupedBlock, { kind: "delegation_group" }>[] {
  if (!session || !streamingMessageId) return [];
  const msg = session.messages.find((m) => m.id === streamingMessageId);
  if (!msg || msg.role !== "assistant") return [];
  const grouped = groupDelegations(blocksFromEvents(msg.events), msg.id, true);
  return grouped.filter(
    (g): g is Extract<GroupedBlock, { kind: "delegation_group" }> =>
      g.kind === "delegation_group" && g.header === null,
  );
}
