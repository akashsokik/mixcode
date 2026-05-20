import { readdir } from "node:fs/promises";
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

const MAX_FILES = 2000;

/**
 * Enumerate files under `root` (cwd by default), skipping common heavy dirs.
 * Returns paths relative to `root`. Capped at MAX_FILES.
 */
export async function listCwdFiles(root: string = process.cwd()): Promise<string[]> {
  const out: string[] = [];
  await walk(root, "", out);
  return out;
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (entry.name !== ".env.example") continue;
    }
    if (IGNORE.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
      if (out.length >= MAX_FILES) return;
    }
  }
}
