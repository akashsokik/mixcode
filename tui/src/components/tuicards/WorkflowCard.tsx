import { Fragment } from "react";
import { TextAttributes } from "@opentui/core";
import type {
  NodeStatus,
  WorkflowRun,
  WorkflowStatus,
} from "../../../../shared/events.ts";
import { theme } from "../../theme";
import { shortId } from "../../util/format";
import { ChatItem } from "./ChatItem";
import { CardHeader, Counter, MetaChips, SubRow } from "./parts";
import { runnerColor, statusColor, truncate } from "./format";
import type { Chip } from "./types";

const MAX_NODE_ROWS = 8;

// Inline card for a model-authored DAG run. Unlike TaskCard/CollabCard this
// card is driven by a `WorkflowRun` from session client state (not a ToolLog
// snapshot), so it takes the run directly and updates in place on each
// `workflow_state` push. Expansion into the 2D DAG view is owned by the
// full-screen WorkflowPanel (Tab key, wired in app.tsx), so the underlying
// ChatItem stays non-expandable to keep ctrl+e from fighting Tab.
// Per-node caps for the ctrl+e-expanded output view. Generous enough to show a
// normal node's full result, bounded so a long output can't grow the floating
// card past the screen (it has no scroll). Overflow gets a "+N more lines" tail.
const OUTPUT_MAX_LINES = 12;
const OUTPUT_MAX_LINE_LEN = 200;

function clampOutput(s: string): { lines: string[]; more: number } {
  const all = s.replace(/\r/g, "").replace(/\s+$/, "").split("\n");
  const lines = all
    .slice(0, OUTPUT_MAX_LINES)
    .map((l) => (l.length > OUTPUT_MAX_LINE_LEN ? l.slice(0, OUTPUT_MAX_LINE_LEN - 1) + "…" : l));
  return { lines, more: Math.max(0, all.length - OUTPUT_MAX_LINES) };
}

export function WorkflowCard({
  id,
  run,
  selected = false,
  hint = null,
  outputsExpanded = false,
  onActivate,
}: {
  id: string;
  run: WorkflowRun;
  selected?: boolean;
  expanded?: boolean;
  // ctrl+e: show each settled node's full (clamped) output below its row
  // instead of the one-line `→ <preview>` summary.
  outputsExpanded?: boolean;
  hint?: string | null;
  onActivate?: () => void;
}) {
  const tally = nodeTally(run);
  const shown = run.nodes.slice(0, MAX_NODE_ROWS);
  const overflow = run.nodes.length - shown.length;

  return (
    <ChatItem
      id={id}
      selected={selected}
      expandable={false}
      onActivate={onActivate}
    >
      <CardHeader
        status={workflowDotStatus(run.status)}
        verb="workflow"
        verbColor={theme.toolTask}
        title={truncate(run.goal, 64)}
        id={shortId(run.id)}
      />
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={statusColor(workflowDotStatus(run.status))} attributes={TextAttributes.BOLD}>
          {run.status}
        </text>
        {tally.total > 0 && (
          <>
            <text fg={theme.textMuted}>{"  ·  "}</text>
            <Counter value={tally.ok} bold color={theme.runnerClaude} />
            <text fg={theme.textFaint}>{"/"}</text>
            <Counter value={tally.total} color={theme.textMuted} />
            <text fg={theme.textFaint}>{" ok"}</text>
          </>
        )}
        <CountChips
          running={tally.running}
          errored={tally.error}
          skipped={tally.skipped}
        />
      </box>
      {shown.map((node, i) => {
        const detail =
          node.status === "error" && node.error
            ? { raw: node.error, color: theme.toolError, mark: "!" }
            : node.output
              ? { raw: node.output, color: theme.textFaint, mark: "→" }
              : null;
        const expandedOutput =
          outputsExpanded && detail ? clampOutput(detail.raw) : null;
        return (
          <Fragment key={node.id}>
            <SubRow
              last={i === shown.length - 1 && overflow <= 0}
              status={nodeDotStatus(node.status)}
              fadeIn
            >
              <text fg={runnerColor(node.runner)} attributes={TextAttributes.BOLD}>{` [${node.runner}]`}</text>
              {node.runId && (
                <text fg={theme.textFaint}>{`[${shortId(node.runId)}]`}</text>
              )}
              <text fg={theme.textMuted}>{` ${truncate(node.title, 48)}`}</text>
              {node.dependsOn && node.dependsOn.length > 0 && (
                <text fg={theme.textMuted}>{`  ← ${truncate(node.dependsOn.join(", "), 20)}`}</text>
              )}
              {/* One-line preview unless ctrl+e is showing the full output below. */}
              {!expandedOutput && detail && (
                <text fg={detail.color}>{`  ${detail.mark} ${truncate(detail.raw, 60)}`}</text>
              )}
            </SubRow>
            {expandedOutput && (
              <box flexDirection="column" paddingLeft={8}>
                {expandedOutput.lines.map((ln, j) => (
                  <text key={j} fg={detail!.color}>{ln || " "}</text>
                ))}
                {expandedOutput.more > 0 && (
                  <text fg={theme.textFaint}>{`… +${expandedOutput.more} more lines`}</text>
                )}
              </box>
            )}
          </Fragment>
        );
      })}
      {overflow > 0 && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └ "}</text>
          <text fg={theme.textFaint}>{`+${overflow} more nodes`}</text>
        </box>
      )}
      {/* ChatItem only renders its `hint` when selected+expandable, neither of
          which applies here (Tab-expand is owned by the App, not ctrl+e), so
          the Tab affordance is rendered directly in the body. */}
      {hint && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{`  ${hint}`}</text>
        </box>
      )}
    </ChatItem>
  );
}

