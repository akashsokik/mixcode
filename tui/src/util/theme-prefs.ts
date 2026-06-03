import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THEME, resolveThemeName, type ThemeName } from "../theme";

// TUI-local preferences live alongside the server's existing state under
// ~/.adverserial-code (same home the permissions store + transcripts use).
// `dir` is injectable so tests can point at a temp directory without touching
// the real prefs file; production callers use the default.
const DEFAULT_DIR = join(homedir(), ".adverserial-code");
const PREFS_FILE = "tui-prefs.json";

type Prefs = { theme?: string };

// Read the persisted palette. Best-effort: a missing file, bad JSON, or an
// unknown name all fall back to the default rather than throwing.
export function loadThemePref(dir: string = DEFAULT_DIR): ThemeName {
  try {
    const raw = readFileSync(join(dir, PREFS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Prefs;
    const name = typeof parsed.theme === "string" ? resolveThemeName(parsed.theme) : null;
    return name ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

// Persist the chosen palette. Best-effort: persistence is not load-bearing, so
// a write failure is swallowed (the in-session switch still applies).
export function saveThemePref(name: ThemeName, dir: string = DEFAULT_DIR): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, PREFS_FILE);
    let prefs: Prefs = {};
    try {
      prefs = JSON.parse(readFileSync(path, "utf8")) as Prefs;
    } catch {
      // No existing prefs (or unreadable) — start fresh.
    }
    prefs.theme = name;
    writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  } catch {
    // Swallow — best-effort persistence.
  }
}
