import type { RunnerKind } from "../../../shared/events.ts";

export type SlashCommand =
  | { type: "claude"; rest: string }
  | { type: "codex"; rest: string }
  | { type: "switch"; rest: string };

export function parseSlash(text: string): SlashCommand | null {
  const m = text.match(/^\/(\w+)(?:\s+(.*))?$/s);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (cmd === "claude") return { type: "claude", rest };
  if (cmd === "codex") return { type: "codex", rest };
  if (cmd === "switch") return { type: "switch", rest };
  return null;
}

export function toggleRunner(current: RunnerKind): RunnerKind {
  return current === "claude" ? "codex" : "claude";
}
