import { TextAttributes } from "@opentui/core";
import type { Session } from "../../../shared/events.ts";
import { theme } from "../theme";

export function Sidebar({
  sessions,
  activeId,
  width,
}: {
  sessions: Session[];
  activeId: string | null;
  width: number;
}) {
  return (
    <box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      backgroundColor={theme.bgPanel}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>SESSIONS</text>
      <box height={1} />
      {sessions.length === 0 && <text fg={theme.textSubtle}>(none)</text>}
      {sessions.map((s) => {
        const active = s.id === activeId;
        return (
          <box key={s.id} flexDirection="row">
            <text fg={active ? theme.accent : theme.textFaint}>{active ? "▍" : " "}</text>
            <text
              fg={active ? theme.text : theme.textMuted}
              attributes={active ? TextAttributes.BOLD : 0}
            >
              {truncate(s.title, width - 6)}
            </text>
            {s.streaming && <text fg={theme.textMuted}>{" *"}</text>}
          </box>
        );
      })}
      <box flexGrow={1} />
      <text fg={theme.textFaint}>j/k nav  n new  dd del</text>
    </box>
  );
}

function truncate(s: string, n: number): string {
  if (n <= 1) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
