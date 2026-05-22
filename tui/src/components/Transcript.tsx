import { useEffect, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { Session, SessionMessage } from "../../../shared/events.ts";
import { ToolCard } from "./ToolCard";
import { TaskCard } from "./TaskCard";
import { NoticeCard } from "./NoticeCard";
import { Welcome } from "./Welcome";
import { theme } from "../theme";
import { markdownStyle } from "../markdown-style";
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
import { useBlinkFrame } from "../util/spinner";

export function Transcript({
  session,
  notices,
  expandedDelegations,
  latestDelegationId,
}: {
  session: Session | null;
  notices: Notice[];
  expandedDelegations: Set<string>;
  latestDelegationId: string | null;
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
      contentOptions={{ justifyContent: "flex-end" }}
    >
      {entries.map((e) =>
        e.kind === "message" ? (
          <Message
            key={e.message.id}
            message={e.message}
            expandedDelegations={expandedDelegations}
            latestDelegationId={latestDelegationId}
          />
        ) : (
          <NoticeCard key={e.notice.id} notice={e.notice} />
        ),
      )}
    </scrollbox>
  );
}

function Message({
  message,
  expandedDelegations,
  latestDelegationId,
}: {
  message: SessionMessage;
  expandedDelegations: Set<string>;
  latestDelegationId: string | null;
}) {
  if (message.role === "user") return <UserMessage message={message} />;
  return (
    <AssistantMessage
      message={message}
      expandedDelegations={expandedDelegations}
      latestDelegationId={latestDelegationId}
    />
  );
}

function UserMessage({ message }: { message: SessionMessage }) {
  return (
    <box flexDirection="column" marginTop={1}>
      <box
        flexDirection="row"
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.textMuted}>{"› "}</text>
        <text fg={theme.text}>{message.text}</text>
      </box>
      <Rule />
    </box>
  );
}

