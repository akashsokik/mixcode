import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadThemePref, saveThemePref } from "./theme-prefs";

// Point the prefs functions at a throwaway directory so the test never touches
// the real ~/.adverserial-code prefs file.
let dir: string;
let prefsPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "theme-prefs-"));
  prefsPath = join(dir, "tui-prefs.json");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("theme prefs persistence", () => {
  test("defaults to material when no file exists", () => {
    expect(loadThemePref(dir)).toBe("material");
  });

  test("round-trips a saved palette", () => {
    saveThemePref("nord", dir);
    expect(loadThemePref(dir)).toBe("nord");
  });

  test("resolves aliases/casing written to disk", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(prefsPath, JSON.stringify({ theme: "Tokyo Night" }), "utf8");
    expect(loadThemePref(dir)).toBe("tokyonight");
  });

  test("falls back to the default on unknown name", () => {
    writeFileSync(prefsPath, JSON.stringify({ theme: "dracula" }), "utf8");
    expect(loadThemePref(dir)).toBe("material");
  });

  test("falls back to the default on malformed json", () => {
    writeFileSync(prefsPath, "{ not json", "utf8");
    expect(loadThemePref(dir)).toBe("material");
  });
});
