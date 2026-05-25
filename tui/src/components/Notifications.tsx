import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import type { Notification, NotificationKind } from "../util/notification";

const KIND_COLOR: Record<NotificationKind, string> = {
  info: theme.textMuted,
  success: theme.runnerClaude,
  error: theme.toolError,
};

const MAX_VISIBLE = 5;

// Toast-style floating stack pinned to the top-right of the App container.
// Each item is a single-line card with a colored left accent bar so severity
// reads at a glance; the message itself stays in the regular text weight so
// the palette feels consistent with the rest of the chat area.
export function Notifications({ items }: { items: Notification[] }) {
  if (items.length === 0) return null;
  const visible = items.slice(-MAX_VISIBLE);
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      flexDirection="column"
      zIndex={100}
    >
      {visible.map((n, i) => (
        <box
          key={n.id}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={2}
          marginTop={i === 0 ? 0 : 1}
          backgroundColor={theme.bgPanel}
        >
          <text fg={KIND_COLOR[n.kind]} attributes={TextAttributes.BOLD}>
            {"▎ "}
          </text>
          <text fg={theme.text}>{n.message}</text>
        </box>
      ))}
    </box>
  );
}
