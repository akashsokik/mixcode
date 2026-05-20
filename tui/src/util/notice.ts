import type { ClaudePermissionMode, Session } from "../../../shared/events.ts";
import { SLASH_COMMANDS } from "./slash";
import { shortPath } from "./path";

export type Notice = {
  id: string;
  command: string;
  lines: string[];
  createdAt: string;
};

let noticeCounter = 0;

export function makeNotice(command: string, lines: string[]): Notice {
  noticeCounter += 1;
  return {
    id: `notice-${Date.now()}-${noticeCounter}`,
    command,
    lines,
    createdAt: new Date().toISOString(),
  };
}

export function helpLines(): string[] {
  const colWidth = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
  const cmds = SLASH_COMMANDS.map(
    (c) => `  ${c.name.padEnd(colWidth, " ")}   ${c.help}`,
  );
  return [
    "slash commands (work with both claude and codex)",
    ...cmds,
    "",
    "keys",
    "  enter        send / focus prompt",
    "  esc          stop streaming turn / close menu",
    "  ctrl-b       toggle browse mode (sidebar)",
    "  j / k        next / prev session (browse)",
    "  n            new session (browse)",
    "  dd           delete active session (browse)",
    "  up / down    prompt history",
    "  @            file completion",
    "  ctrl-c       quit",
    "",
    "permissions",
    "  per-prompt tool approval applies to claude only — codex runs through its own sandbox.",
    "  y allow once   a allow always   n / esc deny",
    "",
    "modes (claude only)",
    "  shift+tab cycles: default → accept edits → plan → bypass → default",
    "  /plan toggles plan ↔ default",
  ];
}

export function contextLines(session: Session | null): string[] {
  if (!session) return ["no active session"];

  const usage = sumUsage(session);
  const turns = session.messages.length;
  const userTurns = session.messages.filter((m) => m.role === "user").length;
  const created = new Date(session.createdAt).toLocaleString();

  return [
    `title       ${session.title}`,
    `id          ${session.id.slice(0, 12)}`,
    `runner      ${session.activeRunner}`,
    `cwd         ${shortPath(session.cwd)}`,
    `messages    ${turns} (${userTurns} user / ${turns - userTurns} assistant)`,
    `tokens in   ${formatNumber(usage.input)}`,
    `tokens out  ${formatNumber(usage.output)}`,
    `cache read  ${formatNumber(usage.cacheRead)}`,
    `cache write ${formatNumber(usage.cacheWrite)}`,
    `created     ${created}`,
    `streaming   ${session.streaming ? "yes" : "no"}`,
  ];
}

function sumUsage(session: Session): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const m of session.messages) {
    for (const ev of m.events) {
      if (ev.type === "usage") {
        input += ev.input;
        output += ev.output;
        cacheRead += ev.cacheRead;
        cacheWrite += ev.cacheWrite;
      }
    }
  }
  return { input, output, cacheRead, cacheWrite };
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, "") + "M";
}

export function planLines(session: Session | null, headline?: string): string[] {
  const mode = session?.claudeMode ?? "default";
  const enabled = mode === "plan";
  const header = headline ? [headline, ""] : [];
  return [
    ...header,
    `claude mode   ${claudeModeLabel(mode)}`,
    enabled
      ? "in plan mode Claude proposes a plan and does not execute tools."
      : "Claude runs normally — tool calls follow the current mode.",
    "",
    "usage",
    "  /plan          toggle plan ↔ default",
    "  /plan on       set plan",
    "  /plan off      set default",
    "  /plan status   show current state",
    "",
    "shift+tab from the prompt cycles modes: default → accept edits → plan → bypass → …",
    "scope: Claude only — Codex has no equivalent mode and ignores this flag.",
  ];
}

export function claudeModeLabel(mode: ClaudePermissionMode): string {
  switch (mode) {
    case "default":
      return "default";
    case "acceptEdits":
      return "accept edits";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "bypass permissions";
  }
}

export function modelLines(
  session: Session | null,
  headline?: string,
): string[] {
  const header = headline ? [headline, ""] : [];
  const claudeModel = session?.models?.claude ?? "(default)";
  const codexModel = session?.models?.codex ?? "(default)";
  return [
    ...header,
    `claude   ${claudeModel}`,
    `codex    ${codexModel}`,
    "",
    "usage",
    "  /model                     show current models",
    "  /model <name>              set for the active runner",
    "  /model claude <name>       set for claude",
    "  /model codex <name>        set for codex",
    "  /model reset               clear the active runner's override",
    "  /model claude reset        clear claude's override",
    "  /model codex reset         clear codex's override",
    "",
    "common claude models   claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001",
    "common codex models    gpt-5-codex, gpt-5, gpt-5-mini",
  ];
}

export function permissionsLines(rules: string[], action?: string): string[] {
  const header = action ? [action, ""] : [];
  const usage = [
    "",
    "usage",
    "  /permissions                list current rules",
    "  /permissions add <rule>     add a rule",
    "  /permissions remove <rule>  remove a rule",
    "  /permissions clear          remove all rules",
    "",
    "rule format",
    "  Bash(npm install:*)   wrapper form (any tool, optional content)",
    "  npm install:*         shorthand — auto-wrapped to Bash(...)",
    "  Read                  bare tool name allows all uses of that tool",
    "",
    "scope: per-prompt gating is Claude only — Codex runs through its own sandbox.",
  ];
  if (rules.length === 0) {
    return [...header, "no rules configured.", ...usage];
  }
  return [
    ...header,
    `rules (${rules.length})`,
    ...rules.map((r) => `  ${r}`),
    ...usage,
  ];
}
