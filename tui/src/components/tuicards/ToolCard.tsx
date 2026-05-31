import type { ToolLog } from "../../../../shared/events.ts";
import {
  formatInputPretty,
  formatToolLog,
  type EditPreview,
  type ToolCategory,
} from "../../util/format";
import { theme } from "../../theme";
import { toolLogStatus } from "./StatusDot";
import { ChatItem } from "./ChatItem";
import { CardHeader } from "./parts";
import { runnerColor } from "./format";

export function ToolCard({
  id,
  log,
  selected = false,
  expanded = false,
  hint = null,
  onActivate,
  nested = false,
}: {
  id: string;
  log: ToolLog;
  selected?: boolean;
  expanded?: boolean;
  // Footer hint shown when the card is selected (e.g. "ctrl+e to expand").
  hint?: string | null;
  // Called on mouse click. Convention: the App decides what activation means
  // — first click selects, second click on an already-selected card toggles
  // expansion. ToolCard just emits the intent.
  onActivate?: () => void;
  // True when this card is rendered inside another framing element
  // (e.g. DelegationGroup's anchor). Suppresses the outer box's
  // padding/margin/border so the parent fully owns the framing — without this,
  // the inner ToolCard's paddingLeft would stack with the parent's and shift
  // the header one column right of a regular top-level ToolCard.
  nested?: boolean;
}) {
  const { header, body, isError, category, edit, peer, peerRunId } = formatToolLog(log, {
    expanded,
  });
  const { verb, summary } = splitHeader(header);
  const accent = isError ? theme.toolError : accentFor(category);
  const status = toolLogStatus(log);
  // Pretty-printed input for the expanded non-edit view. Edit-category tools
  // get the diff treatment instead — pretty JSON of {file_path, old_string,
  // new_string} would just duplicate what the diff already shows.
  const prettyInput =
    expanded && category !== "edit" ? formatInputPretty(log.input) : "";

  const expandedNode = expanded ? (
    <ExpandedDetails prettyInput={prettyInput} body={body} edit={edit} />
  ) : null;

  return (
    <ChatItem
      id={id}
      selected={selected}
      expanded={expanded}
      expandable={true}
      hint={hint}
      nested={nested}
      onActivate={onActivate}
      marginTop={nested ? 0 : 1}
      expandedContent={expandedNode}
    >
      <CardHeader
        status={status}
        peer={peer ? { name: peer, color: runnerColor(peer), runId: peerRunId } : undefined}
        verb={verb}
        verbColor={accent}
        title={summary || undefined}
      />
      {edit && <DiffPreview edit={edit} />}
      {!edit && body && !expanded && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └ "}</text>
          <text fg={theme.textMuted}>{body}</text>
        </box>
      )}
    </ChatItem>
  );
}

function DiffPreview({ edit }: { edit: EditPreview }) {
  return (
    <box flexDirection="column" paddingLeft={2} marginTop={0}>
      {edit.removed.map((line, i) => (
        <box key={`r-${i}`} flexDirection="row" backgroundColor={theme.diffRemBg}>
          <text fg={theme.diffRemFg}>{"- "}</text>
          <text fg={theme.text}>{line || " "}</text>
        </box>
      ))}
      {edit.added.map((line, i) => (
        <box key={`a-${i}`} flexDirection="row" backgroundColor={theme.diffAddBg}>
          <text fg={theme.diffAddFg}>{"+ "}</text>
          <text fg={theme.text}>{line || " "}</text>
        </box>
      ))}
      {edit.more > 0 && (
        <text fg={theme.textFaint}>{`  … +${edit.more} more change${edit.more === 1 ? "" : "s"}`}</text>
      )}
    </box>
  );
}

// Full-detail body shown when the card is expanded. Edit-category tools have
// already rendered DiffPreview above; for them we only surface the output (if
// any). Other tools get an "input" block of pretty JSON plus the full output.
function ExpandedDetails({
  prettyInput,
  body,
  edit,
}: {
  prettyInput: string;
  body: string;
  edit: EditPreview | null;
}) {
  const inputLines = prettyInput ? prettyInput.split("\n") : [];
  const bodyLines = body ? body.split("\n") : [];
  return (
    <box flexDirection="column" paddingLeft={2} marginTop={0}>
      {!edit && inputLines.length > 0 && (
        <>
          <text fg={theme.textFaint}>{"── input ──"}</text>
          {inputLines.map((line, i) => (
            <text key={`i-${i}`} fg={theme.textMuted}>{line || " "}</text>
          ))}
        </>
      )}
      {bodyLines.length > 0 && (
        <>
          {(!edit && inputLines.length > 0) && (
            <text fg={theme.textFaint}>{"── output ──"}</text>
          )}
          {bodyLines.map((line, i) => (
            <text key={`o-${i}`} fg={theme.textMuted}>{line || " "}</text>
          ))}
        </>
      )}
    </box>
  );
}

function accentFor(category: ToolCategory): string {
  switch (category) {
    case "edit":
      return theme.toolEdit;
    case "bash":
      return theme.toolBash;
    case "web":
      return theme.toolWeb;
    case "task":
      return theme.toolTask;
    case "read":
      return theme.toolRead;
    case "other":
    default:
      return theme.text;
  }
}

// "Read /some/path" -> { verb: "Read", summary: "/some/path" }
// "Bash $ npm run build" -> { verb: "Bash", summary: "$ npm run build" }
function splitHeader(header: string): { verb: string; summary: string } {
  const space = header.indexOf(" ");
  if (space === -1) return { verb: header, summary: "" };
  return { verb: header.slice(0, space), summary: header.slice(space + 1) };
}

