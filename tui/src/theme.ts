// Mostly-monochrome palette with selective accents so details pop.
// The base is grayscale; structured tokens (inline code, links, tool
// names, diffs) carry one desaturated hue each.

export const theme = {
  bg: "#0a0a0a",
  bgPanel: "#0a0a0a",
  bgCard: "#0a0a0a",
  bgHeader: "#0a0a0a",

  text: "#e5e5e5",
  textMuted: "#8a8a8a",
  textSubtle: "#555555",
  textFaint: "#333333",

  border: "#1f1f1f",
  borderFocused: "#888888",

  accent: "#ffffff",
  accentDim: "#bbbbbb",

  // Tool category accents.
  toolEdit: "#a8d896", // file edits / writes — sage
  toolRead: "#c0c0c0", // reads / search — bright neutral
  toolBash: "#e0b878", // shell — amber
  toolWeb: "#9cc0e0", // web / search — slate blue
  toolTask: "#caa8da", // subagents / mcp — mauve
  toolError: "#e08080", // errors — soft brick

  // Markdown token accents (used by SyntaxStyle).
  mdCode: "#8ab4d8",   // inline code + code blocks — slate blue
  mdHeading: "#ffffff",
  mdLink: "#8ab4d8",
  mdLinkUrl: "#6b8aa6",
  mdQuote: "#a8a8a8",
  mdListMarker: "#888888",
  mdStrikethrough: "#666666",

  // Diff backgrounds (subtle — only visible on dark bg).
  diffAddBg: "#0f1c0f",
  diffRemBg: "#1c0f0f",
  diffAddFg: "#a8d896",
  diffRemFg: "#e08080",

  // Sidebar runner identity. Active row uses the full hue on the accent bar
  // and on the streaming dot; inactive rows use the idle hue on a faint
  // marker so the runner is still legible at a glance.
  runnerClaude: "#a8d896",
  runnerClaudeIdle: "#506b48",
  runnerCodex: "#e0b878",
  runnerCodexIdle: "#6b5638",

  // Dirty-worktree marker. Distinct enough from both runner hues that it
  // doesn't get confused with the codex amber on a codex session.
  gitDirty: "#c89060",
} as const;
