import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { EffortLevel, RunnerKind } from "../../../shared/events.ts";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

type Props = {
  runner: RunnerKind;
  modelLabel: string;
  // Server-resolved supported levels for the active runner+model (ordered).
  levels: EffortLevel[];
  // Current override, or null when unset (SDK default in effect).
  current: EffortLevel | null;
  onSelect: (effort: EffortLevel) => void;
  onReset: () => void;
  onCancel: () => void;
};

export function EffortSlider({
  runner,
  modelLabel,
  levels,
  current,
  onSelect,
  onReset,
  onCancel,
}: Props) {
  const accent = runner === "claude" ? theme.toolBash : theme.toolWeb;

  // Initial cursor: the current override if it is in the set, else the median
  // stop. We deliberately do NOT assume an SDK default level (not API-knowable).
  const initialIndex = (() => {
    if (current) {
      const i = levels.indexOf(current);
      if (i >= 0) return i;
    }
    return levels.length > 0 ? Math.floor((levels.length - 1) / 2) : 0;
  })();
  const [index, setIndex] = useState(initialIndex);

  useKeyboard((key) => {
    const name = key.name;
    if (name === "escape") return onCancel();
    if (levels.length === 0) return; // disabled state: only esc works
    if (name === "left" || name === "h") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === "right" || name === "l") {
      setIndex((i) => Math.min(levels.length - 1, i + 1));
      return;
    }
    if (name === "r") return onReset();
    if (ENTER_KEYS.has(name)) {
      const lvl = levels[index];
      if (lvl) onSelect(lvl);
      return;
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={accent} attributes={TextAttributes.BOLD}>{"effort"}</text>
        <text fg={theme.textMuted}>{`  ${runner} · ${modelLabel}`}</text>
      </box>

      {levels.length === 0 ? (
        <>
          <text fg={theme.textMuted}>{`effort not supported for ${modelLabel}`}</text>
          <text fg={theme.textFaint}>{"esc close"}</text>
        </>
      ) : (
        <>
          <box flexDirection="row" justifyContent="space-between" marginTop={0}>
            <text fg={theme.textFaint}>{"Speed"}</text>
            <text fg={theme.textFaint}>{"Intelligence"}</text>
          </box>
          <box flexDirection="row">
            {levels.map((lvl, i) => {
              const selected = i === index;
              const isCurrent = lvl === current;
              const fg = selected ? accent : isCurrent ? theme.toolEdit : theme.textMuted;
              return (
                <text
                  key={lvl}
                  fg={fg}
                  attributes={selected ? TextAttributes.BOLD : 0}
                >
                  {`${lvl}${i < levels.length - 1 ? "   " : ""}`}
                </text>
              );
            })}
          </box>
          <text fg={theme.textFaint}>
            {"←/→ adjust   enter select   r reset to default   esc cancel"}
          </text>
        </>
      )}
    </box>
  );
}
