import { TextAttributes } from "@opentui/core";
import type { ToolLog } from "../../../shared/events.ts";
import {
  formatToolLog,
  type EditPreview,
  type ToolCategory,
} from "../util/format";
import { theme } from "../theme";

export function ToolCard({ log }: { log: ToolLog }) {
  const { header, body, isError, category, edit, peer } = formatToolLog(log);
  const { verb, summary } = splitHeader(header);
  const accent = isError ? theme.toolError : accentFor(category);

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1}>
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"• "}</text>
        {peer && (
          <text fg={peerColor(peer)} attributes={TextAttributes.BOLD}>{`[${peer}] `}</text>
        )}
        <text fg={accent} attributes={TextAttributes.BOLD}>{verb}</text>
        {summary && <text fg={theme.text}>{" " + summary}</text>}
      </box>
      {edit && <DiffPreview edit={edit} />}
      {!edit && body && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  └ "}</text>
          <text fg={theme.textMuted}>{body}</text>
        </box>
      )}
    </box>
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

function peerColor(peer: string): string {
  if (peer === "claude") return theme.runnerClaude;
  if (peer === "codex") return theme.runnerCodex;
  return theme.textMuted;
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
