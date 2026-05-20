import { useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { RunnerKind } from "../../../shared/events.ts";
import { modelsFor, type ModelEntry } from "../util/model-catalog";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

type Props = {
  runner: RunnerKind;
  currentId: string | undefined;
  onSelect: (modelId: string) => void;
  onReset: () => void;
  onCancel: () => void;
};

export function ModelPicker({
  runner,
  currentId,
  onSelect,
  onReset,
  onCancel,
}: Props) {
  const entries = useMemo(() => modelsFor(runner), [runner]);
  // Pre-select the current model so Enter on open is a no-op confirm.
  const initialIndex = Math.max(
    0,
    entries.findIndex((e) => e.id === currentId),
  );
  const [index, setIndex] = useState(initialIndex);

  useKeyboard((key) => {
    const name = key.name;
    if (name === "escape") return onCancel();
    if (name === "up" || name === "k") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === "down" || name === "j") {
      setIndex((i) => Math.min(entries.length - 1, i + 1));
      return;
    }
    if (name === "r") return onReset();
    if (ENTER_KEYS.has(name)) {
      const e = entries[index];
      if (e) onSelect(e.id);
      return;
    }
  });

  const labelWidth = Math.max(...entries.map((e) => e.label.length));
  const accent = runner === "claude" ? theme.toolBash : theme.toolWeb;

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
        <text fg={accent} attributes={TextAttributes.BOLD}>
          {"select model"}
        </text>
        <text fg={theme.textMuted}>{`  ${runner}`}</text>
      </box>
      {entries.map((entry, i) => (
        <Row
          key={entry.id}
          entry={entry}
          selected={i === index}
          current={entry.id === currentId}
          labelWidth={labelWidth}
        />
      ))}
      <box flexDirection="row" marginTop={0}>
        <text fg={theme.textFaint}>
          {"↑↓ navigate   enter select   r reset to default   esc cancel"}
        </text>
      </box>
    </box>
  );
}

function Row({
  entry,
  selected,
  current,
  labelWidth,
}: {
  entry: ModelEntry;
  selected: boolean;
  current: boolean;
  labelWidth: number;
}) {
  const marker = selected ? "›" : " ";
  const tick = current ? "•" : " ";
  const labelFg = selected ? theme.text : theme.textMuted;
  return (
    <box flexDirection="row">
      <text fg={selected ? theme.accent : theme.textFaint}>{`${marker} `}</text>
      <text fg={current ? theme.toolEdit : theme.textFaint}>{`${tick} `}</text>
      <text
        fg={labelFg}
        attributes={selected ? TextAttributes.BOLD : 0}
      >
        {entry.label.padEnd(labelWidth, " ")}
      </text>
      <text fg={theme.textFaint}>{`   ${entry.id}`}</text>
      {entry.hint && (
        <text fg={theme.textSubtle}>{`   ${entry.hint}`}</text>
      )}
    </box>
  );
}
