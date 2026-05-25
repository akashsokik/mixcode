import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import type { Notice } from "../util/notice";
import { ChatItem } from "./ChatItem";

// Slash-command output flows through this one component, so every typographic
// decision here applies uniformly across /help, /context, /sessions, /model,
// /plan, /skills, /mcp, /permissions, /tree, etc. The renderer classifies each
// raw string line and applies BOLD/DIM weight and structural separators on top
// of the existing monochrome palette — no new colors are introduced; the
// hierarchy comes from attribute weight and decorative glyphs alone.

const TREE_CHARS = /[├└│┌┐┘─]/;
// "  /name [...]   help" — leading whitespace, slash-prefixed verb that may
// carry bracketed/angled args or sub-verbs, then a 2+-space column break
// before the help text.
const COMMAND_PATTERN =
  /^(\s+)(\/\S[^\s]*(?:\s+(?:\[[^\]]+\]|<[^>]+>|\S+))*?)(\s{2,})(.+)$/;
// "  key                  description" — indented key/label without a leading
// slash followed by a wide column gap. Used for the "keys" block in /help and
// the rule-format block in /permissions.
const INDENTED_ITEM_PATTERN = /^(\s+)(\S[^\s]*(?:\s\S+)*?)(\s{3,})(.+)$/;
// "label       value" — flush-left key/value pairs used by /context, /model,
// /plan headers, and skill info dumps.
const LABEL_VALUE_PATTERN = /^(\S[\S ]*?)(\s{3,})(.+)$/;
const SENTENCE_TERMINATORS = /[.!?…]$/;

type LineKind =
  | { kind: "blank" }
  | { kind: "heading"; text: string }
  | { kind: "labelValue"; label: string; gap: string; value: string }
  | { kind: "item"; lead: string; name: string; gap: string; help: string }
  | { kind: "tree"; text: string }
  | { kind: "body"; text: string };

function classify(raw: string): LineKind {
  if (!raw.trim()) return { kind: "blank" };
  if (TREE_CHARS.test(raw)) return { kind: "tree", text: raw };

  const cmd = raw.match(COMMAND_PATTERN);
  if (cmd) {
    return { kind: "item", lead: cmd[1], name: cmd[2], gap: cmd[3], help: cmd[4] };
  }

  if (/^\s/.test(raw)) {
    const item = raw.match(INDENTED_ITEM_PATTERN);
    if (item) {
      return {
        kind: "item",
        lead: item[1],
        name: item[2],
        gap: item[3],
        help: item[4],
      };
    }
    return { kind: "body", text: raw };
  }

  const lv = raw.match(LABEL_VALUE_PATTERN);
  if (lv) return { kind: "labelValue", label: lv[1], gap: lv[2], value: lv[3] };

  const isShortPhrase =
    raw.length <= 60 &&
    !/\s{2,}/.test(raw) &&
    !SENTENCE_TERMINATORS.test(raw) &&
    !raw.includes(": ");
  if (isShortPhrase) return { kind: "heading", text: raw };

  return { kind: "body", text: raw };
}

export function NoticeCard({
  notice,
  selected,
  onActivate,
}: {
  notice: Notice;
  selected: boolean;
  onActivate?: () => void;
}) {
  // The notice command can be a bare slash word ("/help") or a slash word
  // plus a status fragment ("/permissions cleared all rules"). Split so the
  // verb gets the strong typographic anchor while the status sits beside it
  // in a quieter weight.
  const trimmed = notice.command.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const tail = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  return (
    <ChatItem id={`notice:${notice.id}`} selected={selected} onActivate={onActivate}>
      <box flexDirection="column">
        <box flexDirection="row" marginBottom={1}>
          <text fg={theme.textFaint}>{"▎ "}</text>
          <text fg={theme.accentDim} attributes={TextAttributes.BOLD}>
            {head}
          </text>
          {tail ? (
            <>
              <text fg={theme.textFaint}>{"  ·  "}</text>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                {tail}
              </text>
            </>
          ) : null}
        </box>
        {notice.lines.map((line, i) => (
          <LineRow key={i} line={line} />
        ))}
      </box>
    </ChatItem>
  );
}

function LineRow({ line }: { line: string }) {
  const kind = classify(line);
  switch (kind.kind) {
    case "blank":
      return <text fg={theme.textMuted}> </text>;
    case "heading":
      return (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"▸ "}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            {kind.text}
          </text>
        </box>
      );
    case "labelValue":
      return (
        <box flexDirection="row">
          <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
            {kind.label}
          </text>
          <text fg={theme.textFaint}>{kind.gap}</text>
          <text fg={theme.textMuted}>{kind.value}</text>
        </box>
      );
    case "item":
      return (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{kind.lead}</text>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            {kind.name}
          </text>
          <text fg={theme.textFaint}>{kind.gap}</text>
          <text fg={theme.textMuted}>{kind.help}</text>
        </box>
      );
    case "tree":
      return <text fg={theme.textFaint}>{kind.text}</text>;
    case "body":
      return <text fg={theme.textMuted}>{kind.text}</text>;
  }
}
