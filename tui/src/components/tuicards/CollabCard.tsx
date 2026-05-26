import { TextAttributes } from "@opentui/core";
import type { ToolLog } from "../../../../shared/events.ts";
import { theme } from "../../theme";
import type { Block } from "../../util/blocks";
import {
  cleanModelText,
  shortId,
  stripMcpPrefix,
  stripPeerPrefix,
} from "../../util/format";
import { ChatItem } from "./ChatItem";
import { toolLogStatus } from "./StatusDot";
import { ToolCard } from "./ToolCard";
import {
  CardHeader,
  Counter,
  MetaChips,
  SubRow,
} from "./parts";
import { formatDuration, runnerColor, statusColor, truncate } from "./format";
import type { Chip } from "./types";

type Snapshot = {
  collabId: string;
  planId: string;
  planPath: string;
  leadRunner: string;
  peerRunner: string;
  status: string;
  phases: PhaseRow[];
  messages: number;
  decisions: number;
  peerTurns: number;
  maxPeerTurns: number;
  summary?: string;
};

type PhaseRow = {
  id: string;
  title: string;
  status: string;
  owner: string;
  summary?: string;
  durationMs?: number;
};

const MAX_PHASE_ROWS = 6;

export function CollabCard({
  id,
  snapshot,
  blocks,
  selected = false,
  expanded = false,
  active = true,
  hint = null,
  onActivate,
}: {
  id: string;
  snapshot: ToolLog | null;
  blocks: Block[];
  selected?: boolean;
  expanded?: boolean;
  active?: boolean;
  hint?: string | null;
  onActivate?: () => void;
}) {
  const snap = coerceSnapshot(snapshot?.output);
  const toolCount = blocks.filter((b) => b.kind === "tool").length;
  const completedPeerTurns = completedAskPeerCalls(blocks);
  const waitingOnPeer =
    snap !== null &&
    active &&
    snap.status === "running" &&
    snap.peerTurns > completedPeerTurns;
  const status = snap?.status ?? fallbackStatus(blocks);
  const displayStatus =
    status === "running" && !active && !waitingOnPeer ? "open" : status;
  const title = snap
    ? `${snap.leadRunner} <-> ${snap.peerRunner}`
    : "setup";
  const idShort = snap?.collabId ? shortId(snap.collabId) : "";
  const activePhase = snap ? activePhaseTitle(snap.phases) : "";
  const expandedNode = expanded && blocks.length > 0 ? (
    <ExpandedBlocks groupId={id} blocks={blocks} />
  ) : null;

  return (
    <ChatItem
      id={id}
      selected={selected}
      expanded={expanded}
      expandable={blocks.length > 0}
      hint={hint}
      onActivate={onActivate}
      expandedContent={expandedNode}
    >
      <CardHeader
        status={displayStatus}
        verb="collab"
        verbColor={theme.toolTask}
        title={title}
        id={idShort}
      />
      <CollabMetaRow
        snap={snap}
        toolCount={toolCount}
        waitingOnPeer={waitingOnPeer}
        displayStatus={displayStatus}
      />
      {activePhase && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └ "}</text>
          <text fg={theme.textMuted}>{activePhase}</text>
        </box>
      )}
      {snap && snap.phases.slice(0, MAX_PHASE_ROWS).map((phase, i) => (
        <PhaseRowView
          key={phase.id || `phase-${i}`}
          phase={phase}
          active={active}
          last={i === Math.min(snap.phases.length, MAX_PHASE_ROWS) - 1 && snap.phases.length <= MAX_PHASE_ROWS}
        />
      ))}
      {snap && snap.phases.length > MAX_PHASE_ROWS && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └ "}</text>
          <text fg={theme.textFaint}>{`+${snap.phases.length - MAX_PHASE_ROWS} more phases`}</text>
        </box>
      )}
      {snap?.summary && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └ "}</text>
          <text fg={theme.textMuted}>{truncate(cleanModelText(snap.summary), 160)}</text>
        </box>
      )}
    </ChatItem>
  );
}

// Sub-header row: status pill, optional peer-turn mini-bar (when we know the
// budget), and middot meta chips. Pulled out so the JSX in CollabCard reads
// top-down without a deeply nested sub-header expression.
function CollabMetaRow({
  snap,
  toolCount,
  waitingOnPeer,
  displayStatus,
}: {
  snap: Snapshot | null;
  toolCount: number;
  waitingOnPeer: boolean;
  displayStatus: string;
}) {
  if (!snap) {
    const chips: Chip[] = [
      { text: `${toolCount} tool call${toolCount === 1 ? "" : "s"}` },
    ];
    return (
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={statusColor(displayStatus)} attributes={TextAttributes.BOLD}>
          {displayStatus}
        </text>
        <text fg={theme.textMuted}>{"  ·  "}</text>
        <MetaChips chips={chips} />
      </box>
    );
  }
  const showTurnBar = snap.maxPeerTurns > 0;
  const chips: Chip[] = [];
  if (waitingOnPeer) {
    chips.push({
      text: `waiting on ${snap.peerRunner}`,
      color: runnerColor(snap.peerRunner),
      bold: true,
    });
  }
  if (snap.decisions > 0) {
    chips.push({ text: `${snap.decisions} decision${snap.decisions === 1 ? "" : "s"}` });
  }
  if (snap.planPath) chips.push({ text: truncate(snap.planPath, 72), dim: true });

  return (
    <box flexDirection="row">
      <text fg={theme.textFaint}>{"  └ "}</text>
      <text fg={statusColor(displayStatus)} attributes={TextAttributes.BOLD}>
        {displayStatus}
      </text>
      {showTurnBar && (
        <>
          <text fg={theme.textMuted}>{"  ·  "}</text>
          <Counter value={snap.peerTurns} bold color={theme.toolTask} />
          <text fg={theme.textFaint}>{"/"}</text>
          <Counter value={snap.maxPeerTurns} color={theme.textMuted} />
          <text fg={theme.textFaint}>{" turns"}</text>
        </>
      )}
      <text fg={theme.textMuted}>{"  ·  "}</text>
      <Counter value={snap.messages} color={theme.textMuted} />
      <text fg={theme.textFaint}>{` message${snap.messages === 1 ? "" : "s"}`}</text>
      {chips.length > 0 && (
        <>
          <text fg={theme.textMuted}>{"  ·  "}</text>
          <MetaChips chips={chips} />
        </>
      )}
    </box>
  );
}

