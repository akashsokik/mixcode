// The TUI is monochrome at its base: backgrounds, text grays, borders, and
// selection never change. Only the ACCENT tokens (tool/runner/diff/markdown
// hues) are swappable, supplied by the active palette. `/theme` swaps the
// accent layer; the base below is identical in every palette.

// BASE — fixed grayscale. Never themed. Identical across every palette.
const BASE = {
  bg: "transparent",
  bgPanel: "transparent",
  bgCard: "transparent",
  bgHeader: "transparent",

  text: "#e5e5e5",
  textMuted: "#8a8a8a",
  textSubtle: "#555555",
  textFaint: "#333333",

  border: "#1f1f1f",
  borderFocused: "#888888",

  // Mouse-drag text selection. Subtle gray bg so the highlight reads as a
  // gentle wash instead of the default fg/bg inversion (which looks like a
  // glaring white block on this dark palette).
  selectionBg: "#2a2a2a",
  selectionFg: "#e5e5e5",

  accent: "#ffffff",
  accentDim: "#bbbbbb",

  // Markdown grays (headings/quotes/list markers/strikethrough are structural,
  // not accents — they stay monochrome in every palette).
  mdHeading: "#ffffff",
  mdQuote: "#a8a8a8",
  mdListMarker: "#888888",
  mdStrikethrough: "#666666",

  // Diff backgrounds (subtle — only visible on dark bg). Structural to how
  // diffs render, so they stay fixed; only the diff foregrounds are themed.
  diffAddBg: "#0f1c0f",
  diffRemBg: "#1c0f0f",
} as const;

export type BaseTokens = typeof BASE;

// ACCENT — the only tokens a palette supplies. Runner hues keep their family
// across palettes (claude=green, codex=amber/orange, vercel=teal, ollama=
// violet) so identity stays recognizable; each *Idle is a darkened variant.
export type AccentTokens = {
  toolEdit: string;
  toolRead: string;
  toolBash: string;
  toolWeb: string;
  toolTask: string;
  toolError: string;

  mdCode: string;
  mdLink: string;
  mdLinkUrl: string;

  diffAddFg: string;
  diffRemFg: string;

  runnerClaude: string;
  runnerClaudeIdle: string;
  runnerCodex: string;
  runnerCodexIdle: string;
  runnerVercel: string;
  runnerVercelIdle: string;
  runnerOllama: string;
  runnerOllamaIdle: string;

  gitDirty: string;
};

export type Theme = BaseTokens & AccentTokens;

