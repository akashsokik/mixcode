import type { EffortLevel, RunnerKind } from "../../../shared/events.ts";
import { isEffortLevel } from "../../../shared/effort.ts";

export type PermissionsAction =
  | { kind: "list" }
  | { kind: "add"; rule: string }
  | { kind: "remove"; rule: string }
  | { kind: "clear" };

// /model action grammar:
//   list (no args)                — show current models for both runners
//   set <name>                    — set for the active runner
//   setRunner <runner> <name>     — set for a specific runner
//   reset                          — clear the active runner's override
//   resetRunner <runner>          — clear a specific runner's override
export type ModelAction =
  | { kind: "picker" } // open the interactive model picker for active runner
  | { kind: "show" }   // print a notice listing current models for both runners
  | { kind: "set"; model: string }
  | { kind: "setRunner"; runner: RunnerKind; model: string }
  | { kind: "reset" }
  | { kind: "resetRunner"; runner: RunnerKind };

// /effort grammar mirrors /model:
//   (no args)                  — open the interactive slider for the active runner
//   show | status | list       — print current efforts for all runners
//   <level>                     — set the active runner's effort
//   <runner> <level>            — set a specific runner's effort
//   reset | clear               — clear the active runner's override
//   <runner> [reset|clear]      — clear a specific runner's override
export type EffortAction =
  | { kind: "picker" }
  | { kind: "show" }
  | { kind: "set"; effort: EffortLevel }
  | { kind: "setRunner"; runner: RunnerKind; effort: EffortLevel }
  | { kind: "reset" }
  | { kind: "resetRunner"; runner: RunnerKind };

// /plan grammar:
//   (no args) — toggle plan mode for the active session
//   on/off/status — explicit
export type PlanAction =
  | { kind: "toggle" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "status" };

// /skills grammar:
//   (no args) | list                  — list installed skills for the active runner
//   add <path>                         — symlink a skill directory into the runner's
//                                        skills dir
//   import <runner> [name]             — symlink a skill (or all skills) from
//                                        another runner's skills dir into the
//                                        active runner's. Source is one of
//                                        claude | codex. Omitting <name>
//                                        imports everything user-installable.
//   remove <name>                      — unlink an installed skill (symlinks only)
//   info <name>                        — print the skill's SKILL.md frontmatter
export type SkillsAction =
  | { kind: "list" }
  | { kind: "add"; path: string }
  | { kind: "import"; source: RunnerKind | null; name: string | null }
  | { kind: "remove"; name: string }
  | { kind: "info"; name: string };

// /mcp grammar:
//   (no args) | list           — show MCP servers for the active runner
//   add <name> <cmd> [args...]  — register a stdio MCP server
//   remove <name>               — drop a server
//   test <name>                 — spawn the configured server briefly to
//                                 verify it starts cleanly
export type McpAction =
  | { kind: "list" }
  | { kind: "add"; name: string; command: string; args: string[] }
  | { kind: "remove"; name: string }
  | { kind: "test"; name: string };

// /new grammar:
//   (no args)            — create a new session with default title and active runner
//   <title>              — create with custom title, active runner
//   <title> <runner>     — create with custom title and runner (claude|codex|vercel)
export type NewAction = {
  title: string | null;
  runner: RunnerKind | null;
};

export type SlashCommand =
  | { type: "claude"; rest: string }
  | { type: "codex"; rest: string }
  | { type: "vercel"; rest: string }
  | { type: "ollama"; rest: string }
  | { type: "switch"; rest: string }
  | { type: "clear"; rest: string }
  | { type: "help"; rest: string }
  | { type: "context"; rest: string }
  | { type: "sessions"; rest: string }
  | { type: "tree"; rest: string }
  | {
      type: "consensus";
      task: string;
      maxTurnsPerPeer?: number;
      producer?: RunnerKind;
    }
  | { type: "permissions"; action: PermissionsAction }
  | { type: "model"; action: ModelAction }
  | { type: "effort"; action: EffortAction }
  | { type: "plan"; action: PlanAction }
  | { type: "skills"; action: SkillsAction }
  | { type: "mcp"; action: McpAction }
  | { type: "new"; action: NewAction }
  | { type: "unknown"; name: string; rest: string };

// Allow letters, digits, hyphens, dots, underscores, and colons so
// plugin-qualified skill names (`/superpowers:brainstorming`) and hyphenated
// names (`/use-railway`) parse as a single command instead of falling out of
// the regex entirely.
const SLASH_COMMAND_NAME = /^\/([A-Za-z0-9][A-Za-z0-9:_.-]*)(?:\s+(.*))?$/s;

