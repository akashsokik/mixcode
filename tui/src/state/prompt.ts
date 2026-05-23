import { useCallback, useEffect, useMemo, useState } from "react";
import { listCwdFiles } from "../util/files";
import { fuzzyFilter } from "../util/fuzzy";
import { SLASH_COMMANDS } from "../util/slash";

export type HistoryNav = {
  value: string | null;
  movePrev: () => void;
  moveNext: () => void;
  reset: () => void;
  push: (line: string) => void;
};

const MAX_HISTORY = 200;

export function useHistory(): HistoryNav {
  const [items, setItems] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);

  const push = useCallback((line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    setItems((prev) => {
      const without = prev.filter((p) => p !== trimmed);
      const next = [...without, trimmed];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setCursor(null);
  }, []);

  const movePrev = useCallback(() => {
    setCursor((c) => {
      if (items.length === 0) return null;
      if (c == null) return items.length - 1;
      return Math.max(0, c - 1);
    });
  }, [items.length]);

  const moveNext = useCallback(() => {
    setCursor((c) => {
      if (c == null) return null;
      const n = c + 1;
      return n >= items.length ? null : n;
    });
  }, [items.length]);

  const reset = useCallback(() => setCursor(null), []);

  const value = cursor == null ? null : items[cursor] ?? null;
  return { value, movePrev, moveNext, reset, push };
}

export type SlashSuggestion = { name: string; help: string };

export type SlashCompletions = {
  active: boolean;
  query: string;
  matches: SlashSuggestion[];
  selectedIndex: number;
  selected: SlashSuggestion | null;
  open: (query: string) => void;
  setQuery: (query: string) => void;
  moveDown: () => void;
  moveUp: () => void;
  close: () => void;
};

const SLASH_ITEMS: SlashSuggestion[] = SLASH_COMMANDS.map((c) => ({
  name: c.name.split(/\s+/)[0],
  help: c.help,
}));

// `extras` is the dynamic tail (typically skills surfaced from the active
// session) appended to the static SLASH_ITEMS. Duplicates by name are dropped
// in favor of the static entry so first-class commands always win.
export function useSlashCompletions(extras: SlashSuggestion[] = []): SlashCompletions {
  const [active, setActive] = useState(false);
  const [query, setQueryRaw] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allItems = useMemo<SlashSuggestion[]>(() => {
    if (extras.length === 0) return SLASH_ITEMS;
    const taken = new Set(SLASH_ITEMS.map((c) => c.name));
    const tail = extras.filter((e) => !taken.has(e.name));
    return [...SLASH_ITEMS, ...tail];
  }, [extras]);

  const matches = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return allItems;
    const prefixed = allItems.filter((c) =>
      c.name.slice(1).toLowerCase().startsWith(q),
    );
    if (prefixed.length > 0) return prefixed;
    return allItems.filter((c) => c.name.slice(1).toLowerCase().includes(q));
  }, [allItems, query]);

  const safeIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

  return {
    active,
    query,
    matches,
    selectedIndex: safeIndex,
    selected: matches[safeIndex] ?? null,
    open(q: string) {
      setActive(true);
      setQueryRaw(q);
      setSelectedIndex(0);
    },
    setQuery(q: string) {
      setQueryRaw(q);
      setSelectedIndex(0);
    },
    moveDown() {
      setSelectedIndex((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
    },
    moveUp() {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    },
    close() {
      setActive(false);
      setQueryRaw("");
      setSelectedIndex(0);
    },
  };
}

export type Completions = {
  active: boolean;
  query: string;
  matches: string[];
  selectedIndex: number;
  open: (query: string) => void;
  setQuery: (query: string) => void;
  moveDown: () => void;
  moveUp: () => void;
  close: () => void;
  selected: string | null;
};

export function useCompletions(): Completions {
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState(false);
  const [query, setQueryRaw] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listCwdFiles().then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => fuzzyFilter(files, query, 8), [files, query]);

  return {
    active,
    query,
    matches,
    selectedIndex: Math.min(selectedIndex, Math.max(matches.length - 1, 0)),
    selected: matches[Math.min(selectedIndex, matches.length - 1)] ?? null,
    open(q: string) {
      setActive(true);
      setQueryRaw(q);
      setSelectedIndex(0);
    },
    setQuery(q: string) {
      setQueryRaw(q);
      setSelectedIndex(0);
    },
    moveDown() {
      setSelectedIndex((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
    },
    moveUp() {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    },
    close() {
      setActive(false);
      setQueryRaw("");
      setSelectedIndex(0);
    },
  };
}
