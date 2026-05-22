import type { ToolLog } from "../../../shared/events.ts";
import { basename } from "./path";

const OUTPUT_CHAR_LIMIT = 800;
const OUTPUT_LINE_LIMIT = 12;
const INLINE_INPUT_LIMIT = 80;
const DIFF_LINE_LIMIT = 8;
const DIFF_LINE_CHARS = 100;

export type ToolCategory = "edit" | "read" | "bash" | "web" | "task" | "other";

export type EditPreview = {
  filePath?: string;
  removed: string[];
  added: string[];
  more: number; // number of additional change blocks not shown
};

// Rewrite the SDK's MCP-prefixed tool names (`mcp__<server>__<tool>`) inside
// assistant prose so users see `delegate_run` rather than the wire form. The
// Claude Agent SDK registers MCP tools to the model with this prefix, and the
// model sometimes echoes it back when narrating its plan.
export function cleanModelText(s: string): string {
  return s.replace(/mcp__[A-Za-z0-9._-]+__([A-Za-z0-9_]+)/g, "$1");
}

export function categorizeTool(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (
    n === "edit" ||
    n === "write" ||
    n === "multiedit" ||
    n === "notebookedit" ||
    n === "create"
  ) {
    return "edit";
  }
  if (n === "bash" || n === "shell" || n.endsWith("execute")) return "bash";
  if (n === "read" || n === "grep" || n === "glob" || n === "ls") return "read";
  if (n === "websearch" || n === "webfetch" || n.startsWith("web")) return "web";
  if (n === "task" || n === "agent" || n.includes(".")) return "task";
  return "other";
}

export function formatToolLog(log: ToolLog): {
  header: string;
  body: string;
  isError: boolean;
  category: ToolCategory;
  edit: EditPreview | null;
  peer: string | null;
} {
  const isError = log.isError === true;
  // Peer-prefixed names (e.g. "[codex] Bash") come from the orchestrator's
  // onPeerEvent bridge. Pull the chip out so it can render separately and the
  // category accent picks up the real underlying tool.
  const { peer, rest: afterPeer } = stripPeerPrefix(log.name);
  // Strip the MCP namespace prefix (`mcp__<server>__tool` -> `tool`) so users
  // see the tool's actual name rather than the wire-format mangling.
  const displayName = stripMcpPrefix(afterPeer);

  // Compact two-line form for delegate_run — the generic renderer would dump
  // the MCP wrapper and double-escaped JSON, neither of which is readable.
  if (displayName === "delegate_run") {
    const { header, body } = formatDelegateRun(log.input, log.output, isError);
    return { header, body, isError, category: "task", edit: null, peer };
  }

  const header = formatHeader(displayName, log.input, isError);
  const body = formatOutput(unwrapMcpContent(log.output));
  const category = categorizeTool(displayName);
  const edit = category === "edit" ? extractEdit(log.input) : null;
  return { header, body, isError, category, edit, peer };
}

// "[codex] Bash" -> { peer: "codex", rest: "Bash" }
export function stripPeerPrefix(name: string): { peer: string | null; rest: string } {
  const m = name.match(/^\[([^\]]+)\]\s+(.+)$/);
  if (!m) return { peer: null, rest: name };
  return { peer: m[1], rest: m[2] };
}

// "mcp__orchestrator__delegate_run" -> "delegate_run".
// Servers may have underscores in their tool names, so split on the canonical
// `__` separator (introduced by the SDK) rather than a single underscore.
export function stripMcpPrefix(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  if (parts.length < 3) return name;
  return parts.slice(2).join("__");
}

// Compact one-line summary of a peer tool_log for the collapsed group preview.
// "Read /tui/src/app.tsx" -> "Read app.tsx"; "Bash $ npm run build" -> "Bash"
export function peerToolSummary(log: ToolLog): string {
  const { rest } = stripPeerPrefix(log.name);
  const name = stripMcpPrefix(rest);
  const obj =
    log.input && typeof log.input === "object"
      ? (log.input as Record<string, unknown>)
      : null;
  if (!obj) return name;
  if (typeof obj.file_path === "string") return `${name} ${basename(obj.file_path)}`;
  if (typeof obj.path === "string") return `${name} ${basename(obj.path)}`;
  if (typeof obj.command === "string") {
    const verb = obj.command.trim().split(/\s+/)[0] ?? "";
    return verb ? `${name} ${verb}` : name;
  }
  if (typeof obj.pattern === "string") return `${name} "${truncateOneLine(obj.pattern, 24)}"`;
  if (typeof obj.query === "string") return `${name} "${truncateOneLine(obj.query, 24)}"`;
  return name;
}

// Unwrap the MCP CallToolResult.content envelope: `[{type:"text",text:"..."}]`.
// Returns the joined inner text, or the original value if the shape doesn't
// match. Applies to every in-process MCP tool, not just delegate_run.
function unwrapMcpContent(output: unknown): unknown {
  if (!Array.isArray(output) || output.length === 0) return output;
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") return output;
    const obj = item as Record<string, unknown>;
    if (obj.type !== "text" || typeof obj.text !== "string") return output;
    texts.push(obj.text);
  }
  return texts.length === 1 ? texts[0] : texts.join("\n");
}

