import type { ToolLog } from "../../../shared/events.ts";

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
} {
  const isError = log.isError === true;
  const header = formatHeader(log.name, log.input, isError);
  const body = formatOutput(log.output);
  const category = categorizeTool(log.name);
  const edit = category === "edit" ? extractEdit(log.input) : null;
  return { header, body, isError, category, edit };
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

function formatHeader(name: string, input: unknown, isError: boolean): string {
  const prefix = isError ? "!" : ">";
  const summary = summarizeInput(name, input);
  return summary ? `${prefix} ${name} ${summary}` : `${prefix} ${name}`;
}

function summarizeInput(_name: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return truncateOneLine(String(input), INLINE_INPUT_LIMIT);

  const obj = input as Record<string, unknown>;
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