function AssistantMessage({
  message,
  expandedDelegations,
  latestDelegationId,
}: {
  message: SessionMessage;
  expandedDelegations: Set<string>;
  latestDelegationId: string | null;
}) {
  const blocks = blocksFromEvents(message.events);
  const grouped = groupDelegations(blocks, message.id);

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
          return (
            <DelegationGroup
              key={`g-${g.id}`}
              group={g}
              expanded={expandedDelegations.has(g.id)}
              isLatest={g.id === latestDelegationId}
            />
          );
        }
        return (
          <BlockRow
            key={`b-${g.index}`}
            block={g.block}
            firstInMessage={gi === 0}
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
  block,
  firstInMessage,
}: {
  block: Block;
  firstInMessage: boolean;
}) {
  if (block.kind === "tool") {
    const bare = stripMcpPrefix(stripPeerPrefix(block.log.name).rest);
    if (bare === "task") return <TaskCard log={block.log} />;
    return <ToolCard log={block.log} />;
  }
  if (block.kind === "error") {
    return (
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted}>{"• "}</text>
        <text fg={theme.toolError} attributes={TextAttributes.BOLD}>
          {`error: ${block.message}`}
        </text>
      </box>
    );
  }
  if (block.kind === "thinking") {
    return (
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        marginTop={firstInMessage ? 0 : 1}
      >
        <text fg={theme.textFaint}>{"> "}</text>
        <text fg={theme.textSubtle}>{`Thought (${block.seconds}s)`}</text>
      </box>
    );
  }
  if (block.kind === "peer_reply") {
    return <PeerReply runner={block.runner} text={block.text} indent={!firstInMessage} />;
  }
  if (block.kind === "peer_thinking") {
    return (
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        marginTop={firstInMessage ? 0 : 1}
      >
        <text fg={theme.textFaint}>{"> "}</text>
        <text fg={peerColor(block.runner)} attributes={TextAttributes.BOLD}>{`[${block.runner}] `}</text>
        <text fg={theme.textSubtle}>{cleanModelText(block.text) || "thinking"}</text>
      </box>
    );
  }
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      marginTop={firstInMessage ? 0 : 1}
    >
      <text fg={theme.textMuted}>{"• "}</text>
      <box flexGrow={1}>
        <markdown content={cleanModelText(block.text)} syntaxStyle={markdownStyle} fg={theme.text} />
      </box>
    </box>
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
function DelegationGroup({
  group,
  expanded,
  isLatest,
}: {
  group: Extract<GroupedBlock, { kind: "delegation_group" }>;
  expanded: boolean;
  isLatest: boolean;
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
  // Same "ctrl+x to <action>" hint style as the prompt footer chips.
  const hint = isLatest
    ? expanded
      ? "ctrl+e to collapse"
      : "ctrl+e to expand"
    : null;

  return (
    <box flexDirection="column">
      {isPending ? (
        <PendingHeader
          tag={group.tag}
          runner={group.pendingRunner}
          toolCount={stats.tools}
          lastSummary={stats.lastSummary}
          replyChars={stats.replyChars}
        />
      ) : (
        <ToolCard log={group.header!} />
      )}
      {hasChildren && !expanded && !isPending && (
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
            {hint && <text fg={theme.textFaint}>{`  ·  ${hint}`}</text>}
          </box>
        </box>
      )}
      {hasChildren && !expanded && isPending && hint && (
        <box flexDirection="row" paddingLeft={3}>
          <text fg={theme.textFaint}>{hint}</text>
        </box>
      )}
      {hasChildren && expanded && (
        <box flexDirection="column" paddingLeft={2}>
          {group.children.map((b, i) => (
            <BlockRow key={`gc-${group.id}-${i}`} block={b} firstInMessage={false} />
          ))}
          {hint && (
            <box flexDirection="row" paddingLeft={1}>
              <text fg={theme.textFaint}>{`  ${hint}`}</text>
            </box>
          )}
        </box>
      )}
    </box>
  );
}

// Synthetic header used while the MCP body hasn't returned yet. Drawn in the
// same `• [runner] verb` shape as a ToolCard so the visual rhythm matches the
// completed-group rendering — only the trailing meta swaps in live counters
// and an animated braille frame.
function PendingHeader({
  tag,
  runner,
  toolCount,
  lastSummary,
  replyChars,
}: {
  tag: "delegate" | "validate";
  runner: string | null;
  toolCount: number;
  lastSummary: string | null;
  replyChars: number;
}) {
  const blink = useBlinkFrame(true);
  const peer = runner ?? "peer";
  const meta: string[] = [];
  meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  if (replyChars > 0) meta.push(`${formatChars(replyChars)} reply`);
  const label = tag === "validate" ? "validate" : "delegate";
  const verb = tag === "validate" ? "  validating…" : "  working…";
  // Sage for validate so it reads as review/safety; mauve toolTask for delegate work.
  const accent = tag === "validate" ? theme.toolEdit : theme.toolTask;
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1}>
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"• "}</text>
        <text fg={peerColor(peer)} attributes={TextAttributes.BOLD}>{`[${peer}] `}</text>
        <text fg={accent} attributes={TextAttributes.BOLD}>{label}</text>
        <text fg={theme.textFaint}>{"  "}</text>
        <text fg={peerColor(peer)}>{blink}</text>
        <text fg={theme.textMuted}>{verb}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={theme.textMuted}>{meta.join("  ·  ")}</text>
        {lastSummary && <text fg={theme.textFaint}>{`  ·  ${lastSummary}`}</text>}
      </box>
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
// the live pending header shows as the most recently-started peer tool.
function childStats(children: Block[]): {
  tools: number;
  replyChars: number;
  previewSummaries: string[];
  lastSummary: string | null;
} {
  let tools = 0;
  let replyChars = 0;
  const previewSummaries: string[] = [];
  let lastSummary: string | null = null;
  for (const b of children) {
    if (b.kind === "tool") {
      tools += 1;
      const summary = peerToolSummary(b.log);
      lastSummary = summary;
      if (previewSummaries.length < 2) previewSummaries.push(summary);
    } else if (b.kind === "peer_reply" || b.kind === "peer_thinking") {
      replyChars += b.text.length;
    }
  }
  return { tools, replyChars, previewSummaries, lastSummary };
}

function PeerReply({
  runner,
  text,
  indent,
}: {
  runner: string;
  text: string;
  indent: boolean;
}) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={indent ? 1 : 0}>
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"• "}</text>
        <text fg={peerColor(runner)} attributes={TextAttributes.BOLD}>{`[${runner}] reply`}</text>
      </box>
      <box flexDirection="row" paddingLeft={2}>
        <box flexGrow={1}>
          <markdown content={cleanModelText(text) || " "} syntaxStyle={markdownStyle} fg={theme.text} />
        </box>
      </box>
    </box>
  );
}

function peerColor(runner: string): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
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
