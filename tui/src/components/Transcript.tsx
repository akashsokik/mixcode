import { useEffect, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { Session, SessionMessage } from "../../../shared/events.ts";
import {
  ChatItem,
  CollabCard,
  NoticeCard,
  StatusDot,
  TaskCard,
  ToolCard,
  Welcome,
} from "./tuicards";
import { theme } from "../theme";
import { markdownStyle, markdownTableOptions } from "../markdown-style";
import type { Notice } from "../util/notice";
import {
  cleanModelText,
  peerToolSummary,
  stripMcpPrefix,
  stripPeerPrefix,
} from "../util/format";
import {
  blocksFromEvents,
  groupDelegations,
  type Block,
  type GroupedBlock,
} from "../util/blocks";

export function Transcript({
  session,
  notices,
  selectedItemId,
  expandedItems,
  onItemActivate,
}: {
  session: Session | null;
  notices: Notice[];
  selectedItemId: string | null;
  expandedItems: Set<string>;
  onItemActivate?: (itemId: string) => void;
}) {
  if (!session) {
    return <Welcome />;
  }

  type Entry =
    | { kind: "message"; at: string; message: SessionMessage }
    | { kind: "notice"; at: string; notice: Notice };

  const entries: Entry[] = [
    ...session.messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...notices.map((n) => ({ kind: "notice" as const, at: n.createdAt, notice: n })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  if (entries.length === 0) {
    return <Welcome />;
  }

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const lastMsg = session.messages[session.messages.length - 1];
  // Content signature for the last message: sums parent text length, event
  // count, AND the length of every tool_log output so that in-place updates
  // (streaming peer reply text replacing the same tool_log id) still trigger
  // the auto-scroll. Without the per-output term, peer streaming wouldn't
  // re-fire this effect since events.length stays constant after dedupe.
  const lastMsgSig = ((): number => {
    if (!lastMsg) return 0;
    let n = lastMsg.text.length + lastMsg.events.length;
    for (const ev of lastMsg.events) {
      if (ev.type !== "tool_log") continue;
      const out = ev.log.output;
      if (typeof out === "string") n += out.length;
      else if (out && typeof out === "object") {
        // Live snapshots (task) update in place with object payloads; fall
        // back to stringified length so the scroll effect still re-fires.
        try {
          n += JSON.stringify(out).length;
        } catch {
          n += 1;
        }
      }
    }
    return n;
  })();
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTo(box.scrollHeight);
  }, [session.messages.length, notices.length, lastMsgSig]);

  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      stickyScroll
      stickyStart="bottom"
      scrollbarOptions={{ showArrows: false }}
    >
      {entries.map((e) =>
        e.kind === "message" ? (
          <Message
            key={e.message.id}
            message={e.message}
            // Only the last assistant message can legitimately host a still-
            // running peer group. Earlier messages are settled; any trailing
            // peer events with no anchor on those represent runs that were
            // killed mid-call (server crashed, app closed, /clear races).
            // groupDelegations uses this to decide whether to synthesize the
            // "working…" pending header or just render the peer events plain.
            messageStreaming={
              session.streaming && e.message.id === lastMsg?.id
            }
            selectedItemId={selectedItemId}
            expandedItems={expandedItems}
            onItemActivate={onItemActivate}
          />
        ) : (
          <NoticeCard
            key={e.notice.id}
            notice={e.notice}
            selected={`notice:${e.notice.id}` === selectedItemId}
            onActivate={
              onItemActivate
                ? () => onItemActivate(`notice:${e.notice.id}`)
                : undefined
            }
          />
        ),
      )}
    </scrollbox>
  );
}

function Message({
  message,
  messageStreaming,
  selectedItemId,
  expandedItems,
  onItemActivate,
}: {
  message: SessionMessage;
  messageStreaming: boolean;
  selectedItemId: string | null;
  expandedItems: Set<string>;
  onItemActivate?: (itemId: string) => void;
}) {
  if (message.role === "user") {
    const id = `msg:${message.id}`;
    return (
      <UserMessage
        message={message}
        selected={id === selectedItemId}
        onActivate={onItemActivate ? () => onItemActivate(id) : undefined}
      />
    );
  }
  return (
    <AssistantMessage
      message={message}
      messageStreaming={messageStreaming}
      selectedItemId={selectedItemId}
      expandedItems={expandedItems}
      onItemActivate={onItemActivate}
    />
  );
}

