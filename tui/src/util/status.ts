import { basename } from "./path";
import type { RunnerKind, Session } from "../../../shared/events.ts";

// Pretty-print a token count. 0–999 → as-is; 1k–999.9k → "12.3k"; >=1M → "1.23M".
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Tokens consumed by the most recent assistant turn — input + cache_read +
// cache_write. This is what's loaded into Claude's context window for the
// next turn, so it's the right denominator for a "context used" %.
export function latestContextTokens(session: Session): number {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    for (let j = m.events.length - 1; j >= 0; j--) {
      const ev = m.events[j];
      if (ev.type === "usage") {
        return ev.input + ev.cacheRead + ev.cacheWrite;
      }
    }
  }
  return 0;
}

export function assistantMessageCount(session: Session): number {
  return session.messages.filter((m) => m.role === "assistant").length;
}

// Best-effort pretty label for a model id. Falls back to the id itself if
// unknown so the user always sees *something* identifiable.
export function prettyModelLabel(
  modelId: string | undefined,
  runner: RunnerKind,
): string {
  if (!modelId) return runner === "claude" ? "Claude (default)" : "Codex (default)";
  const id = modelId.toLowerCase();

  if (id.startsWith("claude-")) {
    const family = id.includes("opus")
      ? "Opus"
      : id.includes("sonnet")
        ? "Sonnet"
        : id.includes("haiku")
          ? "Haiku"
          : "Claude";
    const versionMatch = id.match(/(\d+)[.-](\d+)/);
    const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : "";
    const oneMillion = id.includes("1m") || id.includes("[1m]");
    return [family, version, oneMillion ? "(1M context)" : ""]
      .filter(Boolean)
      .join(" ");
  }

  if (id.startsWith("gpt-")) {
    if (id === "gpt-5-codex") return "GPT-5 Codex";
    if (id === "gpt-5-mini") return "GPT-5 Mini";
    if (id === "gpt-5") return "GPT-5";
    return modelId;
  }

  return modelId;
}

// Approximate context-window size for the model. Unknown IDs fall back to
// 200k (Claude default, also a sane GPT lower bound).
export function contextLimit(
  modelId: string | undefined,
  runner: RunnerKind,
): number {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("1m") || id.includes("[1m]")) return 1_000_000;
  if (id.startsWith("gpt-5")) return 400_000;
  if (runner === "claude") return 200_000;
  return 200_000;
}

// Render a fixed-width progress bar. width = total cells, ratio in [0, 1].
export function progressBar(ratio: number, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const filled = Math.max(0, Math.min(w, Math.round(ratio * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

export function projectName(cwd: string): string {
  const b = basename(cwd);
  return b || cwd;
}
