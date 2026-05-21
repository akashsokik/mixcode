import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RunnerKind } from "../../../shared/events.ts";

export type SkillEntry = {
  name: string;
  // Absolute path of the resolved skill directory (target if symlink, self
  // otherwise). null if the entry is a broken symlink.
  source: string | null;
  isSymlink: boolean;
  // Best-effort description pulled from SKILL.md frontmatter. Empty if absent.
  description: string;
};

export type SkillFrontmatter = {
  name?: string;
  description?: string;
  // Other recognised frontmatter keys are kept as-is for display.
  extra: Record<string, string>;
};

function skillsDir(runner: RunnerKind): string {
  return path.join(homedir(), runner === "claude" ? ".claude" : ".codex", "skills");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function listSkills(runner: RunnerKind): SkillEntry[] {
  const dir = skillsDir(runner);
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const isSymlink = e.isSymbolicLink();
    let source: string | null = full;
    if (isSymlink) {
      try {
        const target = readlinkSync(full);
        source = path.isAbsolute(target) ? target : path.resolve(dir, target);
        if (!existsSync(source)) source = null;
      } catch {
        source = null;
      }
    } else if (!e.isDirectory()) {
      continue;
    }
    out.push({
      name: e.name,
      source,
      isSymlink,
      description: source ? readSkillDescription(source) : "",
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readSkillDescription(skillDir: string): string {
  const file = path.join(skillDir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const fm = parseFrontmatter(text);
  return fm.description ?? "";
}

export function readSkillFrontmatter(runner: RunnerKind, name: string): SkillFrontmatter | null {
  const entry = listSkills(runner).find((s) => s.name === name);
  if (!entry || !entry.source) return null;
  const file = path.join(entry.source, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseFrontmatter(text);
}

// Parse YAML-style `---` frontmatter. Extracts top-level `key: value` pairs.
// Handles folded (`>`) and literal (`|`) block scalars by stripping the
// indicator and joining continuation lines. Nested mappings and lists are
// rendered as a single-line summary so they still show up in /skills info
// without dragging in a YAML dependency.
function parseFrontmatter(text: string): SkillFrontmatter {
  const result: SkillFrontmatter = { extra: {} };
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return result;
  let currentKey: string | null = null;
  let buffer: string[] = [];
  let blockMode: "folded" | "literal" | null = null;
  const flush = () => {
    if (!currentKey) return;
    let value: string;
    if (blockMode === "literal") {
      value = buffer.join("\n").trim();
    } else {
      value = buffer.join(" ").trim();
    }
    if (currentKey === "name") result.name = value;
    else if (currentKey === "description") result.description = value;
    else result.extra[currentKey] = value;
    currentKey = null;
    buffer = [];
    blockMode = null;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      flush();
      return result;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = m[1];
      const rest = m[2];
      if (rest === ">" || rest === ">-" || rest === ">+") {
        blockMode = "folded";
        buffer = [];
      } else if (rest === "|" || rest === "|-" || rest === "|+") {
        blockMode = "literal";
        buffer = [];
      } else {
        blockMode = null;
        buffer = rest ? [rest] : [];
      }
    } else if (currentKey && line.trim()) {
      buffer.push(line.trim());
    }
  }
  flush();
  return result;
}

export type AddSkillResult =
  | { ok: true; runner: RunnerKind; name: string; source: string; target: string }
  | { ok: false; error: string };

export function addSkill(runner: RunnerKind, rawPath: string, opts?: { nameOverride?: string }): AddSkillResult {
  const abs = path.resolve(expandHome(rawPath));
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { ok: false, error: `path not found: ${abs}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${abs}` };
  }
  if (!existsSync(path.join(abs, "SKILL.md"))) {
    return { ok: false, error: `missing SKILL.md in ${abs}` };
  }
  const name = opts?.nameOverride ?? path.basename(abs);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, error: `invalid skill name: ${name}` };
  }
  const dir = skillsDir(runner);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `failed to create ${dir}: ${(err as Error).message}` };
  }
  const target = path.join(dir, name);
  if (existsSync(target)) {
    return { ok: false, error: `already exists: ${target}` };
  }
  try {
    symlinkSync(abs, target);
  } catch (err) {
    return { ok: false, error: `symlink failed: ${(err as Error).message}` };
  }
  return { ok: true, runner, name, source: abs, target };
}

export type RemoveSkillResult =
  | { ok: true; runner: RunnerKind; name: string; target: string; wasSymlink: boolean }
  | { ok: false; error: string };

export function removeSkill(runner: RunnerKind, name: string): RemoveSkillResult {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, error: `invalid skill name: ${name}` };
  }
  const target = path.join(skillsDir(runner), name);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return { ok: false, error: `no such skill: ${name}` };
  }
  if (!stat.isSymbolicLink()) {
    return {
      ok: false,
      error: `${name} is a real directory, not a symlink. Refusing to delete — remove it manually if you really want.`,
    };
  }
  try {
    unlinkSync(target);
  } catch (err) {
    return { ok: false, error: `unlink failed: ${(err as Error).message}` };
  }
  return { ok: true, runner, name, target, wasSymlink: true };
}