function UserMessage({
  message,
  selected,
  onActivate,
}: {
  message: SessionMessage;
  selected: boolean;
  onActivate?: () => void;
}) {
  return (
    <>
      <ChatItem id={`msg:${message.id}`} selected={selected} onActivate={onActivate}>
        <box
          flexDirection="row"
          backgroundColor={theme.bgPanel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={theme.textMuted}>{"› "}</text>
          <text fg={theme.text}>{message.text}</text>
        </box>
      </ChatItem>
      <Rule />
    </>
  );
}

function AssistantMessage({
  message,
  messageStreaming,
  selectedItemId,
  expandedItems,
  onItemActivate,
}: {
  message: SessionMessage;
  messageStreaming: boolean;
  selectedItemId: string | null;
  expandedItems: Set<string>;
  onItemActivate?: (itemId: string) => void;
}) {
  const blocks = blocksFromEvents(message.events);
  const grouped = groupDelegations(blocks, message.id, messageStreaming);

  if (grouped.length === 0) {
    return (
      <box flexDirection="column" marginTop={1}>
        <box flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>{"• "}</text>
          <text fg={theme.textSubtle}>…</text>
        </box>
        <Rule />
      </box>
    );
  }

  return (
    <box flexDirection="column" marginTop={1}>
      {grouped.map((g, gi) => {
        if (g.kind === "delegation_group") {
          const isSelected = g.id === selectedItemId;
          const isExpanded = expandedItems.has(g.id);
          const hint = isSelected
            ? isExpanded
              ? "click or ctrl+e to collapse"
              : "click or ctrl+e to expand"
            : null;
          return (
            <DelegationGroup
              key={`g-${g.id}`}
              group={g}
              selected={isSelected}
              expanded={isExpanded}
              hint={hint}
              onActivate={onItemActivate ? () => onItemActivate(g.id) : undefined}
              messageStreaming={messageStreaming}
            />
          );
        }
        if (g.kind === "collab_group") {
          const isSelected = g.id === selectedItemId;
          const isExpanded = expandedItems.has(g.id);
          const hint = isSelected
            ? isExpanded
              ? "click or ctrl+e to collapse"
              : "click or ctrl+e to expand"
            : null;
          return (
            <CollabCard
              key={`c-${g.id}`}
              id={g.id}
              snapshot={g.snapshot}
              blocks={g.children}
              selected={isSelected}
              expanded={isExpanded}
              active={messageStreaming}
              hint={hint}
              onActivate={onItemActivate ? () => onItemActivate(g.id) : undefined}
            />
          );
        }
        const itemId = `${message.id}:${g.index}`;
        const isToolSelected =
          g.block.kind === "tool" && itemId === selectedItemId;
        const isToolExpanded =
          g.block.kind === "tool" && expandedItems.has(itemId);
        return (
          <BlockRow
            key={`b-${g.index}`}
            id={itemId}
            block={g.block}
            firstInMessage={gi === 0}
            toolSelected={isToolSelected}
            toolExpanded={isToolExpanded}
            onToolActivate={
              g.block.kind === "tool" && onItemActivate
                ? () => onItemActivate(itemId)
                : undefined
            }
            selectedItemId={selectedItemId}
            onItemActivate={onItemActivate}
            messageStreaming={messageStreaming}
          />
        );
      })}
      <Rule />
    </box>
  );
}

// Renders one non-grouped block. Pulled out so DelegationGroup can reuse it
// for its children when expanded — keeps a single source of truth for how
// each block kind looks.
function BlockRow({
  id,
  block,
  firstInMessage,
  toolSelected = false,
  toolExpanded = false,
  onToolActivate,
  selectedItemId,
  onItemActivate,
  messageStreaming = false,
}: {
  id: string;
  block: Block;
  firstInMessage: boolean;
  toolSelected?: boolean;
  toolExpanded?: boolean;
  onToolActivate?: () => void;
  selectedItemId: string | null;
  onItemActivate?: (itemId: string) => void;
  messageStreaming?: boolean;
}) {
  const isSelected = id === selectedItemId;
  const activate = onItemActivate ? () => onItemActivate(id) : undefined;
  const rowMarginTop = firstInMessage ? 0 : 1;
  if (block.kind === "tool") {
    const bare = stripMcpPrefix(stripPeerPrefix(block.log.name).rest);
    if (bare === "task") {
      return (
        <TaskCard
          id={id}
          log={block.log}
          selected={isSelected}
          onActivate={activate}
        />
      );
    }
    const hint = toolSelected
      ? toolExpanded
        ? "click or ctrl+e to collapse"
        : "click or ctrl+e to expand"
      : null;
    return (
      <ToolCard
        id={id}
        log={block.log}
        selected={toolSelected}
        expanded={toolExpanded}
        hint={hint}
        onActivate={onToolActivate}
      />
    );
  }
  if (block.kind === "error") {
    return (
      <ChatItem id={id} selected={isSelected} onActivate={activate} marginTop={rowMarginTop}>
        <box flexDirection="row">
          <text fg={theme.textMuted}>{"• "}</text>
          <text fg={theme.toolError} attributes={TextAttributes.BOLD}>
            {`error: ${block.message}`}
          </text>
        </box>
      </ChatItem>
    );
  }
  if (block.kind === "thinking") {
    return (
      <ChatItem id={id} selected={isSelected} onActivate={activate} marginTop={rowMarginTop}>
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"> "}</text>
          <text fg={theme.textSubtle}>{`Thought (${block.seconds}s)`}</text>
        </box>
      </ChatItem>
    );
  }
  if (block.kind === "peer_reply") {
    return (
      <PeerReply
        id={id}
        runner={block.runner}
        text={block.text}
        indent={!firstInMessage}
        selected={isSelected}
        onActivate={activate}
        streaming={messageStreaming}
      />
    );
  }
  if (block.kind === "peer_thinking") {
    return (
      <ChatItem id={id} selected={isSelected} onActivate={activate} marginTop={rowMarginTop}>
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"> "}</text>
          <text fg={peerColor(block.runner)} attributes={TextAttributes.BOLD}>{`[${block.runner}] `}</text>
          <text fg={theme.textSubtle}>{cleanModelText(block.text) || "thinking"}</text>
        </box>
      </ChatItem>
    );
  }
  // Assistant prose — no leading bullet. The markdown element is block-level
  // and doesn't compose cleanly as a flex-row sibling: the bullet's trailing
  // space gets eaten and subsequent paragraph lines wrap flush-left over the
  // bullet column. Drop the marker; let the markdown content stand on its own.
  return (
    <ChatItem id={id} selected={isSelected} onActivate={activate} marginTop={rowMarginTop}>
      <markdown
        content={cleanModelText(block.text)}
        syntaxStyle={markdownStyle}
        fg={theme.text}
        streaming={messageStreaming}
        tableOptions={markdownTableOptions}
      />
    </ChatItem>
  );
}

