import type { ClaudePermissionMode, RunnerKind, Session } from "../../../shared/events.ts";
import { SLASH_COMMANDS } from "./slash";
import { basename, shortPath } from "./path";
import type { SkillEntry, SkillFrontmatter } from "./skills";

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
    "  enter        send",
    "  esc          stop streaming turn / close menu",
    "  ctrl-k       open command palette (sessions, skills, mcp, commands)",
    "  /sessions    open session switcher",
    "  /skills      open skills picker for the active runner",
    "  /mcp         open mcp picker for the active runner",
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

export function sessionsLines(
  sessions: Session[],
  activeId: string | null,
): string[] {
  if (sessions.length === 0) return ["no sessions"];
  const titleWidth = Math.min(
    32,
    Math.max(...sessions.map((s) => s.title.length)),
  );
  const cwdWidth = Math.min(
    20,
    Math.max(...sessions.map((s) => basename(s.cwd).length || 1)),
  );
  const rows = sessions.map((s) => {
    const marker = s.id === activeId ? "▸" : " ";
    const stream = s.streaming ? "●" : " ";
    const runner = s.activeRunner.padEnd(6, " ");
    const title = clip(s.title, titleWidth).padEnd(titleWidth, " ");
    const cwd = clip(basename(s.cwd) || "~", cwdWidth).padEnd(cwdWidth, " ");
    const msgs = `${s.messages.length} msg`;
    return `${marker} ${stream} ${runner}  ${title}  ${cwd}  ${msgs}  ${s.id.slice(0, 8)}`;
  });
  return [
    `sessions (${sessions.length}) — ▸ active, ● streaming`,
    "",
    ...rows,
    "",
    "browse mode: ctrl-b to enter, j/k to move, n new, dd delete",
  ];
}

function clip(s: string, n: number): string {
  if (n <= 1) return s.slice(0, n);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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
  // The Anthropic SDK emits several usage events per assistant turn: a
  // message_start with real input_tokens but placeholder output_tokens=1,
  // streaming partials, and a final result event. Each later event reports
  // cumulative-within-the-turn counts (often with input_tokens=0 on the
  // tail). Summing them all triple-counts; take the per-field max within
  // each message, then sum across messages.
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const m of session.messages) {
    let mIn = 0;
    let mOut = 0;
    let mCacheR = 0;
    let mCacheW = 0;
    for (const ev of m.events) {
      if (ev.type === "usage") {
        if (ev.input > mIn) mIn = ev.input;
        if (ev.output > mOut) mOut = ev.output;
        if (ev.cacheRead > mCacheR) mCacheR = ev.cacheRead;
        if (ev.cacheWrite > mCacheW) mCacheW = ev.cacheWrite;
      }
    }
    input += mIn;
    output += mOut;
    cacheRead += mCacheR;
    cacheWrite += mCacheW;
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
  const vercelModel = session?.models?.vercel ?? "(default → gpt-4o)";
  return [
    ...header,
    `claude   ${claudeModel}`,
    `codex    ${codexModel}`,
    `vercel   ${vercelModel}`,
    "",
    "usage",
    "  /model                     show current models",
    "  /model <name>              set for the active runner",
    "  /model claude <name>       set for claude",
    "  /model codex <name>        set for codex",
    "  /model vercel <name>       set for vercel",
    "  /model reset               clear the active runner's override",
    "  /model claude reset        clear claude's override",
    "  /model codex reset         clear codex's override",
    "  /model vercel reset        clear vercel's override",
    "",
    "common claude models   claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001",
    "common codex models    gpt-5-codex, gpt-5, gpt-5-mini",
    "common vercel models   claude-opus-4-7, claude-sonnet-4-6, gpt-5, gpt-5-mini, gpt-4o",
    "                       (claude-* routes via @ai-sdk/anthropic, gpt-*/o*-* via @ai-sdk/openai)",
  ];
}

