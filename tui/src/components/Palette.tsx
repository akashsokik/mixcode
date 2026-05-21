import { useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

export type PaletteAction = {
  key: string;
  label: string;
  destructive?: boolean;
  run: () => void;
};

export type PaletteItem = {
  id: string;
  label: string;
  detail?: string;
  badge?: { text: string; color: string };
  streaming?: boolean;
  actions?: PaletteAction[];
  onActivate: () => void;
};

type Props = {
  title: string;
  placeholder: string;
  items: PaletteItem[];
  onClose: () => void;
  footer?: string;
  onCreate?: () => void; // ctrl+n — sessions mode only
};

export function Palette({ title, placeholder, items, onClose, footer, onCreate }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    // Two items can produce identical haystacks (same title + cwd); ranking by
    // haystack-string lookup would let the later one clobber the earlier's
    // rank. Key the rank table by item index instead.
    const haystacks = items.map((i) => `${i.badge?.text ?? ""} ${i.label} ${i.detail ?? ""}`);
    const results = fuzzysort.go(query, haystacks, { threshold: -10000, all: false });
    const rankByIndex = new Map<number, number>();
    results.forEach((r, rank) => {
      const idx = haystacks.indexOf(r.target);
      if (idx !== -1 && !rankByIndex.has(idx)) rankByIndex.set(idx, rank);
    });
    return items
      .map((item, i) => ({ item, rank: rankByIndex.get(i) }))
      .filter((x) => x.rank !== undefined)
      .sort((a, b) => (a.rank as number) - (b.rank as number))
      .map((x) => x.item);
  }, [items, query]);

  // Clamp index when filtered shrinks below it.
  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useKeyboard((key) => {
    if (key.name === "escape") return onClose();
    if (key.name === "up") {
      setIndex(() => Math.max(0, safeIndex - 1));
      return;
    }
    if (key.name === "down") {
      setIndex(() => Math.min(filtered.length - 1, safeIndex + 1));
      return;
    }
    if (key.ctrl && key.name === "n" && onCreate) {
      onCreate();
      return;
    }
    if (ENTER_KEYS.has(key.name ?? "")) {
      const item = filtered[safeIndex];
      if (item) item.onActivate();
      return;
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>{title}</text>
      <box flexDirection="row" height={1}>
        <text fg={theme.textSubtle}>{"› "}</text>
        <input value={query} onInput={setQuery} placeholder={placeholder} focused flexGrow={1} />
      </box>
      <box flexDirection="column" flexShrink={0}>
        {filtered.slice(0, 10).map((item, i) => (
          <Row key={item.id} item={item} selected={i === safeIndex} />
        ))}
        {filtered.length === 0 && <text fg={theme.textFaint}>(no matches)</text>}
      </box>
      <text fg={theme.textFaint}>{footer ?? "↑↓ nav   enter activate   esc close"}</text>
    </box>
  );
}

function Row({ item, selected }: { item: PaletteItem; selected: boolean }) {
  const marker = selected ? "›" : " ";
  return (
    <box flexDirection="row">
      <text fg={selected ? theme.accent : theme.textFaint}>{`${marker} `}</text>
      {item.badge && <text fg={item.badge.color}>{`${item.badge.text.padEnd(8, " ")} `}</text>}
      <text fg={selected ? theme.text : theme.textMuted} attributes={selected ? TextAttributes.BOLD : 0}>
        {item.label}
      </text>
      {item.streaming && <text fg={theme.toolError}>{" ●"}</text>}
      {item.detail && <text fg={theme.textFaint}>{`   ${item.detail}`}</text>}
    </box>
  );
}
