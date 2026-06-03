import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
  PALETTES,
  THEME_LABELS,
  THEME_NAMES,
  theme,
  type ThemeName,
} from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

type Props = {
  current: ThemeName;
  onSelect: (name: ThemeName) => void;
  onCancel: () => void;
};

// The accent tokens previewed on each row, in a fixed order so the swatch reads
// consistently across palettes (edit/bash/web/task/error + the two diff hues).
const SWATCH_KEYS = [
  "toolEdit",
  "toolBash",
  "toolWeb",
  "toolTask",
  "toolError",
  "diffAddFg",
  "diffRemFg",
] as const;

export function ThemePicker({ current, onSelect, onCancel }: Props) {
  const [index, setIndex] = useState(0);

  // Land the cursor on the active palette so Enter is a no-op confirm.
  useEffect(() => {
    setIndex(Math.max(0, THEME_NAMES.indexOf(current)));
  }, [current]);

  useKeyboard((key) => {
    const name = key.name;
    if (name === "escape") return onCancel();
    if (name === "up" || name === "k") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === "down" || name === "j") {
      setIndex((i) => Math.min(THEME_NAMES.length - 1, i + 1));
      return;
    }
    if (ENTER_KEYS.has(name)) {
      const picked = THEME_NAMES[index];
      if (picked) onSelect(picked);
      return;
    }
  });

  const labelWidth = Math.max(...Object.values(THEME_LABELS).map((l) => l.length));

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.toolWeb}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={theme.toolWeb} attributes={TextAttributes.BOLD}>
          {"select theme"}
        </text>
        <text fg={theme.textFaint}>{"   monochrome base · swappable accents"}</text>
      </box>
      {THEME_NAMES.map((name, i) => (
        <Row
          key={name}
          name={name}
          selected={i === index}
          current={name === current}
          labelWidth={labelWidth}
        />
      ))}
      <box flexDirection="row" marginTop={0}>
        <text fg={theme.textFaint}>
          {"↑↓ navigate   enter apply   esc cancel"}
        </text>
      </box>
    </box>
  );
}

function Row({
  name,
  selected,
  current,
  labelWidth,
}: {
  name: ThemeName;
  selected: boolean;
  current: boolean;
  labelWidth: number;
}) {
  const palette = PALETTES[name];
  const marker = selected ? "›" : " ";
  const tick = current ? "•" : " ";
  return (
    <box flexDirection="row">
      <text fg={selected ? theme.accent : theme.textFaint}>{`${marker} `}</text>
      <text fg={current ? theme.toolEdit : theme.textFaint}>{`${tick} `}</text>
      <text
        fg={selected ? theme.text : theme.textMuted}
        attributes={selected ? TextAttributes.BOLD : 0}
      >
        {THEME_LABELS[name].padEnd(labelWidth, " ")}
      </text>
      <text fg={theme.textFaint}>{"   "}</text>
      {SWATCH_KEYS.map((k) => (
        <text key={k} fg={palette[k]}>
          {"■"}
        </text>
      ))}
    </box>
  );
}
