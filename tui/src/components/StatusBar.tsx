import type { WSStatus } from "../api/ws";
import type { Session } from "../../../shared/events.ts";
import { theme } from "../theme";

type Props = {
  status: WSStatus;
  active: Session | null;
  sessionCount: number;
  focus: "prompt" | "browse";
};

export function StatusBar({ status, active, sessionCount, focus }: Props) {
  const dotFg =
    status === "open" ? theme.accent : status === "connecting" ? theme.textMuted : theme.textSubtle;
  return (
    <box
      height={1}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bgHeader}
    >
      <text fg={dotFg}>●</text>
      <text fg={theme.textMuted}>{` ${status}`}</text>
      <text fg={theme.textFaint}>{"   ·   "}</text>
      <text fg={theme.textMuted}>{`${sessionCount} session${sessionCount === 1 ? "" : "s"}`}</text>
      <text fg={theme.textFaint}>{"   ·   "}</text>
      <text fg={active?.streaming ? theme.accent : theme.textMuted}>
        {active?.streaming ? "streaming…" : "idle"}
      </text>
      <text fg={theme.textFaint}>{"   ·   "}</text>
      <text fg={theme.textMuted}>{focus === "prompt" ? "esc to browse" : "enter to type"}</text>
    </box>
  );
}
