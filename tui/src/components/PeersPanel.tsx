import type { Session } from "../../../shared/events.ts";
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { blocksFromEvents, groupDelegations, pendingDelegations } from "../util/blocks";
import { theme } from "../theme";
import { formatElapsed } from "../util/elapsed";
import { StatusDot } from "./StatusDot";
import type { GroupedBlock } from "../util/blocks";

type PeerGroup = Extract<GroupedBlock, { kind: "delegation_group" }>;

// Captured shape of a pending peer the moment it left the pending set.
// Held in PeersPanel state for `completionMs` so the rail can render a
// brief "settled" glance with the verdict / summary before dropping the
// row entirely.
type CompletedEntry = {
  group: PeerGroup;
  finishedAt: number;
  summary: string;
};

export type PeersPanelProps = {
  session: Session | null;
  width: number;
  streamingMessageId: string | null;
  // Test seam — production callers omit this and the panel reads Date.now().
  nowMs?: number;
  // How long a freshly-completed peer block lingers in the rail before
  // being dropped. Defaults to 6 s; tests pass a shorter (or matching)
  // value to assert visibility within and expiry after the window.
  completionMs?: number;
};

export function PeersPanel({
  session,
  width,
  streamingMessageId,
  nowMs,
  completionMs,
}: PeersPanelProps) {
  const pending = pendingDelegations(session, streamingMessageId);
  // Hooks must run unconditionally on every render (rules-of-hooks). Declare
  // them before the empty-state early return so React sees a stable hook order.
  const [tick, setTick] = useState(0);
  const [completed, setCompleted] = useState<Record<string, CompletedEntry>>({});
  const prevPendingRef = useRef<Map<string, PeerGroup>>(new Map());

  const now = nowMs ?? Date.now();

  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [pending.length]);
  // Force React to treat `tick` as read so re-renders fire on each interval.
  void tick;

  // Diff prev-vs-current pending set; entries that left get parked in
  // `completed` with a verdict summary harvested from the now-resolved
  // delegate_run anchor on the same message.
  useEffect(() => {
    const prev = prevPendingRef.current;
    const next = new Map(pending.map((p) => [p.id, p]));
    for (const [id, group] of prev) {
      if (next.has(id)) continue;
      setCompleted((c) => {
        if (c[id]) return c;
        return {
          ...c,
          [id]: {
            group,
            finishedAt: now,
            summary: extractCompletionSummary(session, group, id),
          },
        };
      });
    }
    prevPendingRef.current = next;
  }, [pending, now, session]);

  // Drop completed entries once their lingering window elapses.
  useEffect(() => {
    const window = completionMs ?? 6000;
    const expired = Object.entries(completed).filter(
      ([, e]) => now - e.finishedAt >= window,
    );
    if (expired.length === 0) return;
    setCompleted((c) => {
      const out = { ...c };
      for (const [id] of expired) delete out[id];
      return out;
    });
  }, [now, completed, completionMs]);

  // Empty-state guard must consider both pending AND lingering completed
  // entries, otherwise the panel unmounts the moment a peer settles and
  // the completion glance never appears.
  if (pending.length === 0 && Object.keys(completed).length === 0) return null;

  const startedAt =
    session && streamingMessageId ? peerStartedAt(session, streamingMessageId) : now;
  const elapsedMs = now - startedAt;

  const completedList = Object.entries(completed);
  const totalCount = pending.length + completedList.length;

  return (
    <box
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
      border={["left"]}
      borderStyle="single"
      borderColor={theme.border}
    >
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>peer activity</text>
        <text fg={theme.textFaint}>{`   ${totalCount}`}</text>
      </box>
      {pending.map((g) => (
        <PeerBlock key={g.id} group={g} elapsedMs={elapsedMs} />
      ))}
      {completedList.map(([id, entry]) => (
        <PeerBlock
          key={`done:${id}`}
          group={entry.group}
          elapsedMs={elapsedMs}
          completedSummary={entry.summary}
        />
      ))}
    </box>
  );
}

// Find the closed delegation_group on the streaming message that
// corresponds to the freshly-completed pending group. Pending ids look
// like `${messageId}:pending` and closed ids look like `${messageId}:${i}`,
// so we cannot match by id; instead we walk the same message's grouped
// blocks and pick the closed group whose runner matches the pending
// runner we last observed.
function extractCompletionSummary(
  session: Session | null,
  pendingGroup: PeerGroup,
  pendingId: string,
): string {
  if (!session) return "completed";
  const suffix = ":pending";
  const messageId = pendingId.endsWith(suffix)
    ? pendingId.slice(0, -suffix.length)
    : null;
  if (!messageId) return "completed";
  const msg = session.messages.find((m) => m.id === messageId);
  if (!msg || msg.role !== "assistant") return "completed";
  const grouped = groupDelegations(blocksFromEvents(msg.events), msg.id, false);
  const wantedRunner = pendingGroup.pendingRunner;
  // Prefer a closed group whose runner matches what we saw while pending;
  // fall back to the last closed group on the message (covers cases where
  // the anchor's input shape doesn't carry an explicit runner).
  const closed = grouped.filter(
    (g): g is PeerGroup => g.kind === "delegation_group" && g.header !== null,
  );
  const match =
    closed.find((g) => closedRunner(g) === wantedRunner) ?? closed[closed.length - 1];
  if (!match || !match.header) return "completed";
  const out = match.header.output;
  let parsed: unknown = out;
  if (typeof out === "string") {
    try {
      parsed = JSON.parse(out);
    } catch {
      return "completed";
    }
  }
  if (!parsed || typeof parsed !== "object") return "completed";
  const p = parsed as Record<string, unknown>;
  if (typeof p.summary === "string" && p.summary) return p.summary;
  if (typeof p.verdict === "string") return `verdict: ${p.verdict}`;
  return "completed";
}

