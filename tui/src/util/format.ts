import type { ToolLog } from "../../../shared/events.ts";

const OUTPUT_CHAR_LIMIT = 800;
const OUTPUT_LINE_LIMIT = 12;
const INLINE_INPUT_LIMIT = 80;

export function formatToolLog(log: ToolLog): {
  header: string;
  body: string;
  isError: boolean;
} {
  const isError = log.isError === true;
  const header = formatHeader(log.name, log.input, isError);
  const body = formatOutput(log.output);
  return { header, body, isError };
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
