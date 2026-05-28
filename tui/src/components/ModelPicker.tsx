import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { RunnerKind } from "../../../shared/events.ts";
import { type ModelEntry } from "../util/model-catalog";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

type Props = {
  runner: RunnerKind;
  currentId: string | undefined;
  // Selectable models. For ollama this is fetched live from the daemon; for the
  // hosted runners it's the static catalog. The picker stays presentational.
  entries: ModelEntry[];
  loading?: boolean;
  error?: string | null;
  onSelect: (modelId: string) => void;
  onReset: () => void;
  onCancel: () => void;
};

export function ModelPicker({
  runner,
  currentId,
  entries,
  loading = false,
  error = null,
  onSelect,
  onReset,
  onCancel,
}: Props) {
  const [index, setIndex] = useState(0);

  // Re-sync the cursor onto the current model whenever the entry set changes
  // (e.g. an async ollama fetch resolves after open) so Enter is a no-op
  // confirm rather than landing on an arbitrary row.
  useEffect(() => {
    setIndex(Math.max(0, entries.findIndex((e) => e.id === currentId)));
  }, [entries, currentId]);

  const selectable = !loading && !error && entries.length > 0;

  useKeyboard((key) => {
    const name = key.name;
    if (name === "escape") return onCancel();
    if (name === "r") return onReset();
    if (!selectable) return;
    if (name === "up" || name === "k") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === "down" || name === "j") {
      setIndex((i) => Math.min(entries.length - 1, i + 1));
      return;
    }
    if (ENTER_KEYS.has(name)) {
      const e = entries[index];
      if (e) onSelect(e.id);
      return;
    }
  });

  const labelWidth = entries.length > 0
    ? Math.max(...entries.map((e) => e.label.length))
    : 0;
  const accent = runner === "claude" ? theme.toolBash : theme.toolWeb;
  const statusRow = loading
    ? "loading models from ollama..."
    : error
      ? `ollama unavailable: ${error} — pull a model with \`ollama pull <id>\``
      : entries.length === 0
        ? "no models found — pull one with `ollama pull <id>`"
        : null;

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
      {statusRow ? (
        <box flexDirection="row">
          <text fg={error ? theme.toolEdit : theme.textMuted}>{statusRow}</text>
        </box>
      ) : (
        entries.map((entry, i) => (
          <Row
            key={entry.id}
            entry={entry}
            selected={i === index}
            current={entry.id === currentId}
            labelWidth={labelWidth}
          />
        ))
      )}
      <box flexDirection="row" marginTop={0}>
        <text fg={theme.textFaint}>
          {selectable
            ? "↑↓ navigate   enter select   r reset to default   esc cancel"
            : "r reset to default   esc cancel"}
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
