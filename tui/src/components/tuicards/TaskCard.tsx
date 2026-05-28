import { TextAttributes } from "@opentui/core";
import type { ToolLog } from "../../../../shared/events.ts";
import { theme } from "../../theme";
import { shortId } from "../../util/format";
import { ChatItem } from "./ChatItem";
import {
  CardHeader,
  Counter,
  MetaChips,
  SubRow,
} from "./parts";
import { formatDuration, runnerColor, statusColor, truncate } from "./format";
import type { Chip } from "./types";

type Snapshot = {
  taskId: string;
  status: string;
  title: string;
  description?: string;
  summary?: string;
  counts: {
    running?: number;
    ok?: number;
    error?: number;
    cancelled?: number;
    queued?: number;
    total?: number;
  };
  subtasks: SubtaskRow[];
};

type SubtaskRow = {
  id: string;
  runner: string;
  status: string;
  prompt: string;
  durationMs?: number;
  result?: string;
  error?: string;
  lastDelta?: string;
  currentTool?: string;
};

const MAX_PROMPT_CHARS = 64;
const MAX_RESULT_CHARS = 80;

// Rich rendering for the live `task` tool_log stream. The server emits the
// snapshot object directly on log.output (no MCP envelope, no JSON.stringify),
// so we read it as a structured object.
export function TaskCard({
  id,
  log,
  selected,
  onActivate,
}: {
  id: string;
  log: ToolLog;
  selected: boolean;
  onActivate?: () => void;
}) {
  const snap = coerceSnapshot(log.output);
  if (!snap) {
    return (
      <ChatItem id={id} selected={selected} onActivate={onActivate}>
        <CardHeader
          status="pending"
          verb="task"
          verbColor={theme.toolTask}
          title="(no data)"
        />
      </ChatItem>
    );
  }

  const counts = snap.counts ?? {};
  const total = counts.total ?? snap.subtasks.length ?? 0;
  const ok = counts.ok ?? 0;
  const running = counts.running ?? 0;
  const queued = counts.queued ?? 0;
  const errored = counts.error ?? 0;
  const cancelled = counts.cancelled ?? 0;
  const showBar = total > 0;

  const idShort = shortId(snap.taskId);

  return (
    <ChatItem id={id} selected={selected} onActivate={onActivate}>
      <CardHeader
        status={snap.status}
        verb="task"
        verbColor={theme.toolTask}
        title={`"${truncate(snap.title, 64)}"`}
        id={idShort}
      />
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={statusColor(snap.status)} attributes={TextAttributes.BOLD}>
          {snap.status}
        </text>
        {showBar && (
          <>
            <text fg={theme.textMuted}>{"  ·  "}</text>
            <Counter value={ok} bold color={theme.runnerClaude} />
            <text fg={theme.textFaint}>{"/"}</text>
            <Counter value={total} color={theme.textMuted} />
            <text fg={theme.textFaint}>{" ok"}</text>
          </>
        )}
        <CountChips
          running={running}
          queued={queued}
          errored={errored}
          cancelled={cancelled}
        />
      </box>
      {snap.subtasks.map((s, i) => (
        <SubtaskRowView
          key={s.id || `s-${i}`}
          sub={s}
          last={i === snap.subtasks.length - 1}
        />
      ))}
      {snap.summary && (
        <box flexDirection="row" marginTop={0}>
          <text fg={theme.textFaint}>{"  ⤷ "}</text>
          <text fg={theme.textMuted}>{truncate(snap.summary, 200)}</text>
        </box>
      )}
    </ChatItem>
  );
}

function CountChips({
  running,
  queued,
  errored,
  cancelled,
}: {
  running: number;
  queued: number;
  errored: number;
  cancelled: number;
}) {
  const chips: Chip[] = [];
  if (running > 0) chips.push({ text: `${running} running`, color: theme.toolBash, bold: true });
  if (queued > 0) chips.push({ text: `${queued} queued` });
  if (errored > 0) chips.push({ text: `${errored} error`, color: theme.toolError, bold: true });
  if (cancelled > 0) chips.push({ text: `${cancelled} cancelled`, dim: true });
  if (chips.length === 0) return null;
  return (
    <>
      <text fg={theme.textMuted}>{"  ·  "}</text>
      <MetaChips chips={chips} />
    </>
  );
}

function SubtaskRowView({ sub, last }: { sub: SubtaskRow; last: boolean }) {
  const dur = formatDuration(sub.durationMs);
  const tail = pickTail(sub);
  return (
    <SubRow last={last} status={sub.status} fadeIn>
      <text fg={runnerColor(sub.runner)} attributes={TextAttributes.BOLD}>{` [${sub.runner}]`}</text>
      {dur && <text fg={theme.textFaint}>{`  ${dur}`}</text>}
      {sub.prompt && (
        <text fg={theme.textMuted}>{`  "${truncate(sub.prompt, MAX_PROMPT_CHARS)}"`}</text>
      )}
      {tail && <text fg={theme.textFaint}>{`  → ${truncate(tail, MAX_RESULT_CHARS)}`}</text>}
    </SubRow>
  );
}

// Only show the tool the peer is currently using. Skip lastDelta / result /
// error in the row — the status dot already conveys ok/error; full details
// belong in the expanded view, not on this row.
function pickTail(sub: SubtaskRow): string {
  return sub.currentTool ?? "";
}

// Server emits the snapshot as a plain object on log.output. Be defensive in
// case the wire shape ever changes (e.g. JSON-stringified) — fall through to
// returning null rather than crashing the transcript.
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
  if (typeof o.taskId !== "string" || typeof o.title !== "string") return null;
  const subtasks: SubtaskRow[] = Array.isArray(o.subtasks)
    ? (o.subtasks as unknown[]).map((s) => normalizeSub(s)).filter((s): s is SubtaskRow => s !== null)
    : [];
  return {
    taskId: o.taskId,
    status: typeof o.status === "string" ? o.status : "unknown",
    title: o.title,
    description: typeof o.description === "string" ? o.description : undefined,
    summary: typeof o.summary === "string" ? o.summary : undefined,
    counts: (o.counts && typeof o.counts === "object" ? o.counts : {}) as Snapshot["counts"],
    subtasks,
  };
}

function normalizeSub(s: unknown): SubtaskRow | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : "",
    runner: typeof o.runner === "string" ? o.runner : "?",
    status: typeof o.status === "string" ? o.status : "?",
    prompt: typeof o.prompt === "string" ? o.prompt : "",
    durationMs: typeof o.durationMs === "number" ? o.durationMs : undefined,
    result: typeof o.result === "string" ? o.result : undefined,
    error: typeof o.error === "string" ? o.error : undefined,
    lastDelta: typeof o.lastDelta === "string" ? o.lastDelta : undefined,
    currentTool: typeof o.currentTool === "string" ? o.currentTool : undefined,
  };
}