function PhaseRowView({ phase, active, last }: { phase: PhaseRow; active: boolean; last: boolean }) {
  const duration = formatDuration(phase.durationMs);
  const dotStatus = phase.status === "running" && !active ? "pending" : phase.status;
  return (
    <SubRow last={last} status={dotStatus} fadeIn>
      <text fg={runnerColor(phase.owner)} attributes={TextAttributes.BOLD}>{` [${phase.owner}]`}</text>
      <text fg={theme.textMuted}>{` ${truncate(phase.title, 72)}`}</text>
      {duration && <text fg={theme.textFaint}>{`  ${duration}`}</text>}
      {phase.summary && <text fg={theme.textFaint}>{`  ${truncate(phase.summary, 72)}`}</text>}
    </SubRow>
  );
}

function ExpandedBlocks({ groupId, blocks }: { groupId: string; blocks: Block[] }) {
  return (
    <box flexDirection="column" paddingLeft={2} marginTop={0}>
      <text fg={theme.textFaint}>{"tool calls"}</text>
      {blocks.map((block, i) => (
        <ExpandedBlock key={`${groupId}:child:${i}`} id={`${groupId}:child:${i}`} block={block} />
      ))}
    </box>
  );
}

function ExpandedBlock({ id, block }: { id: string; block: Block }) {
  if (block.kind === "tool") {
    return <ToolCard id={id} log={block.log} nested />;
  }
  if (block.kind === "peer_reply" || block.kind === "peer_thinking") {
    const label = block.kind === "peer_reply" ? "reply" : "thinking";
    const text = cleanModelText(block.text).trim();
    return (
      <box flexDirection="column" marginTop={0}>
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"• "}</text>
          <text fg={runnerColor(block.runner)} attributes={TextAttributes.BOLD}>{`[${block.runner}] ${label}`}</text>
        </box>
        {text && (
          <box flexDirection="column" paddingLeft={2}>
            {tailLines(text, 8).map((line, i) => (
              <text key={`${id}:line:${i}`} fg={theme.textMuted}>{line || " "}</text>
            ))}
          </box>
        )}
      </box>
    );
  }
  if (block.kind === "error") {
    return (
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"• "}</text>
        <text fg={theme.toolError}>{`error: ${block.message}`}</text>
      </box>
    );
  }
  if (block.kind === "thinking") {
    return (
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"• "}</text>
        <text fg={theme.textSubtle}>{`thought (${block.seconds}s)`}</text>
      </box>
    );
  }
  return (
    <box flexDirection="row">
      <text fg={theme.textFaint}>{"• "}</text>
      <text fg={theme.textMuted}>{truncate(cleanModelText(block.text), 160)}</text>
    </box>
  );
}

function coerceSnapshot(output: unknown): Snapshot | null {
  let raw: unknown = output;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.collabId !== "string") return null;
  const phases: PhaseRow[] = Array.isArray(o.phases)
    ? (o.phases as unknown[]).map((p) => normalizePhase(p)).filter((p): p is PhaseRow => p !== null)
    : [];
  return {
    collabId: o.collabId,
    planId: typeof o.planId === "string" ? o.planId : "",
    planPath: typeof o.planPath === "string" ? o.planPath : "",
    leadRunner: typeof o.leadRunner === "string" ? o.leadRunner : "?",
    peerRunner: typeof o.peerRunner === "string" ? o.peerRunner : "?",
    status: typeof o.status === "string" ? o.status : "unknown",
    phases,
    messages: numberField(o.messages),
    decisions: numberField(o.decisions),
    peerTurns: numberField(o.peerTurns),
    maxPeerTurns: numberField(o.maxPeerTurns),
    summary: typeof o.summary === "string" ? o.summary : undefined,
  };
}

function normalizePhase(raw: unknown): PhaseRow | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return {
    id: typeof p.id === "string" ? p.id : "",
    title: typeof p.title === "string" ? p.title : "",
    status: typeof p.status === "string" ? p.status : "unknown",
    owner: typeof p.owner === "string" ? p.owner : "?",
    summary: typeof p.summary === "string" ? p.summary : undefined,
    durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
  };
}

function numberField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function completedAskPeerCalls(blocks: Block[]): number {
  let n = 0;
  for (const block of blocks) {
    if (block.kind !== "tool") continue;
    const { rest } = stripPeerPrefix(block.log.name);
    if (stripMcpPrefix(rest) === "collab_ask_peer") n += 1;
  }
  return n;
}

function activePhaseTitle(phases: PhaseRow[]): string {
  const active =
    phases.find((p) => p.status === "running") ??
    phases.find((p) => p.status === "pending");
  if (!active) return "";
  return `phase: ${truncate(active.title, 96)}`;
}

function fallbackStatus(blocks: Block[]): string {
  if (blocks.some((b) => b.kind === "tool" && toolLogStatus(b.log) === "running")) return "running";
  if (blocks.some((b) => b.kind === "tool" && b.log.isError === true)) return "error";
  return blocks.length > 0 ? "ok" : "unknown";
}

function tailLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - max)).map((line) => truncate(line, 180));
}
