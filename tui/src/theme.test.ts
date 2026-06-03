import { afterEach, describe, expect, test } from "bun:test";
import {
  applyPalette,
  DEFAULT_THEME,
  getThemeName,
  PALETTES,
  resolveThemeName,
  subscribeTheme,
  theme,
  THEME_NAMES,
} from "./theme";

// The base (grayscale) tokens must be identical in every palette. We snapshot
// them once and assert they never move when the accent layer is swapped.
const BASE_SNAPSHOT = {
  bg: theme.bg,
  text: theme.text,
  textMuted: theme.textMuted,
  textSubtle: theme.textSubtle,
  textFaint: theme.textFaint,
  border: theme.border,
  borderFocused: theme.borderFocused,
  selectionBg: theme.selectionBg,
  selectionFg: theme.selectionFg,
  accent: theme.accent,
  accentDim: theme.accentDim,
  mdHeading: theme.mdHeading,
  mdQuote: theme.mdQuote,
  mdListMarker: theme.mdListMarker,
  mdStrikethrough: theme.mdStrikethrough,
  diffAddBg: theme.diffAddBg,
  diffRemBg: theme.diffRemBg,
};

afterEach(() => {
  // Restore the default so test order can't leak palette state.
  applyPalette(DEFAULT_THEME);
});

describe("applyPalette", () => {
  test("swaps every accent token to the selected palette", () => {
    applyPalette("nord");
    for (const key of Object.keys(PALETTES.nord) as (keyof typeof PALETTES.nord)[]) {
      expect(theme[key]).toBe(PALETTES.nord[key]);
    }
  });

  test("leaves every base token untouched", () => {
    for (const name of THEME_NAMES) {
      applyPalette(name);
      for (const [key, value] of Object.entries(BASE_SNAPSHOT)) {
        expect(theme[key as keyof typeof BASE_SNAPSHOT]).toBe(value);
      }
    }
  });

  test("updates the active name", () => {
    applyPalette("tokyonight");
    expect(getThemeName()).toBe("tokyonight");
  });

  test("notifies subscribers and the unsubscribe stops them", () => {
    let calls = 0;
    const unsub = subscribeTheme(() => {
      calls += 1;
    });
    applyPalette("catppuccin");
    expect(calls).toBe(1);
    unsub();
    applyPalette("gruvbox");
    expect(calls).toBe(1);
  });
});

describe("resolveThemeName", () => {
  test("resolves canonical names", () => {
    expect(resolveThemeName("material")).toBe("material");
    expect(resolveThemeName("gruvbox")).toBe("gruvbox");
    expect(resolveThemeName("nord")).toBe("nord");
    expect(resolveThemeName("catppuccin")).toBe("catppuccin");
    expect(resolveThemeName("tokyonight")).toBe("tokyonight");
  });
  test("resolves aliases and loose casing/spacing", () => {
    expect(resolveThemeName("Mocha")).toBe("catppuccin");
    expect(resolveThemeName("Catppuccin Mocha")).toBe("catppuccin");
    expect(resolveThemeName(" Tokyo ")).toBe("tokyonight");
    expect(resolveThemeName("tokyo-night")).toBe("tokyonight");
  });
  test("returns null for unknown names", () => {
    expect(resolveThemeName("dracula")).toBeNull();
    expect(resolveThemeName("")).toBeNull();
  });
});
