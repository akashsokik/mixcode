import { useCallback, useEffect, useMemo, useState } from "react";
import { listCwdFiles } from "../util/files";
import { fuzzyFilter } from "../util/fuzzy";

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
