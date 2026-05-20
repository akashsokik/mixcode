import { SyntaxStyle } from "@opentui/core";
import { theme } from "./theme";

// Custom markdown SyntaxStyle. OpenTUI's markdown renderer looks up these
// token groups (discovered in the core bundle): markup.heading, markup.strong,
// markup.italic, markup.raw (inline code + code blocks), markup.link,
// markup.link.label, markup.link.url, markup.list, markup.quote,
// markup.strikethrough. Anything we don't register falls back to "default".

export const markdownStyle = SyntaxStyle.fromStyles({
  default: { fg: theme.text },

  "markup.heading": { fg: theme.mdHeading, bold: true },
  "markup.strong": { fg: theme.accent, bold: true },
  "markup.italic": { fg: theme.text, italic: true },
  "markup.strikethrough": { fg: theme.mdStrikethrough, dim: true },

  "markup.raw": { fg: theme.mdCode },
  "markup.raw.block": { fg: theme.mdCode },

  "markup.link": { fg: theme.mdLink, underline: true },
  "markup.link.label": { fg: theme.mdLink },
  "markup.link.url": { fg: theme.mdLinkUrl, underline: true },

  "markup.list": { fg: theme.mdListMarker },
  "markup.quote": { fg: theme.mdQuote, italic: true },
});
