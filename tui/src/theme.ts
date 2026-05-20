// Monochrome palette. Everything is grayscale; emphasis comes from
// brightness + BOLD attribute, not hue.

export const theme = {
  bg: "#0a0a0a",
  bgPanel: "#111111",
  bgCard: "#161616",
  bgHeader: "#0a0a0a",

  text: "#e5e5e5",
  textMuted: "#888888",
  textSubtle: "#555555",
  textFaint: "#333333",

  border: "#2a2a2a",
  borderFocused: "#888888",

  accent: "#ffffff",
  accentDim: "#bbbbbb",
} as const;