export function parseSlash(text: string): SlashCommand | null {
  const m = text.match(SLASH_COMMAND_NAME);
  if (!m) return null;
  const rawName = m[1];
  const cmd = rawName.toLowerCase();
  const rest = (m[2] ?? "").trim();
  switch (cmd) {
    case "claude":
      return { type: "claude", rest };
    case "codex":
      return { type: "codex", rest };
    case "vercel":
      return { type: "vercel", rest };
    case "ollama":
      return { type: "ollama", rest };
    case "switch":
      return { type: "switch", rest };
    case "clear":
      return { type: "clear", rest };
    case "help":
    case "?":
      return { type: "help", rest };
    case "context":
    case "info":
      return { type: "context", rest };
    case "sessions":
    case "list":
      return { type: "sessions", rest };
    case "tree":
    case "ls":
      return { type: "tree", rest };
    case "consensus":
    case "adversarial":
      return parseConsensus(rest);
    case "permissions":
    case "perms":
      return { type: "permissions", action: parsePermissionsAction(rest) };
    case "model":
      return { type: "model", action: parseModelAction(rest) };
    case "effort":
      return { type: "effort", action: parseEffortAction(rest) };
    case "plan":
      return { type: "plan", action: parsePlanAction(rest) };
    case "skills":
    case "skill":
      return { type: "skills", action: parseSkillsAction(rest) };
    case "mcp":
      return { type: "mcp", action: parseMcpAction(rest) };
    case "new":
      return { type: "new", action: parseNewAction(rest) };
    default:
      // `name` preserves the user-typed case so callers can match it against
      // case-sensitive lists (e.g. plugin-qualified skill names).
      return { type: "unknown", name: rawName, rest };
  }
}

function parseSkillsAction(rest: string): SkillsAction {
  if (!rest) return { kind: "list" };
  const [verb, ...tail] = rest.split(/\s+/);
  const value = tail.join(" ").trim();
  switch (verb.toLowerCase()) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "add":
    case "install":
    case "link":
      return { kind: "add", path: value };
    case "import":
    case "copy":
    case "from": {
      const tokens = value.split(/\s+/).filter(Boolean);
      const first = tokens[0]?.toLowerCase();
      let src: RunnerKind | null = null;
      if (first === "claude" || first === "codex" || first === "vercel") {
        src = first;
      }
      const name = (src ? tokens.slice(1) : tokens).join(" ").trim();
      return { kind: "import", source: src, name: name || null };
    }
    case "remove":
    case "rm":
    case "delete":
    case "uninstall":
      return { kind: "remove", name: value };
    case "info":
    case "show":
    case "describe":
      return { kind: "info", name: value };
    default:
      return { kind: "list" };
  }
}

// /mcp uses a shell-style split so command args survive intact. We don't
// support quoted strings yet — if a user needs spaces in an arg, they can
// invoke the underlying CLI directly.
function parseMcpAction(rest: string): McpAction {
  if (!rest) return { kind: "list" };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const verb = tokens[0]?.toLowerCase() ?? "";
  switch (verb) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "remove":
    case "rm":
    case "delete":
      return { kind: "remove", name: tokens[1] ?? "" };
    case "test":
    case "ping":
      return { kind: "test", name: tokens[1] ?? "" };
    case "add": {
      const name = tokens[1] ?? "";
      const command = tokens[2] ?? "";
      const args = tokens.slice(3);
      return { kind: "add", name, command, args };
    }
    default:
      return { kind: "list" };
  }
}

function parseNewAction(rest: string): NewAction {
  if (!rest) return { title: null, runner: null };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const title = tokens[0] ?? null;
  const runnerStr = tokens[1]?.toLowerCase();
  let runner: RunnerKind | null = null;
  if (
    runnerStr === "claude" ||
    runnerStr === "codex" ||
    runnerStr === "vercel" ||
    runnerStr === "ollama"
  ) {
    runner = runnerStr;
  }
  return { title, runner };
}

function parsePlanAction(rest: string): PlanAction {
  const v = rest.trim().toLowerCase();
  if (!v) return { kind: "toggle" };
  if (v === "on" || v === "enable") return { kind: "on" };
  if (v === "off" || v === "disable") return { kind: "off" };
  if (v === "status") return { kind: "status" };
  return { kind: "toggle" };
}

function parseModelAction(rest: string): ModelAction {
  if (!rest) return { kind: "picker" };
  const tokens = rest.split(/\s+/);
  const first = tokens[0].toLowerCase();
  if (first === "show" || first === "status" || first === "list") {
    return { kind: "show" };
  }
  if (first === "reset" || first === "clear") {
    return { kind: "reset" };
  }
  if (
    first === "claude" ||
    first === "codex" ||
    first === "vercel" ||
    first === "ollama"
  ) {
    const tail = tokens.slice(1).join(" ").trim();
    if (!tail || tail.toLowerCase() === "reset" || tail.toLowerCase() === "clear") {
      return { kind: "resetRunner", runner: first };
    }
    return { kind: "setRunner", runner: first, model: tail };
  }
  return { kind: "set", model: rest.trim() };
}

