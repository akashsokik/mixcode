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
  | { kind: "peer_reply"; runner: string; runId: string | null; text: string }
  | { kind: "peer_thinking"; runner: string; runId: string | null; text: string };

// "[claude] reply" -> { runner: "claude", runId: null, kind: "reply" }
// "[ollama][run-id] reply" -> { runner: "ollama", runId: "run-id", kind: "reply" }
// The optional second `[...]` is the peer's run id; it lets a transcript reply
// block be correlated with its workflow-card node. Optional so legacy/untagged
// `[runner] reply` names still match.
export function matchPeerSynthetic(
  name: string,
): { runner: string; runId: string | null; kind: "reply" | "thinking" } | null {
  const m = name.match(/^\[([^\]]+)\](?:\[([^\]]*)\])?\s+(reply|thinking)$/);
  if (!m) return null;
  return { runner: m[1], runId: m[2] ?? null, kind: m[3] as "reply" | "thinking" };
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
            ? { kind: "peer_reply", runner: peer.runner, runId: peer.runId, text: body }
            : { kind: "peer_thinking", runner: peer.runner, runId: peer.runId, text: body },
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

// The peer run-id a block was tagged with (short form, as embedded by the
// onPeerEvent bridge), or null for non-peer blocks. Lets the transcript drop
// the loose reply/thinking/tool rows for a workflow node once that node has
// settled - the WorkflowCard then owns the node's output. Error blocks carry
// no structured run-id, so they are never matched here and stay visible.
export function peerBlockRunId(b: Block): string | null {
  if (b.kind === "peer_reply" || b.kind === "peer_thinking") return b.runId;
  if (b.kind === "tool") return stripPeerPrefix(b.log.name).runId;
  return null;
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
    }
  | {
      kind: "collab_group";
      id: string;
      anchorIndex: number;
      snapshot: ToolLog | null;
      children: Block[];
    }
  | {
      // A burst of workflow-authoring tool calls (workflow_add_node ×N +
      // workflow_run) folded into one card so the DAG assembly reads as a
      // single action instead of N stacked rows.
      kind: "workflow_authoring";
      id: string;
      index: number;
      children: Block[];
    };

// The three DAG-authoring tools, by bare (MCP-stripped) name. A run of these
// gets folded into one card (foldWorkflowAuthoring).
const WORKFLOW_AUTHORING_TOOLS = new Set([
  "workflow_add_node",
  "workflow_run",
  "workflow_reset",
]);

function isWorkflowAuthoringBlock(b: Block): boolean {
  const name = ownBareToolName(b);
  return name !== null && WORKFLOW_AUTHORING_TOOLS.has(name);
}

const COLLAB_CONTROL_TOOLS = new Set([
  "plan_create",
  "plan_read",
  "collab_start",
  "collab_send",
  "collab_ask_peer",
  "collab_observe",
  "collab_finish",
  "collab_cancel",
  "phase_start",
  "phase_done",
  "phase_handoff",
]);

function ownBareToolName(b: Block): string | null {
  if (b.kind !== "tool") return null;
  const { peer, rest } = stripPeerPrefix(b.log.name);
  if (peer !== null) return null;
  return stripMcpPrefix(rest);
}

function isCollabSnapshotBlock(b: Block): boolean {
  return ownBareToolName(b) === "collab";
}

function isCollabControlBlock(b: Block): boolean {
  const name = ownBareToolName(b);
  return name !== null && COLLAB_CONTROL_TOOLS.has(name);
}

function collabSnapshotPeerTurns(log: ToolLog | null): number {
  if (!log) return 0;
  let raw = log.output;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return 0;
    }
  }
  if (!raw || typeof raw !== "object") return 0;
  const turns = (raw as Record<string, unknown>).peerTurns;
  return typeof turns === "number" && Number.isFinite(turns) ? turns : 0;
}

function completedAskPeerCalls(children: Block[]): number {
  let n = 0;
  for (const b of children) {
    if (ownBareToolName(b) === "collab_ask_peer") n += 1;
  }
  return n;
}

