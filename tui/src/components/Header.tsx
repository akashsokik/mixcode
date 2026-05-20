import { TextAttributes } from "@opentui/core";
import type { Session } from "../../../shared/events.ts";
import { theme } from "../theme";

export function Header({ active }: { active: Session | null }) {
  return (
    <box
      height={1}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bgHeader}
    >
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>adverserial-code</text>
      <text fg={theme.textFaint}>{"   ·   "}</text>
      <text fg={theme.text}>{active?.title ?? "no session"}</text>
      {active && (
        <>
          <text fg={theme.textFaint}>{"   ·   "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>{`@${active.activeRunner}`}</text>
        </>
      )}
    </box>
  );
}
