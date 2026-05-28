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

export function assistantMessageCount(session: Session): number {
  return session.messages.filter((m) => m.role === "assistant").length;
}

// Best-effort pretty label for a model id. Falls back to the id itself if
// unknown so the user always sees *something* identifiable.
export function prettyModelLabel(
  modelId: string | undefined,
  runner: RunnerKind,
): string {
  if (!modelId) {
    if (runner === "claude") return "Claude (default)";
    if (runner === "codex") return "Codex (default)";
    if (runner === "ollama") return "Ollama (auto)";
    return "Vercel (gpt-4o)";
  }
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
    if (id === "gpt-4o") return "GPT-4o";
    if (id === "gpt-4o-mini") return "GPT-4o Mini";
    return modelId;
  }

  return modelId;
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
