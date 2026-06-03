// Shared renderer for a peer agent's expanded work: the tool calls it made,
// its reply/thinking text, and any errors. Used by CollabCard (the collab
// peer's turns) and WorkflowRunCard (each workflow node's agent run) so the
// "expand to see what the agent actually did" view looks identical in both.
//
// `replyMaxLines` caps how much of a reply/thinking block is shown: CollabCard
// keeps the last 8 lines (the turn's conclusion), while WorkflowRunCard passes
// a high cap so a node's full output is visible — its reply IS the node result
// the user came to read.
import { TextAttributes } from "@opentui/core";
import { theme } from "../../theme";
import type { Block } from "../../util/blocks";
import { cleanModelText } from "../../util/format";
import { ToolCard } from "./ToolCard";
import { truncate } from "./format";
import { runnerColor } from "./format";

export function ExpandedBlocks({
  groupId,
  blocks,
  replyMaxLines = 8,
  label = "tool calls",
}: {
  groupId: string;
  blocks: Block[];
  replyMaxLines?: number;
  label?: string;
}) {
  return (
    <box flexDirection="column" paddingLeft={2} marginTop={0}>
      <text fg={theme.textFaint}>{label}</text>
      {blocks.map((block, i) => (
        <ExpandedBlock
          key={`${groupId}:child:${i}`}
          id={`${groupId}:child:${i}`}
          block={block}
          replyMaxLines={replyMaxLines}
        />
      ))}
    </box>
  );
}

export function ExpandedBlock({
  id,
  block,
  replyMaxLines = 8,
}: {
  id: string;
  block: Block;
  replyMaxLines?: number;
}) {
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
            {tailLines(text, replyMaxLines).map((line, i) => (
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

// Keep the last `max` lines of a block of text (the tail carries the
// conclusion). Each surviving line is hard-capped so one runaway line can't
// blow out the card width.
function tailLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - max)).map((line) => truncate(line, 180));
}
