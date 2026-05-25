import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import type { Notice } from "../util/notice";
import { ChatItem } from "./ChatItem";

export function NoticeCard({
  notice,
  selected,
  onActivate,
}: {
  notice: Notice;
  selected: boolean;
  onActivate?: () => void;
}) {
  return (
    <ChatItem id={`notice:${notice.id}`} selected={selected} onActivate={onActivate}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
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
    </ChatItem>
  );
}
