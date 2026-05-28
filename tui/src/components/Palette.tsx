import { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

export type PaletteAction = {
  key: string;
  label: string;
  destructive?: boolean;
  // Optional direct keystroke that triggers this action from the main palette
  // view, without first opening the action sheet via tab. Destructive
  // shortcuts still require a second press to confirm.
  shortcut?: { ctrl?: boolean; name: string };
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
  // Initial cursor target. Use to land on the currently active session when
  // opening the palette in sessions/global mode. Captured on mount only —
  // arrow keys take over after that.
  initialItemId?: string;
};

export function Palette({ title, placeholder, items, onClose, footer, onCreate, initialItemId }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => {
    if (!initialItemId) return 0;
    const i = items.findIndex((it) => it.id === initialItemId);
    return i >= 0 ? i : 0;
  });
  const [actionSheet, setActionSheet] = useState<PaletteItem | null>(null);
  const [pendingDestructive, setPendingDestructive] = useState<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
    };
  }, []);

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
  const safeIndex = Math.max(0, Math.min(index, filtered.length - 1));

  useKeyboard((key) => {
    if (actionSheet) {
      if (key.name === "escape") {
        if (pendingTimerRef.current !== null) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        setActionSheet(null);
        setPendingDestructive(null);
        return;
      }
      const action = actionSheet.actions?.find((a) => a.key === key.name);
      if (!action) return;
      if (action.destructive) {
        if (pendingDestructive === action.key) {
          if (pendingTimerRef.current !== null) {
            clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = null;
          }
          action.run();
          setActionSheet(null);
          setPendingDestructive(null);
        } else {
          if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
          setPendingDestructive(action.key);
          pendingTimerRef.current = setTimeout(() => {
            setPendingDestructive(null);
            pendingTimerRef.current = null;
          }, 1500);
        }
        return;
      }
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      action.run();
      setActionSheet(null);
      setPendingDestructive(null);
      return;
    }

    if (key.name === "escape") return onClose();
    if (key.name === "up") {
      if (filtered.length === 0) return;
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "down") {
      if (filtered.length === 0) return;
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.name === "tab") {
      const item = filtered[safeIndex];
      if (item?.actions?.length) {
        setActionSheet(item);
        return;
      }
      return; // tab without actions still doesn't reach the input
    }
    if (key.ctrl && key.name === "n" && onCreate) {
      onCreate();
      return;
    }
    const currentItem = filtered[safeIndex];
    const shortcutAction = currentItem?.actions?.find(
      (a) =>
        a.shortcut !== undefined &&
        a.shortcut.name === key.name &&
        !!a.shortcut.ctrl === !!key.ctrl,
    );
    if (shortcutAction) {
      const pendingId = `shortcut:${shortcutAction.key}:${currentItem!.id}`;
      if (shortcutAction.destructive) {
        if (pendingDestructive === pendingId) {
          if (pendingTimerRef.current !== null) {
            clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = null;
          }
          shortcutAction.run();
          setPendingDestructive(null);
        } else {
          if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
          setPendingDestructive(pendingId);
          pendingTimerRef.current = setTimeout(() => {
            setPendingDestructive(null);
            pendingTimerRef.current = null;
          }, 1500);
        }
        return;
      }
      shortcutAction.run();
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
        {renderViewport(filtered, safeIndex)}
        {filtered.length === 0 && <text fg={theme.textFaint}>(no matches)</text>}
      </box>
      {actionSheet && (
        <box
          flexDirection="column"
          borderStyle="single"
          borderColor={actionSheet.actions!.some((a) => a.destructive) ? theme.toolError : theme.accent}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={theme.textMuted}>{`actions: ${actionSheet.label}`}</text>
          {actionSheet.actions!.map((a) => {
            const pending = pendingDestructive === a.key;
            return (
              <text key={a.key} fg={a.destructive ? theme.toolError : theme.textMuted}>
                {`  ${a.key}  ${a.label}${pending ? "  (press again to confirm)" : ""}`}
              </text>
            );
          })}
          <text fg={theme.textFaint}>{"esc back"}</text>
        </box>
      )}
      {!actionSheet && pendingDestructive?.startsWith("shortcut:") && (
        <text fg={theme.toolError}>{"press again to confirm"}</text>
      )}
      {!actionSheet && !pendingDestructive?.startsWith("shortcut:") && (
        <text fg={theme.textFaint}>{footer ?? "↑↓ nav   enter activate   tab actions   esc close"}</text>
      )}
    </box>
  );
}

// Sliding window of rows that keeps the selected item visible. Anchors the
// cursor ~4 rows below the top when room allows, then clamps at both ends so
// long lists scroll past row 9 (the previous hard slice cap) and short lists
// don't leave dead rows at the bottom.
const VIEWPORT_ROWS = 10;
const VIEWPORT_ANCHOR = 4;
function renderViewport(items: PaletteItem[], selected: number) {
  const start = Math.max(
    0,
    Math.min(
      selected - VIEWPORT_ANCHOR,
      Math.max(0, items.length - VIEWPORT_ROWS),
    ),
  );
  const end = Math.min(items.length, start + VIEWPORT_ROWS);
  const rows = [] as ReturnType<typeof Row>[];
  for (let i = start; i < end; i++) {
    rows.push(<Row key={items[i].id} item={items[i]} selected={i === selected} />);
  }
  if (items.length > end) {
    rows.push(
      <text key="__more" fg={theme.textFaint}>
        {`  … ${items.length - end} more`}
      </text>,
    );
  }
  return rows;
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