function collabMayCapturePeer(group: Extract<GroupedBlock, { kind: "collab_group" }>): boolean {
  return collabSnapshotPeerTurns(group.snapshot) > completedAskPeerCalls(group.children);
}

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
  let currentCollab: Extract<GroupedBlock, { kind: "collab_group" }> | null = null;

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

  const ensureCollabGroup = (anchorIndex: number): Extract<GroupedBlock, { kind: "collab_group" }> => {
    if (currentCollab) return currentCollab;
    currentCollab = {
      kind: "collab_group",
      id: `${messageId}:c:${anchorIndex}`,
      anchorIndex,
      snapshot: null,
      children: [],
    };
    items.push(currentCollab);
    return currentCollab;
  };

  blocks.forEach((b, i) => {
    if (isCollabSnapshotBlock(b) && b.kind === "tool") {
      const group = ensureCollabGroup(i);
      group.snapshot = b.log;
      return;
    }
    if (isCollabControlBlock(b)) {
      ensureCollabGroup(i).children.push(b);
      return;
    }
    if (currentCollab && isPeerBlock(b) && collabMayCapturePeer(currentCollab)) {
      currentCollab.children.push(b);
      return;
    }

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

  // (workflow-authoring fold applied after the trailing-peer pass below)
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

  return foldWorkflowAuthoring(items, messageId);
}

// Collapse maximal runs of 2+ consecutive workflow-authoring passthrough tool
// blocks (workflow_add_node ×N + workflow_run) into a single workflow_authoring
// group. A lone authoring call is left as-is (nothing to fold).
function foldWorkflowAuthoring(
  items: GroupedBlock[],
  messageId: string,
): GroupedBlock[] {
  const out: GroupedBlock[] = [];
  let run: Extract<GroupedBlock, { kind: "passthrough" }>[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      out.push({
        kind: "workflow_authoring",
        id: `${messageId}:wfauth:${run[0].index}`,
        index: run[0].index,
        children: run.map((g) => g.block),
      });
    }
    run = [];
  };
  for (const g of items) {
    if (g.kind === "passthrough" && isWorkflowAuthoringBlock(g.block)) {
      run.push(g);
    } else {
      flush();
      out.push(g);
    }
  }
  flush();
  return out;
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
// collapsible orchestration group. Used by the ctrl+e binding to know which
// group to toggle when the user has no explicit selection.
export function latestDelegationId(session: Session | null): string | null {
  if (!session) return null;
  for (let mi = session.messages.length - 1; mi >= 0; mi--) {
    const m = session.messages[mi];
    if (m.role !== "assistant") continue;
    const grouped = groupDelegations(blocksFromEvents(m.events), m.id);
    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];
      if (g.kind === "delegation_group" || g.kind === "collab_group") return g.id;
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
      if (
        g.kind === "delegation_group" ||
        g.kind === "collab_group" ||
        g.kind === "workflow_authoring"
      ) {
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
//   - <msgId>:c:<i>      -> collaboration group (snapshot + all children)
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
  // Assistant-block ids have shape `${messageId}:${index}`,
  // `${messageId}:d:${anchorIndex}`, or `${messageId}:c:${anchorIndex}`.
  // The message id itself can contain colons, so split from the right.
  const lastColon = id.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tailAfterLast = id.slice(lastColon + 1);
  const tailIndex = Number.parseInt(tailAfterLast, 10);
  if (!Number.isFinite(tailIndex)) return null;
  const beforeLast = id.slice(0, lastColon);
  const isDelegationGroup = beforeLast.endsWith(":d");
  const isCollabGroup = beforeLast.endsWith(":c");
  const messageId =
    isDelegationGroup || isCollabGroup ? beforeLast.slice(0, -2) : beforeLast;
  const m = session.messages.find((x) => x.id === messageId);
  if (!m) return null;
  const grouped = groupDelegations(blocksFromEvents(m.events), m.id);
  if (isDelegationGroup) {
    const g = grouped.find(
      (x) => x.kind === "delegation_group" && x.anchorIndex === tailIndex,
    );
    if (!g || g.kind !== "delegation_group") return null;
    const parts: string[] = [];
    if (g.header) parts.push(renderToolLogPlain(g.header));
    for (const child of g.children) parts.push(renderBlockPlain(child));
    return parts.join("\n\n");
  }
  if (isCollabGroup) {
    const g = grouped.find(
      (x) => x.kind === "collab_group" && x.anchorIndex === tailIndex,
    );
    if (!g || g.kind !== "collab_group") return null;
    const parts: string[] = [];
    if (g.snapshot) parts.push(renderToolLogPlain(g.snapshot));
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
