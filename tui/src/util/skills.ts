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

// Map a runner to the on-disk skills root. Returns null for runners that
// don't participate in the user-installed skills ecosystem (e.g. vercel,
// which uses the Vercel AI SDK's bring-your-own-tools model). All callers
// gracefully degrade — they treat null as "no skills available".
function skillsDirOrNull(runner: RunnerKind): string | null {
  if (runner === "claude") return path.join(homedir(), ".claude", "skills");
  if (runner === "codex") return path.join(homedir(), ".codex", "skills");
  return null;
}

function pluginsCacheDir(runner: RunnerKind): string | null {
  if (runner === "claude") return path.join(homedir(), ".claude", "plugins", "cache");
  if (runner === "codex") return path.join(homedir(), ".codex", "plugins", "cache");
  return null;
}

// Walk `~/.<runner>/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>`
// for SKILL.md and return one entry per skill, named `<plugin>:<skill>`.
// Plugin skills are real directories (not symlinks) and can't be removed via
// /skills remove — `isSymlink: false` correctly hides the d action.
function listPluginSkills(runner: RunnerKind): SkillEntry[] {
  const root = pluginsCacheDir(runner);
  if (!root) return [];
  const out: SkillEntry[] = [];
  const marketplaces = safeReaddir(root);
  for (const market of marketplaces) {
    if (!market.isDirectory()) continue;
    const marketDir = path.join(root, market.name);
    for (const plugin of safeReaddir(marketDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(marketDir, plugin.name);
      // Only the most recent installed version is loaded by the runner, but
      // we don't know which without parsing installed_plugins.json — surface
      // every version we find, deduped by `<plugin>:<skill>` later. Cheaper
      // than re-implementing the SDK's resolver here.
      for (const ver of safeReaddir(pluginDir)) {
        if (!ver.isDirectory()) continue;
        const skillsRoot = path.join(pluginDir, ver.name, "skills");
        for (const skill of safeReaddir(skillsRoot)) {
          if (!skill.isDirectory()) continue;
          const skillDir = path.join(skillsRoot, skill.name);
          if (!existsSync(path.join(skillDir, "SKILL.md"))) continue;
          out.push({
            name: `${plugin.name}:${skill.name}`,
            source: skillDir,
            isSymlink: false,
            description: readSkillDescription(skillDir),
          });
        }
      }
    }
  }
  // Dedupe by qualified name — when multiple cached versions exist we keep
  // the lexically-last one, which is good enough for a description preview.
  const byName = new Map<string, SkillEntry>();
  for (const e of out) byName.set(e.name, e);
  return Array.from(byName.values());
}

function safeReaddir(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

// Returns the union of `~/.<runner>/skills/*` (user-installed, removable) and
// `~/.<runner>/plugins/cache/*/<plugin>/<ver>/skills/*` (plugin-bundled). The
// SDK-sourced palette path supersedes this for Claude once a turn has run,
// but it's the only source we have for Codex and for the pre-first-turn
// bootstrap. Built-in CLI skills don't live on disk and aren't included here.
export function listSkills(runner: RunnerKind): SkillEntry[] {
  const dir = skillsDirOrNull(runner);
  if (!dir) return [];
  const out: SkillEntry[] = [];
  for (const e of safeReaddir(dir)) {
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
  // Merge in plugin-cache skills. User-dir entries win on name collision
  // because they're the ones the user can /skills remove.
  const taken = new Set(out.map((e) => e.name));
  for (const e of listPluginSkills(runner)) {
    if (taken.has(e.name)) continue;
    out.push(e);
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
  const dir = skillsDirOrNull(runner);
  if (!dir) {
    return { ok: false, error: `the ${runner} runner has no on-disk skills directory` };
  }
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

export type ImportSkillResult =
  | {
      ok: true;
      target: RunnerKind;
      source: RunnerKind;
      name: string;
      sourcePath: string;
      targetPath: string;
    }
  | { ok: false; error: string };

// Symlink a single skill from `source`'s skills dir into `target`'s. The link
// points at the resolved source (following one hop if the source entry itself
// is a symlink) so removing the source's link later doesn't break the import.
export function importSkill(
  target: RunnerKind,
  source: RunnerKind,
  name: string,
): ImportSkillResult {
  if (target === source) {
    return { ok: false, error: `target and source are the same runner: ${target}` };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, error: `invalid skill name: ${name}` };
  }
  const targetDir = skillsDirOrNull(target);
  if (!targetDir) {
    return { ok: false, error: `the ${target} runner has no on-disk skills directory` };
  }
  if (!skillsDirOrNull(source)) {
    return { ok: false, error: `the ${source} runner has no on-disk skills directory` };
  }
  const entry = listSkills(source).find((s) => s.name === name);
  if (!entry) {
    return { ok: false, error: `no such skill in ${source}: ${name}` };
  }
  if (!entry.source) {
    return { ok: false, error: `${source}/${name} is a broken symlink — cannot import` };
  }
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `failed to create ${targetDir}: ${(err as Error).message}` };
  }
  const targetPath = path.join(targetDir, name);
  if (existsSync(targetPath)) {
    return { ok: false, error: `already exists in ${target}: ${name}` };
  }
  try {
    symlinkSync(entry.source, targetPath);
  } catch (err) {
    return { ok: false, error: `symlink failed: ${(err as Error).message}` };
  }
  return { ok: true, target, source, name, sourcePath: entry.source, targetPath };
}

export type ImportAllSkillsResult = {
  target: RunnerKind;
  source: RunnerKind;
  imported: { name: string; sourcePath: string }[];
  skipped: { name: string; reason: string }[];
};

// Import every user-installable skill from `source` into `target`. Plugin-
// bundled skills (names containing colons) are skipped because the runner
// skills dir requires the `^[A-Za-z0-9._-]+$` filename shape.
export function importAllSkills(
  target: RunnerKind,
  source: RunnerKind,
): ImportAllSkillsResult {
  const imported: { name: string; sourcePath: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (target === source) {
    return {
      target,
      source,
      imported,
      skipped: [{ name: "*", reason: "target and source are the same runner" }],
    };
  }
  for (const entry of listSkills(source)) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) {
      skipped.push({ name: entry.name, reason: "plugin-bundled (not importable)" });
      continue;
    }
    const res = importSkill(target, source, entry.name);
    if (res.ok) imported.push({ name: res.name, sourcePath: res.sourcePath });
    else skipped.push({ name: entry.name, reason: res.error });
  }
  return { target, source, imported, skipped };
}

export type RemoveSkillResult =
  | { ok: true; runner: RunnerKind; name: string; target: string; wasSymlink: boolean }
  | { ok: false; error: string };

export function removeSkill(runner: RunnerKind, name: string): RemoveSkillResult {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, error: `invalid skill name: ${name}` };
  }
  const dir = skillsDirOrNull(runner);
  if (!dir) {
    return { ok: false, error: `the ${runner} runner has no on-disk skills directory` };
  }
  const target = path.join(dir, name);
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
