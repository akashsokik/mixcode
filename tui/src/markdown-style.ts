import { SyntaxStyle, type MarkdownTableOptions } from "@opentui/core";
import { theme } from "./theme";

// Custom markdown SyntaxStyle. OpenTUI's markdown renderer looks up these
// token groups (discovered in the core bundle): markup.heading, markup.strong,
// markup.italic, markup.raw (inline code + code blocks), markup.link,
// markup.link.label, markup.link.url, markup.list, markup.quote,
// markup.strikethrough. Anything we don't register falls back to "default".

// Default `style: "grid"` boxes every table in heavy `┌─┐│└─┘` borders which
// dominates the transcript and copies badly out of the terminal (cells wrap
// vertically and the box characters bleed into the paste). Switch to
// borderless columns + word wrap so chat-style tables read like a denser,
// space-separated layout — closer to how the model probably intended them.
export const markdownTableOptions: MarkdownTableOptions = {
  style: "columns",
  wrapMode: "word",
};

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
