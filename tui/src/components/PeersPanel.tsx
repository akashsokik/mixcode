import type { Session } from "../../../shared/events.ts";
import { TextAttributes } from "@opentui/core";
import { pendingDelegations } from "../util/blocks";
import { theme } from "../theme";
import { StatusDot } from "./StatusDot";
import type { GroupedBlock } from "../util/blocks";

type PeerGroup = Extract<GroupedBlock, { kind: "delegation_group" }>;

export type PeersPanelProps = {
  session: Session | null;
  width: number;
  streamingMessageId: string | null;
};

export function PeersPanel({ session, width, streamingMessageId }: PeersPanelProps) {
  const pending = pendingDelegations(session, streamingMessageId);
  if (pending.length === 0) return null;

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
        <text fg={theme.textFaint}>{`   ${pending.length}`}</text>
      </box>
      {pending.map((g) => (
        <PeerBlock key={g.id} group={g} />
      ))}
    </box>
  );
}

function PeerBlock({ group }: { group: PeerGroup }) {
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
        <StatusDot status="running" />
        <text fg={theme.text}>{" "}</text>
        <text fg={peerColor(runner)} attributes={TextAttributes.BOLD}>{`[${runner}] `}</text>
        <text fg={accent} attributes={TextAttributes.BOLD}>{group.tag}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  "}</text>
        <text fg={theme.textMuted}>{verb}</text>
      </box>
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
      {stats.replyTail && (
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