// `delegate codex → "<prompt>"` / `← <status> · "<result>"`
function formatDelegateRun(
  input: unknown,
  output: unknown,
  isError: boolean,
): { header: string; body: string } {
  const inputObj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const profile =
    typeof inputObj.profileName === "string" ? inputObj.profileName : "?";
  const prompt = typeof inputObj.prompt === "string" ? inputObj.prompt : "";
  const promptPreview = truncateOneLine(prompt, INLINE_INPUT_LIMIT);
  const header = promptPreview
    ? `delegate ${profile} → "${promptPreview}"`
    : `delegate ${profile}`;

  // Output is the MCP envelope with a JSON-stringified delegate payload inside.
  const inner = unwrapMcpContent(output);
  let status = "";
  let resultText = "";
  let error = "";
  if (typeof inner === "string") {
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.status === "string") status = parsed.status;
        if (typeof parsed.result === "string") resultText = parsed.result;
        if (typeof parsed.error === "string") error = parsed.error;
      } else {
        resultText = inner;
      }
    } catch {
      resultText = inner;
    }
  }

  const tag = status || (isError ? "error" : "ok");
  const summary = truncateOneLine(error || resultText, 200);
  const body = summary ? `← ${tag} · "${summary}"` : `← ${tag}`;
  return { header, body };
}

function extractEdit(input: unknown): EditPreview | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const filePath = typeof obj.file_path === "string" ? obj.file_path : undefined;

  // Edit / Write: { file_path, old_string, new_string }
  if (typeof obj.old_string === "string" && typeof obj.new_string === "string") {
    return {
      filePath,
      removed: clampLines(obj.old_string),
      added: clampLines(obj.new_string),
      more: 0,
    };
  }
  // Write: { file_path, content }
  if (typeof obj.content === "string" && obj.old_string === undefined) {
    return { filePath, removed: [], added: clampLines(obj.content), more: 0 };
  }
  // MultiEdit / Codex Edit: { edits | changes: [{ old_string, new_string }] }
  const list = Array.isArray(obj.edits) ? obj.edits : Array.isArray(obj.changes) ? obj.changes : null;
  if (list && list.length > 0) {
    const first = list[0] as Record<string, unknown>;
    return {
      filePath,
      removed: typeof first.old_string === "string" ? clampLines(first.old_string) : [],
      added: typeof first.new_string === "string" ? clampLines(first.new_string) : [],
      more: list.length - 1,
    };
  }
  return null;
}

function clampLines(text: string): string[] {
  const lines = text.split("\n").slice(0, DIFF_LINE_LIMIT);
  return lines.map((l) => (l.length > DIFF_LINE_CHARS ? l.slice(0, DIFF_LINE_CHARS - 1) + "…" : l));
}

function formatHeader(name: string, input: unknown, _isError: boolean): string {
  // Error vs ok is conveyed by accent color in the ToolCard; we don't need
  // a literal prefix marker here.
  const summary = summarizeInput(name, input);
  return summary ? `${name} ${summary}` : name;
}

function summarizeInput(name: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return truncateOneLine(String(input), INLINE_INPUT_LIMIT);

  const obj = input as Record<string, unknown>;
  // Per-tool shapes that have a canonical short summary. Keep this list
  // narrow — the generic field-based fallbacks below cover most tools.
  if (name.toLowerCase() === "todowrite") {
    // Claude shape: { todos: [{ status, ... }] }. Codex shape we synthesize
    // server-side: { count, completed }. Render both as "done/total".
    if (Array.isArray(obj.todos)) {
      const total = obj.todos.length;
      const done = obj.todos.filter(
        (t) => t && typeof t === "object" && (t as Record<string, unknown>).status === "completed",
      ).length;
      return `${done}/${total}`;
    }
    if (typeof obj.count === "number") {
      const completed = typeof obj.completed === "number" ? obj.completed : 0;
      return `${completed}/${obj.count}`;
    }
  }
  if (typeof obj.command === "string")
    return truncateOneLine(`$ ${obj.command}`, INLINE_INPUT_LIMIT);
  if (typeof obj.file_path === "string")
    return truncateOneLine(obj.file_path, INLINE_INPUT_LIMIT);
  if (typeof obj.path === "string")
    return truncateOneLine(obj.path, INLINE_INPUT_LIMIT);
  if (typeof obj.pattern === "string") {
    const where = typeof obj.path === "string" ? ` in ${obj.path}` : "";
    return truncateOneLine(`"${obj.pattern}"${where}`, INLINE_INPUT_LIMIT);
  }
  if (typeof obj.query === "string")
    return truncateOneLine(`"${obj.query}"`, INLINE_INPUT_LIMIT);

  return truncateOneLine(compactJson(obj), INLINE_INPUT_LIMIT);
}

function formatOutput(output: unknown): string {
  if (output == null || output === "") return "";
  const text = typeof output === "string" ? output : compactJson(output);
  if (!text) return "";

  const lines = text.split("\n");
  const hadMoreLines = lines.length > OUTPUT_LINE_LIMIT;
  const body = lines.slice(0, OUTPUT_LINE_LIMIT).join("\n");
  const truncated = body.length > OUTPUT_CHAR_LIMIT;
  const finalBody = truncated ? body.slice(0, OUTPUT_CHAR_LIMIT) : body;
  const trimmedLines = lines.length - finalBody.split("\n").length;

  let suffix = "";
  if (truncated || hadMoreLines) {
    suffix = trimmedLines > 0 ? `\n... (+${trimmedLines} more lines)` : "\n... (truncated)";
  }

  return finalBody + suffix;
}

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncateOneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
