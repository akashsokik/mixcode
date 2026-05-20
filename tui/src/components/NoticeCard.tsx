import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import type { Notice } from "../util/notice";

export function NoticeCard({ notice }: { notice: Notice }) {
  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      border={["left"]}
      borderStyle="single"
      borderColor={theme.border}
    >
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"· "}</text>
        <text fg={theme.accentDim} attributes={TextAttributes.BOLD}>
          {notice.command}
        </text>
      </box>
      {notice.lines.map((line, i) => (
        <text key={i} fg={theme.textMuted}>
          {line || " "}
        </text>
      ))}
    </box>
  );
}