export const THEME_NAMES = [
  "material",
  "gruvbox",
  "catppuccin",
  "nord",
  "tokyonight",
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const DEFAULT_THEME: ThemeName = "material";

// Human-facing labels (picker rows + notices).
export const THEME_LABELS: Record<ThemeName, string> = {
  material: "Material",
  gruvbox: "Gruvbox",
  catppuccin: "Catppuccin Mocha",
  nord: "Nord",
  tokyonight: "Tokyo Night",
};

export const PALETTES: Record<ThemeName, AccentTokens> = {
  // Material Theme's syntax palette (shared by Palenight/Oceanic): green
  // #c3e88d, blue #82aaff, mauve #c792ea, cyan #89ddff, orange #f78c6c,
  // yellow #ffcb6b, red #ff5370.
  material: {
    toolEdit: "#c3e88d",
    toolRead: "#b2ccd6",
    toolBash: "#ffcb6b",
    toolWeb: "#82aaff",
    toolTask: "#c792ea",
    toolError: "#ff5370",
    mdCode: "#89ddff",
    mdLink: "#82aaff",
    mdLinkUrl: "#5c7ec7",
    diffAddFg: "#c3e88d",
    diffRemFg: "#ff5370",
    runnerClaude: "#c3e88d",
    runnerClaudeIdle: "#5e7240",
    runnerCodex: "#f78c6c",
    runnerCodexIdle: "#7a4a39",
    runnerVercel: "#89ddff",
    runnerVercelIdle: "#3f6b7a",
    runnerOllama: "#c792ea",
    runnerOllamaIdle: "#634a78",
    gitDirty: "#ff9cac",
  },
  gruvbox: {
    toolEdit: "#b8bb26",
    toolRead: "#a89984",
    toolBash: "#fabd2f",
    toolWeb: "#83a598",
    toolTask: "#d3869b",
    toolError: "#fb4934",
    mdCode: "#83a598",
    mdLink: "#83a598",
    mdLinkUrl: "#458588",
    diffAddFg: "#b8bb26",
    diffRemFg: "#fb4934",
    runnerClaude: "#b8bb26",
    runnerClaudeIdle: "#79740e",
    runnerCodex: "#fe8019",
    runnerCodexIdle: "#7c4a1e",
    runnerVercel: "#8ec07c",
    runnerVercelIdle: "#4a6b42",
    runnerOllama: "#b16286",
    runnerOllamaIdle: "#5c3450",
    gitDirty: "#d65d0e",
  },
  catppuccin: {
    toolEdit: "#a6e3a1",
    toolRead: "#bac2de",
    toolBash: "#f9e2af",
    toolWeb: "#89b4fa",
    toolTask: "#cba6f7",
    toolError: "#f38ba8",
    mdCode: "#89b4fa",
    mdLink: "#89b4fa",
    mdLinkUrl: "#6c95d6",
    diffAddFg: "#a6e3a1",
    diffRemFg: "#f38ba8",
    runnerClaude: "#a6e3a1",
    runnerClaudeIdle: "#4f7a4c",
    runnerCodex: "#fab387",
    runnerCodexIdle: "#7a5a42",
    runnerVercel: "#94e2d5",
    runnerVercelIdle: "#486e68",
    runnerOllama: "#b4befe",
    runnerOllamaIdle: "#5a5e7e",
    gitDirty: "#eba0ac",
  },
  nord: {
    toolEdit: "#a3be8c",
    toolRead: "#8b94a3",
    toolBash: "#ebcb8b",
    toolWeb: "#81a1c1",
    toolTask: "#b48ead",
    toolError: "#bf616a",
    mdCode: "#88c0d0",
    mdLink: "#88c0d0",
    mdLinkUrl: "#5e81ac",
    diffAddFg: "#a3be8c",
    diffRemFg: "#bf616a",
    runnerClaude: "#a3be8c",
    runnerClaudeIdle: "#50603f",
    runnerCodex: "#d08770",
    runnerCodexIdle: "#6e4639",
    runnerVercel: "#8fbcbb",
    runnerVercelIdle: "#496160",
    runnerOllama: "#b48ead",
    runnerOllamaIdle: "#5c4a58",
    gitDirty: "#d0a070",
  },
  tokyonight: {
    toolEdit: "#9ece6a",
    toolRead: "#a9b1d6",
    toolBash: "#e0af68",
    toolWeb: "#7aa2f7",
    toolTask: "#bb9af7",
    toolError: "#f7768e",
    mdCode: "#7dcfff",
    mdLink: "#7aa2f7",
    mdLinkUrl: "#547ac0",
    diffAddFg: "#9ece6a",
    diffRemFg: "#f7768e",
    runnerClaude: "#9ece6a",
    runnerClaudeIdle: "#4f6837",
    runnerCodex: "#e0af68",
    runnerCodexIdle: "#6f5736",
    runnerVercel: "#7dcfff",
    runnerVercelIdle: "#3f687f",
    runnerOllama: "#bb9af7",
    runnerOllamaIdle: "#5d4d7b",
    gitDirty: "#ff9e64",
  },
};

// The live theme object every component reads. We mutate its accent keys in
// place on switch (rather than swapping the reference) so the ~27 existing
// `import { theme }` consumers keep working untouched — a re-render is enough
// to pick up the new values. See applyPalette + subscribeTheme.
export const theme: Theme = { ...BASE, ...PALETTES[DEFAULT_THEME] };

let activeName: ThemeName = DEFAULT_THEME;
const listeners = new Set<() => void>();

// Resolve a user-typed name (with common aliases / loose casing) to a palette.
// Returns null for anything unknown so callers can show the list instead.
export function resolveThemeName(input: string): ThemeName | null {
  const k = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (k) {
    case "material":
    case "materialtheme":
    case "mat":
      return "material";
    case "gruvbox":
      return "gruvbox";
    case "catppuccin":
    case "catppuccinmocha":
    case "mocha":
    case "cat":
      return "catppuccin";
    case "nord":
      return "nord";
    case "tokyonight":
    case "tokyo":
    case "tokyonightnight":
      return "tokyonight";
    default:
      return null;
  }
}

export function getThemeName(): ThemeName {
  return activeName;
}

// Subscribe to palette switches. Returns an unsubscribe fn. Used by app.tsx
// (useSyncExternalStore -> whole-tree re-render) and markdown-style.ts (rebuild
// the cached SyntaxStyle).
export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Swap the accent layer in place and notify subscribers. BASE is left intact.
export function applyPalette(name: ThemeName): void {
  Object.assign(theme, PALETTES[name]);
  activeName = name;
  for (const cb of listeners) cb();
}
