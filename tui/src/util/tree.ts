import { readdirSync } from "node:fs";
import path from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

const DEFAULT_DEPTH = 3;
const MAX_PER_DIR = 16;
const MAX_LINES = 200;

export function treeLines(root: string, depth: number = DEFAULT_DEPTH): string[] {
  const lines: string[] = [];
  lines.push(`${path.basename(root) || root}/`);
  walk(root, "", 0, depth, lines);
  if (lines.length >= MAX_LINES) {
    lines.push(`… tree truncated at ${MAX_LINES} lines`);
  }
  return lines;
}

function walk(
  absDir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  lines: string[],
): void {
  if (depth >= maxDepth) return;
  if (lines.length >= MAX_LINES) return;

  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  const filtered = entries
    .filter((e) => {
      if (IGNORE.has(e.name)) return false;
      if (e.name.startsWith(".") && e.name !== ".env.example") return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const shown = filtered.slice(0, MAX_PER_DIR);
  const hiddenCount = filtered.length - shown.length;

  shown.forEach((entry, i) => {
    if (lines.length >= MAX_LINES) return;
    const isLast = i === shown.length - 1 && hiddenCount === 0;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const display = entry.isDirectory() ? `${entry.name}/` : entry.name;
    lines.push(prefix + branch + display);
    if (entry.isDirectory()) {
      walk(path.join(absDir, entry.name), childPrefix, depth + 1, maxDepth, lines);
    }
  });

  if (hiddenCount > 0 && lines.length < MAX_LINES) {
    lines.push(prefix + `└── … +${hiddenCount} more`);
  }
}