// Folded delegate_run + its peer-stream children. Three render modes:
//   - completed + collapsed:  anchor card + "+N tool uses" preview line
//   - completed + expanded:   anchor card + every child via BlockRow
//   - pending (header null):  synthetic spinner header + live tool counters
//
// Pending mode lets the group materialize the moment the first peer event
// arrives so the transcript doesn't reshuffle when the delegate_run anchor
// finally lands at the end of the MCP body.
//
// Mirrors ToolCard's selected/expanded/hint/onActivate API so delegations
// participate in the same shift+up/down navigation, click-to-expand, and
// border highlight as regular tool cards.
function DelegationGroup({
  group,
  selected,
  expanded,
  hint,
  onActivate,
  messageStreaming = false,
}: {
  group: Extract<GroupedBlock, { kind: "delegation_group" }>;
  selected: boolean;
  expanded: boolean;
  hint: string | null;
  onActivate?: () => void;
  messageStreaming?: boolean;
}) {
  const isPending = group.header === null;
  const stats = childStats(group.children);
  const hasChildren = group.children.length > 0;
  // Count tool uses only (peer reply/thinking are separate streams, not tools)
  // so the collapsed line matches what the expanded view shows as `• [peer] X`.
  const toolCount = stats.tools;
  // For completed validate groups, pull the verdict out of the anchor's
  // output JSON so the collapsed line shows pass / needs_changes / fail at
  // a glance without expanding.
  const verdict =
    !isPending && group.tag === "validate"
      ? extractVerdict(group.header)
      : null;

  const headerNode = isPending ? (
    <PendingHeader
      tag={group.tag}
      runner={group.pendingRunner}
      toolCount={stats.tools}
      lastSummary={stats.lastSummary}
      replyChars={stats.replyChars}
      replyTail={stats.replyTail}
    />
  ) : (
    <ToolCard id={group.id} log={group.header!} nested />
  );

  const collapsedExtras = hasChildren && !isPending ? (
    <box flexDirection="column" paddingLeft={3} paddingRight={1}>
      {verdict && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"└ "}</text>
          <text fg={verdictColor(verdict.verdict)} attributes={TextAttributes.BOLD}>
            {`verdict: ${verdict.verdict}`}
          </text>
          {verdict.summary && (
            <text fg={theme.textMuted}>{`  ${truncate(verdict.summary, 80)}`}</text>
          )}
        </box>
      )}
      {!verdict && stats.previewSummaries.length > 0 && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"└ "}</text>
          <text fg={theme.textMuted}>{stats.previewSummaries.join("  ·  ")}</text>
        </box>
      )}
      <box flexDirection="row">
        <text fg={theme.textFaint}>{collapsedSummary(toolCount, stats.replyChars)}</text>
      </box>
    </box>
  ) : null;

  const expandedChildren = hasChildren ? (
    <box flexDirection="column" paddingLeft={2}>
      {group.children.map((b, i) => (
        <BlockRow
          key={`gc-${group.id}-${i}`}
          id={`${group.id}:${i}`}
          block={b}
          firstInMessage={false}
          selectedItemId={null}
          // Pending delegations are still live; the expanded peer reply is the
          // in-flight draft, so its <markdown> needs streaming=true to keep the
          // trailing block unstable. For completed groups the parent message
          // has already stopped streaming, so this is a no-op.
          messageStreaming={messageStreaming && isPending}
        />
      ))}
    </box>
  ) : null;

  return (
    <ChatItem
      id={group.id}
      selected={selected}
      expanded={expanded}
      expandable={hasChildren}
      hint={hint}
      onActivate={onActivate}
      expandedContent={expandedChildren}
    >
      {headerNode}
      {!expanded && collapsedExtras}
    </ChatItem>
  );
}

