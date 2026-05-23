import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../shared/events.ts";
import { theme } from "../theme";
import { formatTokens } from "../util/status";

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

type Stats = {
  elapsed: number;
  thoughtFor: number | null;
  sent: number;
  received: number;
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

  // The Anthropic streaming protocol emits multiple usage events per turn:
  // message_start carries the real input_tokens with output_tokens=1 (a
  // placeholder), and later message_delta/result events carry the real
  // output_tokens but may report input_tokens as 0. Taking the per-field max
  // recovers the latest accurate counts regardless of arrival order.
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const e of last.events) {
    if (e.type === "usage") {
      if (e.input > input) input = e.input;
      if (e.output > output) output = e.output;
      if (e.cacheRead > cacheRead) cacheRead = e.cacheRead;
      if (e.cacheWrite > cacheWrite) cacheWrite = e.cacheWrite;
    }
  }
  const sent = input + cacheRead + cacheWrite;
  const received = output;

  return { elapsed, thoughtFor, sent, received };
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
  if (stats.sent > 0 || stats.received > 0) {
    const tok: string[] = [];
    if (stats.sent > 0) tok.push(`↑ ${formatTokens(stats.sent)}`);
    if (stats.received > 0) tok.push(`↓ ${formatTokens(stats.received)}`);
    parts.push(tok.join(" "));
  }
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
