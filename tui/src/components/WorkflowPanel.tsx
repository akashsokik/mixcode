// Ephemeral, Tab-toggled surfaces for a model-authored DAG run.
//
// WorkflowPanel renders the DAG in 2D (nodes grouped by dependency depth, with
// per-layer connectors and live per-node status). It is command-scoped and
// explicitly NOT a persistent rail (the session rail was removed in 209ba3f);
// it collapses back to the inline WorkflowCard on Tab/esc, and app.tsx stops
// offering Tab-expand once the run is terminal.
//
// WorkflowApprovalModal mirrors ConsensusModal: it shows a `proposed` run for
// the user to approve or reject before the scheduler starts. An invalid DAG
// surfaces the planner's structured validation error; the user can only reject.
//
// Key bindings (panel):    tab/esc collapse   c cancel
// Key bindings (approval): y/enter approve    esc/n reject
//
// Per-node streaming token text flows through the existing peer-event ->
// tool_log path; these surfaces carry only structural/status changes.

import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
  NodeStatus,
  RunnerKind,
  WorkflowNode,
  WorkflowRun,
  WorkflowStatus,
} from "../../../shared/events.ts";
import { theme } from "../theme";
import { StatusDot } from "./tuicards/StatusDot";
import { runnerColor, statusColor, truncate } from "./tuicards/format";
import { shortId } from "../util/format";

// Map node/workflow statuses that aren't in the shared StatusDot vocabulary
// onto ones it renders correctly. Kept local so the shared TuiStatus contract
// stays narrow (matches WorkflowCard's helpers).
function nodeDotStatus(s: NodeStatus): string {
  if (s === "ready") return "pending";
  if (s === "skipped") return "cancelled";
  return s;
}

function workflowDotStatus(s: WorkflowStatus): string {
  if (s === "failed") return "error";
  if (s === "proposed") return "pending";
  return s;
}

function runnerAccent(runner: RunnerKind): string {
  return runnerColor(runner);
}