// Synthetic header used while the MCP body hasn't returned yet. Drawn in the
// same `<StatusDot> [runner] verb` shape as a ToolCard so the visual rhythm
// matches the completed-group rendering — only the trailing meta swaps in live
// counters. The blinking dot is the leading StatusDot itself (status=running)
// so the activity indicator sits in the same column as every other tool card.
// `replyTail` is the in-flight draft text (last few lines) so the user sees
// the actual content being written, not just "Xk chars reply".
function PendingHeader({
  tag,
  runner,
  toolCount,
  lastSummary,
  replyChars,
  replyTail,
}: {
  tag: "delegate" | "validate" | "consensus";
  runner: string | null;
  toolCount: number;
  lastSummary: string | null;
  replyChars: number;
  replyTail: string;
}) {
  const peer = runner ?? "peer";
  const meta: string[] = [];
  meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  if (replyChars > 0) meta.push(`${formatChars(replyChars)} reply`);
  const label =
    tag === "validate" ? "Validate" : tag === "consensus" ? "Consensus step" : "Delegate";
  const verb =
    tag === "validate"
      ? " validating…"
      : tag === "consensus"
        ? " drafting…"
        : " working…";
  // Sage for validate so it reads as review/safety; soft amber for consensus
  // so the actor/critic loop is visually distinct from a plain delegate run;
  // mauve toolTask for delegate work.
  const accent =
    tag === "validate"
      ? theme.toolEdit
      : tag === "consensus"
        ? theme.toolBash
        : theme.toolTask;
  const tailLineList = replyTail ? replyTail.split("\n") : [];
  return (
    <box flexDirection="column" paddingRight={1}>
      <box flexDirection="row">
        <StatusDot status="running" />
        <text fg={theme.text}>{" "}</text>
        <text fg={peerColor(peer)} attributes={TextAttributes.BOLD}>{`[${peer}] `}</text>
        <text fg={accent} attributes={TextAttributes.BOLD}>{label}</text>
        <text fg={theme.textMuted}>{verb}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={theme.textMuted}>{meta.join("  ·  ")}</text>
        {lastSummary && <text fg={theme.textFaint}>{`  ·  ${lastSummary}`}</text>}
      </box>
      {tailLineList.length > 0 && (
        <box flexDirection="column" paddingLeft={4} marginTop={0}>
          <text fg={theme.textFaint}>{"writing:"}</text>
          {tailLineList.map((line, i) => (
            <text key={`tail-${i}`} fg={theme.textMuted}>
              {line || " "}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}

// Extract a verdict from a validate_run anchor's output. The MCP body
// returns a JSON payload; the SDK delivers it either as a string or
// pre-parsed object.
function extractVerdict(
  header: import("../../../shared/events.ts").ToolLog | null,
): { verdict: string; summary: string } | null {
  if (!header) return null;
  const out = header.output;
  let parsed: unknown = out;
  if (typeof out === "string") {
    try {
      parsed = JSON.parse(out);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const v = typeof p.verdict === "string" ? p.verdict : null;
  if (!v) return null;
  const summary = typeof p.summary === "string" ? p.summary : "";
  return { verdict: v, summary };
}

function verdictColor(v: string): string {
  if (v === "pass") return theme.runnerClaude; // sage
  if (v === "needs_changes") return theme.toolBash; // amber
  if (v === "fail") return theme.toolError; // brick
  return theme.textMuted; // unknown
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

function collapsedSummary(tools: number, replyChars: number): string {
  const parts: string[] = [];
  if (tools > 0) parts.push(`+${tools} tool use${tools === 1 ? "" : "s"}`);
  if (replyChars > 0) parts.push(`${formatChars(replyChars)} reply`);
  return parts.length > 0 ? `  … ${parts.join("  ·  ")}` : "";
}

// Aggregate stats for the children of a delegation_group. `previewSummaries`
// is reused by the collapsed completed-group preview; `lastSummary` is what
// the live pending header shows as the most recently-started peer tool;
// `replyTail` is the trailing N lines of the latest peer reply text so the
// live header can preview the actual draft being written, not just chars.
const REPLY_TAIL_LINES = 6;
const REPLY_TAIL_CHARS = 320;

function childStats(children: Block[]): {
  tools: number;
  replyChars: number;
  previewSummaries: string[];
  lastSummary: string | null;
  replyTail: string;
} {
  let tools = 0;
  let replyChars = 0;
  const previewSummaries: string[] = [];
  let lastSummary: string | null = null;
  // Track the LAST peer_reply we encountered — that's the in-flight draft.
  // Earlier peer_reply blocks belong to closed groups already; for the
  // pending tail we only care about the freshest one.
  let latestReply = "";
  for (const b of children) {
    if (b.kind === "tool") {
      tools += 1;
      const summary = peerToolSummary(b.log);
      lastSummary = summary;
      if (previewSummaries.length < 2) previewSummaries.push(summary);
    } else if (b.kind === "peer_reply" || b.kind === "peer_thinking") {
      replyChars += b.text.length;
      if (b.kind === "peer_reply") latestReply = b.text;
    }
  }
  return {
    tools,
    replyChars,
    previewSummaries,
    lastSummary,
    replyTail: tailLines(latestReply, REPLY_TAIL_LINES, REPLY_TAIL_CHARS),
  };
}

// Last N lines (or last M chars, whichever is shorter) of the running
// peer text. Strips leading whitespace lines and caps each line so the
// pending header stays bounded.
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

function PeerReply({
  id,
  runner,
  text,
  indent,
  selected,
  onActivate,
  streaming = false,
}: {
  id: string;
  runner: string;
  text: string;
  indent: boolean;
  selected: boolean;
  onActivate?: () => void;
  streaming?: boolean;
}) {
  return (
    <ChatItem id={id} selected={selected} onActivate={onActivate} marginTop={indent ? 1 : 0}>
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"• "}</text>
        <text fg={peerColor(runner)} attributes={TextAttributes.BOLD}>{`[${runner}] reply`}</text>
      </box>
      <box flexDirection="row" paddingLeft={2}>
        <box flexGrow={1}>
          <markdown
            content={cleanModelText(text) || " "}
            syntaxStyle={markdownStyle}
            fg={theme.text}
            streaming={streaming}
            tableOptions={markdownTableOptions}
          />
        </box>
      </box>
    </ChatItem>
  );
}

function peerColor(runner: string): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  if (runner === "vercel") return theme.runnerVercel;
  if (runner === "ollama") return theme.runnerOllama;
  return theme.textMuted;
}

function Rule() {
  return (
    <box
      marginTop={1}
      border={["bottom"]}
      borderStyle="single"
      borderColor={theme.border}
      height={1}
    />
  );
}
