import { Fragment } from "react";
import { TextAttributes } from "@opentui/core";
import type { NodeStatus, WorkflowRun } from "../../../../shared/events.ts";
import { theme } from "../../theme";
import { shortId, stripPeerPrefix } from "../../util/format";
import { peerBlockRunId, type Block } from "../../util/blocks";
import { ChatItem } from "./ChatItem";
import { ExpandedBlocks } from "./ExpandedBlocks";
import { StatusDot } from "./StatusDot";
import { CardHeader, Counter, SubRow } from "./parts";
import { runnerColor, truncate } from "./format";

// Persistent transcript card for a workflow run's per-node agent work. The
// detached scheduler streams every node's peer events into one host assistant
// message (interleaved across parallel nodes); groupDelegations folds the
// settled nodes' blocks here as `blocks`. This card de-interleaves them back
// into per-node sections (by runId, ordered by run.nodes) so each agent's full
// work — its tool calls AND its reply/output — is reviewable on ctrl+e instead
// of vanishing when the node finishes. Mirrors CollabCard's expand-to-see-work
// shape; the floating WorkflowCard remains the live status pill.

// A reply line cap high enough to show a node's full output (its reply IS the
// result the user wants to read), bounded only so a pathological output can't
// run unbounded.
const NODE_REPLY_MAX_LINES = 400;

export type WorkflowNodeSection = {
  key: string;          // short runId (the per-node grouping key)
  runner: string;
  title: string;
  status: NodeStatus | "ok";
  blocks: Block[];
};

// De-interleave folded blocks into per-node sections. When the run is known,
// emit one section per node (in DAG/authoring order) that actually produced
// blocks; otherwise fall back to grouping purely by the runId tag on the
// blocks (a workflow whose run state was already cleared still shows its work).
export function buildNodeSections(
  run: WorkflowRun | null,
  blocks: Block[],
): WorkflowNodeSection[] {
  const byRun = new Map<string, Block[]>();
  for (const b of blocks) {
    const rid = peerBlockRunId(b) ?? "?";
    let arr = byRun.get(rid);
    if (!arr) {
      arr = [];
      byRun.set(rid, arr);
    }
    arr.push(b);
  }

  const sections: WorkflowNodeSection[] = [];
  const claimed = new Set<string>();
  if (run) {
    for (const node of run.nodes) {
      if (!node.runId) continue;
      const key = shortId(node.runId);
      const nodeBlocks = byRun.get(key);
      if (!nodeBlocks || nodeBlocks.length === 0) continue;
      claimed.add(key);
      sections.push({
        key,
        runner: node.runner,
        title: node.title,
        status: node.status,
        blocks: nodeBlocks,
      });
    }
  }
  // Any runId tags not matched to a node (run unknown, or a stray run-id) are
  // appended so no captured work is silently dropped.
  for (const [key, nodeBlocks] of byRun) {
    if (claimed.has(key)) continue;
    sections.push({
      key,
      runner: inferRunner(nodeBlocks),
      title: key,
      status: "ok",
      blocks: nodeBlocks,
    });
  }
  return sections;
}

function inferRunner(blocks: Block[]): string {
  for (const b of blocks) {
    if (b.kind === "peer_reply" || b.kind === "peer_thinking") return b.runner;
    if (b.kind === "tool") {
      const { peer } = stripPeerPrefix(b.log.name);
      if (peer) return peer;
    }
  }
  return "?";
}

// `ready`/`skipped` aren't in the shared StatusDot vocabulary; bridge them onto
// dots that read right (matches WorkflowCard's helper).
function nodeDotStatus(s: NodeStatus | "ok"): string {
  if (s === "ready") return "pending";
  if (s === "skipped") return "cancelled";
  return s;
}

function toolCount(blocks: Block[]): number {
  return blocks.filter((b) => b.kind === "tool").length;
}

export function WorkflowRunCard({
  id,
  run,
  blocks,
  selected = false,
  expanded = false,
  hint = null,
  onActivate,
}: {
  id: string;
  run: WorkflowRun | null;
  blocks: Block[];
  selected?: boolean;
  expanded?: boolean;
  hint?: string | null;
  onActivate?: () => void;
}) {
  const sections = buildNodeSections(run, blocks);

  const expandedNode =
    expanded && sections.length > 0 ? (
      <box flexDirection="column" paddingLeft={2} marginTop={0}>
        {sections.map((s) => (
          <box key={s.key} flexDirection="column" marginTop={0}>
            <box flexDirection="row">
              <StatusDot status={nodeDotStatus(s.status)} />
              <text fg={runnerColor(s.runner)} attributes={TextAttributes.BOLD}>{` [${s.runner}]`}</text>
              <text fg={theme.text}>{` ${truncate(s.title, 56)}`}</text>
            </box>
            <ExpandedBlocks
              groupId={`${id}:${s.key}`}
              blocks={s.blocks}
              replyMaxLines={NODE_REPLY_MAX_LINES}
              label="agent work"
            />
          </box>
        ))}
      </box>
    ) : null;

  return (
    <ChatItem
      id={id}
      selected={selected}
      expanded={expanded}
      expandable={sections.length > 0}
      hint={hint}
      onActivate={onActivate}
      expandedContent={expandedNode}
    >
      <CardHeader
        status={run ? workflowDotStatus(run.status) : "ok"}
        verb="Workflow"
        verbColor={theme.toolTask}
        title={truncate(run?.goal ?? "agent work", 60)}
        id={run ? shortId(run.id) : undefined}
      />
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <Counter value={sections.length} bold color={theme.runnerClaude} />
        <text fg={theme.textFaint}>{` agent${sections.length === 1 ? "" : "s"}`}</text>
        <text fg={theme.textMuted}>{"  ·  "}</text>
        <text fg={theme.textFaint}>{"ctrl+e to see each agent's work"}</text>
      </box>
      {!expanded &&
        sections.map((s, i) => (
          <Fragment key={s.key}>
            <SubRow last={i === sections.length - 1} status={nodeDotStatus(s.status)}>
              <text fg={runnerColor(s.runner)} attributes={TextAttributes.BOLD}>{` [${s.runner}]`}</text>
              <text fg={theme.textMuted}>{` ${truncate(s.title, 48)}`}</text>
              <text fg={theme.textFaint}>{`  ${toolCount(s.blocks)} step${toolCount(s.blocks) === 1 ? "" : "s"}`}</text>
            </SubRow>
          </Fragment>
        ))}
    </ChatItem>
  );
}

// WorkflowStatus carries `proposed`/`failed`; bridge onto the shared dot
// vocabulary (matches WorkflowCard).
function workflowDotStatus(s: WorkflowRun["status"]): string {
  if (s === "failed") return "error";
  if (s === "proposed") return "pending";
  return s;
}