export function approvalNodePromptPreview(node: WorkflowNode): string {
  const oneLine = node.prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}...` : oneLine;
}

// Group nodes into topological layers by depth = longest path from a root.
// The server cycle-checks before approval, so `visit` won't recurse forever on
// an approved run; we still guard with an in-progress set for defensiveness.
function computeLayers(nodes: WorkflowNode[]): WorkflowNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const inProgress = new Set<string>();
  const visit = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return 0; // cycle guard
    inProgress.add(id);
    const n = byId.get(id);
    const deps = (n?.dependsOn ?? []).filter((d: string) => byId.has(d));
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(visit));
    inProgress.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) visit(n.id);
  const layers: WorkflowNode[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    (layers[d] ??= []).push(n);
  }
  return layers;
}

export function WorkflowPanel({
  run,
  onClose,
  onCancel,
}: {
  run: WorkflowRun;
  onClose: () => void;
  onCancel: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "tab" || key.name === "escape") {
      onClose();
      return;
    }
    if (key.name === "c") {
      onCancel();
      return;
    }
  });

  const layers = computeLayers(run.nodes);
  const accent = statusColor(workflowDotStatus(run.status));

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={theme.toolTask} attributes={TextAttributes.BOLD}>{"Workflow  "}</text>
        <text fg={theme.textMuted}>{truncate(run.goal, 80)}</text>
        <text fg={theme.textFaint}>{`  ${shortId(run.id)}`}</text>
      </box>
      <box flexDirection="row">
        <StatusDot status={workflowDotStatus(run.status)} />
        <text fg={accent} attributes={TextAttributes.BOLD}>{` ${run.status}`}</text>
        <text fg={theme.textMuted}>{"   "}</text>
        <text fg={runnerAccent(run.planner)} attributes={TextAttributes.BOLD}>
          {`planner=${run.planner}`}
        </text>
      </box>

      <box flexDirection="column" marginTop={0}>
        {layers.map((layer, depth) => (
          <DagLayer key={`layer-${depth}`} layer={layer} depth={depth} />
        ))}
      </box>

      <box flexDirection="row">
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"[tab]"}</text>
        <text fg={theme.textMuted}>{" collapse   "}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"[c]"}</text>
        <text fg={theme.textMuted}>{" cancel"}</text>
      </box>
    </box>
  );
}

function DagLayer({ layer, depth }: { layer: WorkflowNode[]; depth: number }) {
  return (
    <box flexDirection="column">
      {depth > 0 && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └→"}</text>
        </box>
      )}
      {layer.map((node, i) => (
        <DagNode key={node.id} node={node} indent={depth} last={i === layer.length - 1} />
      ))}
    </box>
  );
}

function DagNode({ node, indent, last }: { node: WorkflowNode; indent: number; last: boolean }) {
  const marker = indent === 0 ? "  " : `  ${last ? "└ " : "├ "}`;
  // Detail line under the node: its final output once settled, or the error.
  const detail =
    node.status === "error" && node.error
      ? { text: `! ${truncate(node.error, 100)}`, color: theme.toolError }
      : node.output
        ? { text: `→ ${truncate(node.output, 100)}`, color: theme.textMuted }
        : null;
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.textMuted}>{marker}</text>
        <StatusDot status={nodeDotStatus(node.status)} />
        <text fg={runnerAccent(node.runner)} attributes={TextAttributes.BOLD}>{` [${node.runner}]`}</text>
        {node.runId && <text fg={theme.textFaint}>{`[${shortId(node.runId)}]`}</text>}
        <text fg={theme.text}>{` ${truncate(node.title, 60)}`}</text>
        {node.dependsOn && node.dependsOn.length > 0 && (
          <text fg={theme.textMuted}>{`  ← ${truncate(node.dependsOn.join(", "), 32)}`}</text>
        )}
      </box>
      {detail && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{`${marker}    `}</text>
          <text fg={detail.color}>{detail.text}</text>
        </box>
      )}
    </box>
  );
}

export function WorkflowApprovalModal({
  run,
  onAction,
}: {
  run: WorkflowRun;
  onAction: (action: "approve" | "reject") => void;
}) {
  useKeyboard((key) => {
    const name = key.name;
    if (name === "return" || name === "y") {
      onAction("approve");
      return;
    }
    if (name === "escape" || name === "n") {
      onAction("reject");
      return;
    }
  });

  const invalid = run.validationError ?? null;
  const accent = invalid ? theme.toolError : theme.toolTask;

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={accent} attributes={TextAttributes.BOLD}>{"Workflow  "}</text>
        <text fg={theme.textMuted}>{truncate(run.goal, 80)}</text>
      </box>
      <box flexDirection="row">
        <text fg={runnerAccent(run.planner)} attributes={TextAttributes.BOLD}>
          {`planner=${run.planner}`}
        </text>
        <text fg={theme.textMuted}>{"   "}</text>
        <text fg={theme.textFaint}>{`${run.nodes.length} node${run.nodes.length === 1 ? "" : "s"}`}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"Review node prompts before approving; node runs execute without further prompts."}</text>
      </box>

      {invalid && (
        <box flexDirection="row">
          <text fg={theme.toolError} attributes={TextAttributes.BOLD}>{`invalid DAG (${invalid.code}): `}</text>
          <text fg={theme.toolError}>{truncate(invalid.message, 120)}</text>
        </box>
      )}

      <box flexDirection="column" marginTop={0}>
        <text fg={theme.textMuted}>{`-- proposed nodes (${run.nodes.length}) --`}</text>
        {run.nodes.map((node) => (
          <box key={node.id} flexDirection="column">
            <box flexDirection="row">
              {/* The raw node-id prefix was dropped: it rendered in near-black
                  textFaint at variable width, which both misaligned every row and
                  was barely legible. The descriptive title + dependency list carry
                  the structure; deps still name the upstream nodes. */}
              <text fg={theme.textMuted}>{"  - "}</text>
              <text fg={runnerAccent(node.runner)} attributes={TextAttributes.BOLD}>{`[${node.runner}] `}</text>
              <text fg={theme.text}>{truncate(node.title, 60)}</text>
              {node.dependsOn && node.dependsOn.length > 0 && (
                <text fg={theme.textMuted}>{`  ← ${truncate(node.dependsOn.join(", "), 32)}`}</text>
              )}
            </box>
            <box flexDirection="row">
              <text fg={theme.textFaint}>{"      prompt: "}</text>
              <text fg={theme.textMuted}>{approvalNodePromptPreview(node)}</text>
            </box>
          </box>
        ))}
      </box>

      <ApprovalFooter invalid={invalid !== null} />
    </box>
  );
}

function ApprovalFooter({ invalid }: { invalid: boolean }) {
  if (invalid) {
    return (
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"["}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"esc"}</text>
        <text fg={theme.textMuted}>{"] reject (invalid DAG — re-planning is out of scope)"}</text>
      </box>
    );
  }
  return (
    <box flexDirection="row">
      <text fg={theme.textMuted}>{"["}</text>
      <text fg={theme.runnerClaude} attributes={TextAttributes.BOLD}>{"y/enter"}</text>
      <text fg={theme.textMuted}>{"] approve   ["}</text>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"esc/n"}</text>
      <text fg={theme.textMuted}>{"] reject"}</text>
    </box>
  );
}