function closedRunner(g: PeerGroup): string | null {
  if (!g.header) return null;
  const input = g.header.input;
  if (input && typeof input === "object") {
    const r = (input as Record<string, unknown>).runner;
    if (typeof r === "string") return r;
  }
  return null;
}

function peerStartedAt(session: Session, messageId: string): number {
  const msg = session.messages.find((m) => m.id === messageId);
  return msg ? Date.parse(msg.createdAt) : Date.now();
}

function PeerBlock({
  group,
  elapsedMs,
  completedSummary,
}: {
  group: PeerGroup;
  elapsedMs: number;
  // When present the block renders in its settled/completion glance: solid
  // "done" dot, no writing tail, summary line in place of the live verb. The
  // tools / reply / lastSummary lines remain so the rail still shows what
  // the peer actually did before vanishing.
  completedSummary?: string;
}) {
  const isCompleted = typeof completedSummary === "string";
  const stats = childStats(group);
  const accent =
    group.tag === "validate"
      ? theme.toolEdit
      : group.tag === "consensus"
        ? theme.toolBash
        : theme.toolTask;
  const verb =
    group.tag === "validate"
      ? "validating…"
      : group.tag === "consensus"
        ? "drafting…"
        : "working…";
  const runner = group.pendingRunner ?? "peer";
  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row">
        <StatusDot status={isCompleted ? "done" : "running"} />
        <text fg={theme.text}>{" "}</text>
        <text fg={peerColor(runner)} attributes={TextAttributes.BOLD}>{`[${runner}] `}</text>
        <text fg={accent} attributes={TextAttributes.BOLD}>{group.tag}</text>
      </box>
      {isCompleted ? (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  "}</text>
          <text fg={theme.textMuted}>{completedSummary}</text>
        </box>
      ) : (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  "}</text>
          <text fg={theme.textMuted}>{`${verb}   ${formatElapsed(elapsedMs)}`}</text>
        </box>
      )}
      <box flexDirection="row" marginTop={0}>
        <text fg={theme.textFaint}>{"  "}</text>
        <text fg={theme.textMuted}>{`${stats.toolCount} tool${stats.toolCount === 1 ? "" : "s"}`}</text>
      </box>
      {stats.replyChars > 0 && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  "}</text>
          <text fg={theme.textMuted}>{`${formatChars(stats.replyChars)} reply`}</text>
        </box>
      )}
      {stats.lastSummary && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  ↳ "}</text>
          <text fg={theme.textMuted}>{stats.lastSummary}</text>
        </box>
      )}
      {!isCompleted && stats.replyTail && (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.textFaint}>{"  writing:"}</text>
          {stats.replyTail.split("\n").map((line, i) => (
            <box key={`tail-${i}`} flexDirection="row">
              <text fg={theme.textFaint}>{"  "}</text>
              <text fg={theme.textMuted}>{line || " "}</text>
            </box>
          ))}
        </box>
      )}
    </box>
  );
}

function peerColor(runner: string): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  if (runner === "vercel") return theme.runnerVercel;
  return theme.textMuted;
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

// Pulled inline from Transcript.tsx so the rail does not depend on the
// transcript module. Identical shape to childStats() over there; if it
// grows, factor out to util/peer-stats.ts.
type Stats = {
  toolCount: number;
  replyChars: number;
  lastSummary: string | null;
  replyTail: string;
};
const REPLY_TAIL_LINES = 6;
const REPLY_TAIL_CHARS = 320;

function childStats(group: PeerGroup): Stats {
  let toolCount = 0;
  let replyChars = 0;
  let lastSummary: string | null = null;
  let latestReply = "";
  for (const b of group.children) {
    if (b.kind === "tool") {
      toolCount += 1;
      lastSummary = peerToolSummaryName(b);
    } else if (b.kind === "peer_reply" || b.kind === "peer_thinking") {
      replyChars += b.text.length;
      if (b.kind === "peer_reply") latestReply = b.text;
    }
  }
  return {
    toolCount,
    replyChars,
    lastSummary,
    replyTail: tailLines(latestReply, REPLY_TAIL_LINES, REPLY_TAIL_CHARS),
  };
}

function peerToolSummaryName(b: { kind: "tool"; log: { name: string } }): string {
  // Strip "mcp__delegate__" or peer prefixes for the rail. Mirrors
  // peerToolSummary() in util/format but keeps PeersPanel decoupled.
  return b.log.name.replace(/^mcp__[^_]+__/, "").replace(/^\[[^\]]+\]\s*/, "");
}

function tailLines(text: string, maxLines: number, maxChars: number): string {
  if (!text) return "";
  const trimmed = text.length > maxChars ? text.slice(-maxChars) : text;
  const lines = trimmed
    .split("\n")
    .map((l) => (l.length > 200 ? l.slice(0, 199) + "…" : l));
  const tail = lines.slice(-maxLines);
  while (tail.length > 0 && !tail[0].trim()) tail.shift();
  return tail.join("\n");
}
