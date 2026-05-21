import { useEffect, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { RunnerKind, Session } from "../../../shared/events.ts";
import { theme } from "../theme";
import { basename } from "../util/path";

const RUNNER_PALETTE: Record<RunnerKind, { active: string; idle: string }> = {
  claude: { active: theme.runnerClaude, idle: theme.runnerClaudeIdle },
  codex: { active: theme.runnerCodex, idle: theme.runnerCodexIdle },
};

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
  const innerWidth = Math.max(0, width - 3);

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
      <box flexDirection="row" paddingLeft={1} marginBottom={1} flexShrink={0}>
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
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              innerWidth={innerWidth}
            />
          ))}
        </scrollbox>
      )}

      <text fg={theme.textFaint}>{" j/k | n | dd"}</text>
    </box>
  );
}

function SessionRow({
  session,
  active,
  innerWidth,
}: {
  session: Session;
  active: boolean;
  innerWidth: number;
}) {
  // Layout: [accent][ ][title…………………][stream]
  //                   [cwd basename……][dirty]
  // Reserve one column on the right for the state glyph so the title doesn't
  // reflow when streaming toggles on/off mid-turn.
  const titleWidth = Math.max(0, innerWidth - 3);
  const subWidth = Math.max(0, innerWidth - 3);

  // Selection (active row) stays neutral white so it always reads as
  // "you are here"; runner identity lives on the idle `·` markers and on
  // the streaming dot, where it doesn't fight the selection signal.
  const palette = RUNNER_PALETTE[session.activeRunner];
  const accentColor = active ? theme.accent : palette.idle;
  const accentChar = active ? "▍" : "·";

  const streaming = session.streaming;
  const dirty = session.git?.dirty ?? false;

  return (
    <box id={session.id} flexDirection="column" flexShrink={0} marginBottom={1}>
      <box flexDirection="row">
        <text fg={accentColor}>{accentChar}</text>
        <text>{" "}</text>
        <text
          fg={active ? theme.text : theme.textMuted}
          attributes={active ? TextAttributes.BOLD : 0}
        >
          {truncate(session.title, titleWidth)}
        </text>
        <box flexGrow={1} />
        <text fg={streaming ? palette.active : theme.textFaint}>
          {streaming ? "●" : " "}
        </text>
      </box>
      <box flexDirection="row" paddingLeft={2}>
        <text fg={theme.textFaint}>
          {truncate(basename(session.cwd) || "~", subWidth)}
        </text>
        <box flexGrow={1} />
        <text fg={dirty ? theme.gitDirty : theme.textFaint}>
          {dirty ? "*" : " "}
        </text>
      </box>
    </box>
  );
}

function truncate(s: string, n: number): string {
  if (n <= 1) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