function parseEffortAction(rest: string): EffortAction {
  if (!rest) return { kind: "picker" };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const first = tokens[0].toLowerCase();
  if (first === "show" || first === "status" || first === "list") {
    return { kind: "show" };
  }
  if (first === "reset" || first === "clear") {
    return { kind: "reset" };
  }
  if (
    first === "claude" ||
    first === "codex" ||
    first === "vercel" ||
    first === "ollama"
  ) {
    const tail = (tokens[1] ?? "").toLowerCase();
    if (!tail || tail === "reset" || tail === "clear") {
      return { kind: "resetRunner", runner: first };
    }
    if (isEffortLevel(tail)) {
      return { kind: "setRunner", runner: first, effort: tail };
    }
    return { kind: "show" };
  }
  if (isEffortLevel(first)) {
    return { kind: "set", effort: first };
  }
  // Unknown token -> show current state rather than silently setting garbage.
  return { kind: "show" };
}

// /consensus grammar:
//   /consensus <task>
//   /consensus [max=N] [producer=claude|codex] <task>
// Flags are space-separated, appear in any order, must come before the
// task text. Unknown / malformed flags are silently dropped (the bare task
// form still works). There is no rounds flag — /consensus is a single
// actor/critic cycle (producer writes once, critic reviews once).
const CONSENSUS_FLAG = /^(max|producer)=([\w-]+)\s+/i;

function parseConsensus(rest: string): {
  type: "consensus";
  task: string;
  maxTurnsPerPeer?: number;
  producer?: RunnerKind;
} {
  let remaining = rest;
  let maxTurnsPerPeer: number | undefined;
  let producer: RunnerKind | undefined;

  while (true) {
    const m = remaining.match(CONSENSUS_FLAG);
    if (!m) break;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "max") {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n > 0) maxTurnsPerPeer = n;
    } else if (key === "producer") {
      const v = val.toLowerCase();
      if (v === "claude" || v === "codex") producer = v;
    }
    remaining = remaining.slice(m[0].length);
  }
  return {
    type: "consensus",
    task: remaining.trim(),
    maxTurnsPerPeer,
    producer,
  };
}

function parsePermissionsAction(rest: string): PermissionsAction {
  if (!rest) return { kind: "list" };
  const [verb, ...rule] = rest.split(/\s+/);
  const tail = rule.join(" ").trim();
  switch (verb.toLowerCase()) {
    case "add":
      return { kind: "add", rule: tail };
    case "remove":
    case "rm":
    case "delete":
      return { kind: "remove", rule: tail };
    case "clear":
      return { kind: "clear" };
    default:
      // Treat unknown verb as no-op list so users get the current state and
      // can read the usage line.
      return { kind: "list" };
  }
}

// Cycle: claude → codex → vercel → ollama → claude. Used by /switch and the
// runner-toggle keybinding so users can rotate through every harness without
// memorising the explicit /claude /codex /vercel /ollama forms.
export function toggleRunner(current: RunnerKind): RunnerKind {
  if (current === "claude") return "codex";
  if (current === "codex") return "vercel";
  if (current === "vercel") return "ollama";
  return "claude";
}

export const SLASH_COMMANDS: ReadonlyArray<{ name: string; help: string }> = [
  { name: "/claude [text]", help: "switch active runner to Claude (and optionally send)" },
  { name: "/codex [text]", help: "switch active runner to Codex (and optionally send)" },
  { name: "/vercel [text]", help: "switch active runner to Vercel AI SDK (and optionally send)" },
  { name: "/ollama [text]", help: "switch active runner to Ollama (local models, free; and optionally send)" },
  { name: "/switch [text]", help: "cycle runner: claude → codex → vercel → ollama" },
  { name: "/clear", help: "start a fresh session and drop the current one" },
  { name: "/help", help: "show this help" },
  { name: "/context", help: "show session info: runner, cwd, tokens, messages" },
  { name: "/sessions", help: "list all sessions with runner, cwd, message count" },
  { name: "/tree [depth]", help: "show project tree of the session's cwd (default depth 3)" },
  { name: "/consensus <task>", help: "single actor/critic cycle (claude↔codex); writes one draft, critic reviews once" },
  { name: "/permissions [add|remove|clear]", help: "manage Claude tool-permission rules (Claude only)" },
  { name: "/model [show | <name> | <runner> <name> | reset]", help: "open model picker for active runner; show prints status; <name> sets directly" },
  { name: "/effort [show | <level> | <runner> <level> | reset]", help: "open effort slider for active runner; levels depend on the active model" },
  { name: "/plan [on|off]", help: "plan-only mode — model proposes a plan, no tools run (Claude only)" },
  { name: "/skills [add|import|remove|info]", help: "manage skills for the active runner (~/.claude/skills or ~/.codex/skills); `import <claude|codex> [name]` copies from the other runner" },
  { name: "/mcp [add|remove|test]", help: "manage MCP servers for the active runner via its CLI" },
  { name: "/new [title] [runner]", help: "create a new session (optional: title and runner—claude|codex|vercel|ollama)" },
];