function CountChips({
  running,
  errored,
  skipped,
}: {
  running: number;
  errored: number;
  skipped: number;
}) {
  const chips: Chip[] = [];
  if (running > 0) chips.push({ text: `${running} running`, color: theme.toolBash, bold: true });
  if (errored > 0) chips.push({ text: `${errored} error`, color: theme.toolError, bold: true });
  if (skipped > 0) chips.push({ text: `${skipped} skipped`, dim: true });
  if (chips.length === 0) return null;
  return (
    <>
      <text fg={theme.textMuted}>{"  ·  "}</text>
      <MetaChips chips={chips} />
    </>
  );
}

type Tally = {
  total: number;
  ok: number;
  running: number;
  error: number;
  skipped: number;
};

function nodeTally(run: WorkflowRun): Tally {
  const t: Tally = { total: run.nodes.length, ok: 0, running: 0, error: 0, skipped: 0 };
  for (const n of run.nodes) {
    if (n.status === "ok") t.ok += 1;
    else if (n.status === "running") t.running += 1;
    else if (n.status === "error") t.error += 1;
    else if (n.status === "skipped") t.skipped += 1;
  }
  return t;
}

// Map the two node statuses that aren't in the shared TuiStatus vocabulary
// onto the dot colors that read right: `ready` is a not-yet-dispatched node
// (hollow, like pending), `skipped` was bypassed by an upstream failure
// (subtle hollow, like cancelled). The rest pass straight through.
function nodeDotStatus(s: NodeStatus): string {
  if (s === "ready") return "pending";
  if (s === "skipped") return "cancelled";
  return s;
}

// WorkflowStatus carries `proposed`/`failed`, neither of which StatusDot or
// statusColor handle. Bridge them onto the shared vocabulary so the header dot
// and the status pill agree: `failed` is an error, `proposed` is a not-yet-run
// (pending) state. Pass running/done/cancelled through unchanged.
function workflowDotStatus(s: WorkflowStatus): string {
  if (s === "failed") return "error";
  if (s === "proposed") return "pending";
  return s;
}
