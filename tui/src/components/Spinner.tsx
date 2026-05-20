import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../shared/events.ts";
import { theme } from "../theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS = [
  "Cooking",
  "Thinking",
  "Brewing",
  "Pondering",
  "Plotting",
  "Conjuring",
  "Crunching",
  "Hatching",
  "Scheming",
  "Tinkering",
  "Mulling",
  "Wrangling",
  "Noodling",
  "Spelunking",
  "Whirlpooling",
];

function pickWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

type Stats = {
  elapsed: number;
  thoughtFor: number | null;
  tokens: number;
};

function useStreamingStats(active: Session | null): Stats | null {
  const last = active?.messages[active.messages.length - 1];
  const streaming = !!active?.streaming && last?.role === "assistant";
  const messageId = streaming ? last?.id ?? null : null;
  const hasText = streaming ? (last?.text.length ?? 0) > 0 : false;

  const startedRef = useRef<{
    messageId: string;
    at: number;
    firstTokenAt?: number;
  } | null>(null);

  if (streaming && messageId && startedRef.current?.messageId !== messageId) {
    startedRef.current = { messageId, at: Date.now() };
  }
  if (streaming && startedRef.current && !startedRef.current.firstTokenAt && hasText) {
    startedRef.current.firstTokenAt = Date.now();
  }
  if (!streaming) startedRef.current = null;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [streaming]);

  if (!streaming || !startedRef.current || !last) return null;

  const elapsed = Math.max(0, Math.floor((now - startedRef.current.at) / 1000));
  const thoughtFor = startedRef.current.firstTokenAt
    ? Math.max(0, Math.floor((startedRef.current.firstTokenAt - startedRef.current.at) / 1000))
    : null;

  let tokens = 0;
  for (let i = last.events.length - 1; i >= 0; i--) {
    const e = last.events[i];
    if (e.type === "usage") {
      tokens = e.output;
      break;
    }
  }

  return { elapsed, thoughtFor, tokens };
}

export function Spinner({ active }: { active: Session | null }) {
  const stats = useStreamingStats(active);
  const isActive = stats !== null;
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(pickWord());

  useEffect(() => {
    if (!isActive) return;
    setWord(pickWord());
    setFrame(0);
    const tick = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    const rotate = setInterval(() => setWord(pickWord()), 4000);
    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, [isActive]);

  if (!isActive || !stats) return <box height={1} flexShrink={0} />;

  const parts: string[] = [`${stats.elapsed}s`];
  if (stats.tokens > 0) parts.push(`↑ ${formatTokens(stats.tokens)} tokens`);
  if (stats.thoughtFor != null) parts.push(`thought for ${stats.thoughtFor}s`);
  const meta = ` (${parts.join(" · ")})`;

  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={2}>
      <text fg={theme.text}>{FRAMES[frame]}</text>
      <text fg={theme.textMuted}>{` ${word}…`}</text>
      <text fg={theme.textFaint}>{meta}</text>
    </box>
  );
}
