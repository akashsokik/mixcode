import { useEffect, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { Session } from "../../../shared/events.ts";
import { theme } from "../theme";
import { basename } from "../util/path";

export function Sidebar({
  sessions,
  activeId,
  width,
}: {
  sessions: Session[];
  activeId: string | null;
  width: number;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Keep the active session in view as the user navigates with j/k.
  useEffect(() => {
    if (!activeId || !scrollRef.current) return;
    try {
      scrollRef.current.scrollChildIntoView(activeId);
    } catch {
      // The child may not be mounted yet (initial render before reconcile);
      // the next activeId change will retry.
    }
  }, [activeId, sessions.length]);

  return (
    <box
      width={width}
      flexDirection="column"
      border={["right"]}
      borderStyle="single"
      borderColor={theme.border}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={1}
    >
      <box flexDirection="row" paddingLeft={1} marginBottom={2} flexShrink={0}>
        <text fg={theme.textSubtle}>sessions</text>
        <box flexGrow={1} />
        <text fg={theme.textFaint}>{`${sessions.length}`}</text>
      </box>
      {sessions.length === 0 ? (
        <text fg={theme.textSubtle}>{"  (none)"}</text>
      ) : (
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          scrollY
          scrollbarOptions={{ showArrows: false }}
        >
          {sessions.map((s) => {
            const active = s.id === activeId;
            return (
              <box
                key={s.id}
                id={s.id}
                flexDirection="column"
                flexShrink={0}
              >
                <box flexDirection="row">
                  <text fg={active ? theme.accent : theme.textFaint}>
                    {active ? "▍" : " "}
                  </text>
                  <text
                    fg={active ? theme.text : theme.textMuted}
                    attributes={active ? TextAttributes.BOLD : 0}
                  >
                    {truncate(s.title, width - 6)}
                  </text>
                  {s.streaming && <text fg={theme.toolEdit}>{" •"}</text>}
                </box>
                <box flexDirection="row" paddingLeft={1}>
                  <text fg={theme.textFaint}>
                    {truncate(basename(s.cwd), width - 6)}
                  </text>
                </box>
              </box>
            );
          })}
        </scrollbox>
      )}
      <text fg={theme.textFaint}>{" j/k  ·  n new  ·  dd del"}</text>
    </box>
  );
}

function truncate(s: string, n: number): string {
  if (n <= 1) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
