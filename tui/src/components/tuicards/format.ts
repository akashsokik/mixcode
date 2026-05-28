// Shared formatters used across every card. Previously each card carried its
// own copy of truncate/formatDuration/runnerColor; consolidating them here is
// the practical "single source of truth" that the TuiCard contract relies on.

import { theme } from "../../theme";
import type { TuiStatus } from "./types";

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m${rem.toString().padStart(2, "0")}s`;
}

export function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

export function runnerColor(runner: string): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  if (runner === "vercel") return theme.runnerVercel;
  if (runner === "ollama") return theme.runnerOllama;
  return theme.textMuted;
}

// Color a status string for the inline pill (the bold word that sits next to
// the └ on the sub-header). Mirrors StatusDot's color choices so the dot and
// the pill always agree.
export function statusColor(status: TuiStatus | string): string {
  if (status === "done" || status === "ok") return theme.runnerClaude;
  if (status === "running") return theme.toolBash;
  if (status === "error" || status === "timeout") return theme.toolError;
  if (status === "cancelled") return theme.textSubtle;
  if (status === "open") return theme.textMuted;
  if (status === "queued" || status === "pending") return theme.textMuted;
  return theme.textMuted;
}
