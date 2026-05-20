import { TextAttributes } from "@opentui/core";
import type { ToolLog } from "../../../shared/events.ts";
import { formatToolLog } from "../util/format";
import { theme } from "../theme";

export function ToolCard({ log }: { log: ToolLog }) {
  const { header, body, isError } = formatToolLog(log);
  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={isError ? theme.borderFocused : theme.border}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      <text
        fg={isError ? theme.accent : theme.textMuted}
        attributes={TextAttributes.BOLD}
      >
        {header}
      </text>
      {body && <text fg={theme.textMuted}>{body}</text>}
    </box>
  );
}
