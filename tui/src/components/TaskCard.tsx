import { TextAttributes } from "@opentui/core";
import type { ToolLog } from "../../../shared/events.ts";
import { theme } from "../theme";
import { shortId } from "../util/format";

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
};

const MAX_PROMPT_CHARS = 64;
const MAX_RESULT_CHARS = 80;

// Rich rendering for the live `task` tool_log stream. The server emits the
// snapshot object directly on log.output (no MCP envelope, no JSON.stringify),
// so we read it as a structured object.
export function TaskCard({ log }: { log: ToolLog }) {
  const snap = coerceSnapshot(log.output);
  if (!snap) {
    return (
      <box flexDirection="row" paddingLeft={1} paddingRight={1} marginTop={1}>
        <text fg={theme.textMuted}>{"• "}</text>
        <text fg={theme.toolTask} attributes={TextAttributes.BOLD}>task</text>
        <text fg={theme.textMuted}>{"  (no data)"}</text>
      </box>
    );
  }

  const counts = snap.counts ?? {};
  const total = counts.total ?? snap.subtasks.length ?? 0;
  const ok = counts.ok ?? 0;
  const running = counts.running ?? 0;
  const queued = counts.queued ?? 0;
  const errored = counts.error ?? 0;
  const cancelled = counts.cancelled ?? 0;

  const countParts: string[] = [];
  if (total > 0) countParts.push(`${ok}/${total} ok`);
  if (running > 0) countParts.push(`${running} running`);
  if (queued > 0) countParts.push(`${queued} queued`);
  if (errored > 0) countParts.push(`${errored} error`);
  if (cancelled > 0) countParts.push(`${cancelled} cancelled`);
  const countSummary = countParts.join("  ·  ");

  const statusColor = colorForTaskStatus(snap.status);
  const idShort = shortId(snap.taskId);

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1}>
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"• "}</text>
        <text fg={theme.toolTask} attributes={TextAttributes.BOLD}>task</text>
        <text fg={theme.text}>{` "${truncate(snap.title, 64)}"`}</text>
        <text fg={theme.textFaint}>{`  ${idShort}`}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={statusColor} attributes={TextAttributes.BOLD}>{snap.status}</text>
        {countSummary && <text fg={theme.textMuted}>{`  ·  ${countSummary}`}</text>}
      </box>
      {snap.subtasks.map((s, i) => (
        <SubtaskRowView key={s.id || `s-${i}`} sub={s} last={i === snap.subtasks.length - 1} />
      ))}
      {snap.summary && (
        <box flexDirection="row" marginTop={0}>
          <text fg={theme.textFaint}>{"  ⤷ "}</text>
          <text fg={theme.textMuted}>{truncate(snap.summary, 200)}</text>
        </box>
      )}
    </box>
  );
}

function SubtaskRowView({ sub, last }: { sub: SubtaskRow; last: boolean }) {
  const marker = last ? "  └ " : "  ├ ";
  const dur = formatDuration(sub.durationMs);
  const tail = pickTail(sub);
  const statusColor = colorForSubStatus(sub.status);
  return (
    <box flexDirection="row">
      <text fg={theme.textFaint}>{marker}</text>
      <text fg={runnerColor(sub.runner)} attributes={TextAttributes.BOLD}>{`[${sub.runner}]`}</text>
      <text fg={statusColor}>{`  ${sub.status}`}</text>
      {dur && <text fg={theme.textFaint}>{`  ${dur}`}</text>}
      {sub.prompt && (
        <text fg={theme.textMuted}>{`  "${truncate(sub.prompt, MAX_PROMPT_CHARS)}"`}</text>
      )}
      {tail && <text fg={theme.textFaint}>{`  → ${truncate(tail, MAX_RESULT_CHARS)}`}</text>}
    </box>
  );
}

function pickTail(sub: SubtaskRow): string {
  if (sub.error) return sub.error;
  if (sub.result) return sub.result;
  if (sub.lastDelta) return sub.lastDelta;
  return "";
}

function colorForTaskStatus(s: string): string {
  if (s === "done") return theme.runnerClaude;
  if (s === "running") return theme.toolBash;
  if (s === "pending") return theme.textMuted;
  if (s === "error") return theme.toolError;
  if (s === "cancelled") return theme.textSubtle;
  return theme.text;
}

function colorForSubStatus(s: string): string {
  if (s === "ok") return theme.runnerClaude;
  if (s === "running") return theme.toolBash;
  if (s === "queued") return theme.textMuted;
  if (s === "error" || s === "timeout") return theme.toolError;
  if (s === "cancelled") return theme.textSubtle;
  return theme.text;
}

function runnerColor(runner: string): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  return theme.textMuted;
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m${rem.toString().padStart(2, "0")}s`;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
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
  };
}