export function skillsLines(
  runner: RunnerKind,
  entries: SkillEntry[],
  headline?: string,
): string[] {
  const header = headline ? [headline, ""] : [];
  const other: RunnerKind = runner === "claude" ? "codex" : "claude";
  const usage = [
    "",
    "usage",
    "  /skills                              list skills for the active runner",
    "  /skills add <path>                   symlink a skill directory into the runner's skills dir",
    `  /skills import ${other.padEnd(7, " ")} [name]      copy a skill (or all skills) from the other runner`,
    "  /skills remove <name>                remove an installed skill (symlinks only — refuses real dirs)",
    "  /skills info <name>                  show the skill's frontmatter",
    "",
    `scope: ${runner} only. switch runners with /claude or /codex.`,
    `only user-installed skills under ~/.${runner}/skills are shown. plugin-bundled skills`,
    `(e.g. commit-commands:commit, superpowers:brainstorming) live under ~/.${runner}/plugins/`,
    "and aren't managed here.",
  ];
  if (entries.length === 0) {
    return [...header, `no skills installed for ${runner}.`, ...usage];
  }
  const nameWidth = Math.max(...entries.map((e) => e.name.length));
  const rows = entries.map((e) => {
    const flag = e.isSymlink ? (e.source ? "→" : "✗") : " ";
    const detail = e.isSymlink
      ? e.source
        ? shortPath(e.source)
        : "(broken link)"
      : "(real dir)";
    const desc = e.description ? `  ${clip(e.description, 60)}` : "";
    return `  ${flag} ${e.name.padEnd(nameWidth, " ")}   ${detail}${desc}`;
  });
  return [
    ...header,
    `${runner} skills (${entries.length}) — → symlink, ✗ broken`,
    ...rows,
    ...usage,
  ];
}

export function skillInfoLines(
  runner: RunnerKind,
  name: string,
  fm: SkillFrontmatter | null,
): string[] {
  if (!fm) return [`no such skill or unreadable SKILL.md: ${runner}/${name}`];
  const lines = [
    `${runner} skill: ${name}`,
    "",
    `name         ${fm.name ?? name}`,
    `description  ${fm.description ?? "(none)"}`,
  ];
  for (const [k, v] of Object.entries(fm.extra)) {
    lines.push(`${k.padEnd(12, " ")} ${v}`);
  }
  return lines;
}

export function mcpListLines(
  runner: RunnerKind,
  cliStdout: string,
  cliStderr: string,
  ok: boolean,
  errorReason?: string,
): string[] {
  const usage = [
    "",
    "usage",
    "  /mcp                            list MCP servers for the active runner",
    "  /mcp add <name> <cmd> [args]    register a stdio MCP server",
    "  /mcp remove <name>              drop a server",
    "  /mcp test <name>                spawn the configured server briefly to verify",
    "",
    `backed by '${runner} mcp ...' — full features (HTTP transport, headers, env, scopes) live in the CLI.`,
  ];
  const body = ok ? cliStdout.trimEnd().split(/\r?\n/) : [];
  if (!ok) {
    return [
      `${runner} mcp list failed${errorReason ? `: ${errorReason}` : ""}`,
      ...cliStderr.trimEnd().split(/\r?\n/).filter(Boolean),
      ...usage,
    ];
  }
  if (body.length === 0 || (body.length === 1 && body[0] === "")) {
    return [`no MCP servers configured for ${runner}.`, ...usage];
  }
  return [`${runner} mcp servers`, "", ...body, ...usage];
}

export function mcpActionLines(
  runner: RunnerKind,
  verb: string,
  name: string,
  outcome: { ok: boolean; stdout: string; stderr: string; errorReason?: string },
): string[] {
  const headline = outcome.ok
    ? `${runner} mcp ${verb}: ${name}`
    : `${runner} mcp ${verb} failed: ${name}${outcome.errorReason ? ` (${outcome.errorReason})` : ""}`;
  const merged = [outcome.stdout, outcome.stderr]
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .join("\n");
  return [headline, ...(merged ? ["", ...merged.split(/\r?\n/)] : [])];
}

export function mcpTestLines(
  runner: RunnerKind,
  name: string,
  result: { ok: boolean; summary: string; stderrTail: string; command?: string },
): string[] {
  const headline = result.ok
    ? `${runner} mcp test: ${name} — ${result.summary}`
    : `${runner} mcp test failed: ${name} — ${result.summary}`;
  const body: string[] = [];
  if (result.command) body.push("", `spawned: ${result.command}`);
  if (result.stderrTail) body.push("", "stderr (tail):", ...result.stderrTail.split(/\r?\n/));
  return [headline, ...body];
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
