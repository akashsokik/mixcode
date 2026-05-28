import { useCallback, useEffect, useRef, useState } from "react";
import {
  TextAttributes,
  decodePasteBytes,
  stripAnsiSequences,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type {
  ClaudePermissionMode,
  DelegationStats,
  RunnerKind,
} from "../../../shared/events.ts";
import {
  useCompletions,
  useHistory,
  useSlashCompletions,
  type SlashSuggestion,
} from "../state/prompt";
import { theme } from "../theme";
import { claudeModeLabel } from "../util/notice";
import { parseSlash } from "../util/slash";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

function isEnterKey(name: string | undefined): boolean {
  return !!name && ENTER_KEYS.has(name);
}

// Pasted blobs bigger than this collapse to a placeholder so they don't fill
// the prompt. Multi-line pastes always collapse regardless of length.
const PASTE_PLACEHOLDER_THRESHOLD = 200;
const PASTE_PLACEHOLDER_RE = /\[Pasted Text \+\d+ lines, \+\d+ words\]/g;

// Plain enter submits; multiple chords insert a newline so the binding works
// across terminals with very different modifier support:
//   - shift+enter        kitty keyboard terminals (iTerm2, ghostty, wezterm)
//   - option/alt+enter   macOS convention; iTerm2/Terminal.app deliver this
//                        as meta+return
//   - ctrl+j (linefeed)  universal fallback; every terminal sends \n for ^J
// Legacy terminals (Terminal.app without modifyOtherKeys) cannot distinguish
// shift+enter from plain enter at all, so the other chords are what users on
// those terminals will reach for.
const PROMPT_KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "kpenter", meta: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
];

const MAX_PROMPT_ROWS = 8;

type PromptProps = {
  focused: boolean;
  onSubmit: (text: string) => void;
  hint?: string;
  locked?: boolean;
  streaming?: boolean;
  onInterrupt?: () => void;
  runner?: RunnerKind | null;
  onCycleRunner?: () => void;
  claudeMode?: ClaudePermissionMode;
  onCycleClaudeMode?: () => void;
  modelLabel?: string | null;
  contextPercent?: number | null;
  projectLabel?: string | null;
  branch?: { name: string; dirty: boolean } | null;
  delegations?: DelegationStats | null;
  sessionPill?: { name: string; streaming: number } | null;
  // Dynamic slash suggestions appended below the static SLASH_COMMANDS list —
  // typically the active session's skills surfaced as `/skill-name` entries.
  slashExtras?: SlashSuggestion[];
  // Generic key/value strip rendered above the prompt box, right-aligned.
  // Caller decides what to surface (last-turn tokens, model lineup, etc).
  // Capped at META_PAIR_LIMIT so the row stays single-line on narrow terminals.
  metaPairs?: MetaPair[];
};

export type MetaPair = { label: string; value: string };

const META_PAIR_LIMIT = 3;

export function Prompt({
  focused,
  onSubmit,
  hint,
  locked,
  streaming,
  onInterrupt,
  runner,
  onCycleRunner,
  claudeMode,
  onCycleClaudeMode,
  modelLabel,
  contextPercent,
  projectLabel,
  branch,
  delegations,
  sessionPill,
  slashExtras,
  metaPairs,
}: PromptProps) {
  const [text, setText] = useState("");
  const [inputFocused, setInputFocused] = useState(focused && !locked);
  const inputRef = useRef<TextareaRenderable>(null);
  // Raw bodies of multi-line / long pastes, in insertion order. Each one is
  // represented in the textarea as `[Pasted Text +N lines]`. On submit we walk
  // the prompt left-to-right and re-inflate the i-th placeholder with the i-th
  // blob, so the model sees the real content and the user sees a tidy chip.
  const pastedBlobs = useRef<string[]>([]);
  const history = useHistory();
  const completions = useCompletions();
  const slash = useSlashCompletions(slashExtras);

  // Re-sync React state from the textarea after a programmatic write or paste
  // — the textarea owns the editable buffer, but the slash/completion effects
  // below key off `text`, so they need a mirror.
  const syncFromBuffer = useCallback(() => {
    const next = inputRef.current?.plainText ?? "";
    setText(next);
  }, []);

  const writeBuffer = useCallback((value: string) => {
    const el = inputRef.current;
    if (!el) return;
    el.replaceText(value);
    el.cursorOffset = value.length;
    setText(value);
  }, []);

  useEffect(() => {
    setInputFocused(focused && !locked);
  }, [focused, locked]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onFocus = () => setInputFocused(true);
    const onBlur = () => setInputFocused(false);
    input.on("focused", onFocus);
    input.on("blurred", onBlur);
    return () => {
      input.off("focused", onFocus);
      input.off("blurred", onBlur);
    };
  }, [locked]);

  useEffect(() => {
    // Accept skill-style names (`/use-railway`, `/superpowers:brainstorming`)
    // while typing, not just `\w+`. The same character class as parseSlash.
    const slashMatch = text.match(/^\/([A-Za-z0-9][A-Za-z0-9:_.-]*)?$/);
    if (slashMatch) {
      if (completions.active) completions.close();
      const q = slashMatch[1] ?? "";
      if (!slash.active) slash.open(q);
      else slash.setQuery(q);
      return;
    }
    if (slash.active) slash.close();

    const fileMatch = text.match(/(?:^|\s)@([^\s]*)$/);
    if (fileMatch) {
      if (!completions.active) completions.open(fileMatch[1]);
      else completions.setQuery(fileMatch[1]);
    } else if (completions.active) {
      completions.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    if (history.value != null) writeBuffer(history.value);
  }, [history.value, writeBuffer]);

  // Bracketed-paste interception. Runs BEFORE the textarea's own paste
  // handler (global listeners get priority in InternalKeyHandler) so we can
  // preventDefault and substitute a placeholder for content that would
  // overwhelm the prompt — multi-line pastes always, and anything past
  // PASTE_PLACEHOLDER_THRESHOLD chars on a single line. Short single-line
  // pastes fall through to the textarea unchanged so URLs etc. paste raw.
  usePaste((event) => {
    if (!focused || locked) return;
    const el = inputRef.current;
    if (!el) return;
    const raw = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (!raw) return;
    const hasNewline = /\r?\n/.test(raw);
    if (!hasNewline && raw.length <= PASTE_PLACEHOLDER_THRESHOLD) return;
    event.preventDefault();
    const normalized = raw.replace(/\r\n?/g, "\n");
    const lineCount = normalized.split("\n").length;
    const wordCount = countWords(normalized);
    const placeholder = `[Pasted Text +${lineCount} lines, +${wordCount} words]`;
    pastedBlobs.current.push(normalized);
    el.insertText(placeholder);
    syncFromBuffer();
  });

  useKeyboard((key) => {
    if (!focused || locked) return;
    const isEnter = isEnterKey(key.name);

    // shift+tab cycles Claude permission mode. Handle BEFORE the plain-tab
    // completion branch so completion doesn't steal it.
    if (key.name === "tab" && key.shift) {
      if (!slash.active && !completions.active && onCycleClaudeMode) {
        onCycleClaudeMode();
      }
      return;
    }

    // plain tab (no menu open) cycles the active runner: claude → codex →
    // vercel → claude. When a slash/completion menu is open the branches
    // below claim tab for applying the selection instead.
    if (key.name === "tab" && !slash.active && !completions.active) {
      if (onCycleRunner) onCycleRunner();
      return;
    }

    if (key.name === "escape") {
      // Priority while the prompt is focused:
      //   1. close an open menu (slash → completions)
      //   2. interrupt the active turn if one is streaming
      if (slash.active) slash.close();
      else if (completions.active) completions.close();
      else if (streaming && onInterrupt) onInterrupt();
      return;
    }

    if (slash.active) {
      if (key.name === "up") return slash.moveUp();
      if (key.name === "down") return slash.moveDown();
      if (key.name === "tab") {
        applySlashCompletion();
        return;
      }
      if (isEnter && slash.selected && !key.shift) {
        // The textarea's enter→submit binding would otherwise fire too; block
        // it so applying a slash completion doesn't also submit the prompt.
        key.preventDefault();
        applySlashCompletion();
        return;
      }
    }

    if (completions.active) {
      if (key.name === "up") return completions.moveUp();
      if (key.name === "down") return completions.moveDown();
      if (key.name === "tab") {
        applyCompletion();
        return;
      }
      if (isEnter && completions.selected && !key.shift) {
        key.preventDefault();
        applyCompletion();
        return;
      }
    }

    if (!completions.active && !slash.active) {
      // shift+up / shift+down belong to the App-level chat-item navigator;
      // preventDefault stops the textarea from also painting a "select-up/
      // down" range inside the prompt buffer while the user is jumping
      // through tool cards.
      if (key.shift && (key.name === "up" || key.name === "down")) {
        key.preventDefault();
        return;
      }
      // History recall only when the prompt is single-line — otherwise arrow
      // keys belong to the textarea's cursor so multi-line drafts stay
      // navigable.
      const singleLine = !text.includes("\n");
      if (key.name === "up" && singleLine) {
        key.preventDefault();
        return history.movePrev();
      }
      if (key.name === "down" && singleLine) {
        key.preventDefault();
        return history.moveNext();
      }
    }
  });

  function applyCompletion(): void {
    const selected = completions.selected;
    if (!selected) return;
    const next = text.replace(/(?:^|\s)@([^\s]*)$/, (match) => {
      const prefix = match.startsWith("@") ? "" : " ";
      return `${prefix}@${selected} `;
    });
    writeBuffer(next);
    completions.close();
  }

  function applySlashCompletion(): void {
    const sel = slash.selected;
    if (!sel) return;
    writeBuffer(`${sel.name} `);
    slash.close();
  }

  function handleSubmit(): void {
    const value = inputRef.current?.plainText ?? text;
    const expanded = expandPastes(value, pastedBlobs.current);
    const trimmed = expanded.trim();
    if (!trimmed) return;
    history.push(trimmed);
    onSubmit(trimmed);
    pastedBlobs.current = [];
    writeBuffer("");
    history.reset();
  }

  const completionRows = Math.min(completions.matches.length, 6);
  const slashView = sliceSlashViewport(slash.matches, slash.selectedIndex);
  const slashMenuActive = slash.active && isSlashQuery(text);
  const completionMenuActive = completions.active && isFileQuery(text);
  const visualFocused = focused && !locked && inputFocused;
  const promptRows = Math.min(
    MAX_PROMPT_ROWS,
    Math.max(1, text.split("\n").length),
  );
  const rail = buildPromptRail({
    text,
    locked: !!locked,
    streaming: !!streaming,
    runner: runner ?? null,
    claudeMode,
    slashMenuActive,
    slashSelected: slash.selected,
    completionMenuActive,
    completionSelected: completions.selected,
    slashExtras: slashExtras ?? [],
    modelLabel: modelLabel ?? null,
    contextPercent: contextPercent ?? null,
    projectLabel: projectLabel ?? null,
    branch: branch ?? null,
    sessionPill: sessionPill ?? null,
  });

  return (
    <box flexDirection="column" flexShrink={0}>
      <MetaRow pairs={metaPairs} />
      {slash.active && slash.matches.length > 0 && (
        <box
          flexDirection="column"
          borderStyle="rounded"
          borderColor={theme.border}
          backgroundColor={theme.bgPanel}
          paddingLeft={1}
          paddingRight={1}
          height={slashView.rows.length + (slashView.tail > 0 ? 1 : 0) + 2}
        >
          {slashView.rows.map((m, i) => {
            const absolute = slashView.start + i;
            const isSel = absolute === slash.selectedIndex;
            return (
              <box key={m.name} flexDirection="row">
                <text fg={isSel ? theme.text : theme.textMuted}>
                  {isSel ? "› " : "  "}
                  {m.name}
                </text>
                <text fg={theme.textFaint}>{"  " + m.help}</text>
              </box>
            );
          })}
          {slashView.tail > 0 && (
            <text fg={theme.textFaint}>{`  … ${slashView.tail} more`}</text>
          )}
        </box>
      )}
      {!slash.active && completions.active && completions.matches.length > 0 && (
        <box
          flexDirection="column"
          borderStyle="rounded"
          borderColor={theme.border}
          backgroundColor={theme.bgPanel}
          paddingLeft={1}
          paddingRight={1}
          height={completionRows + 2}
        >
          {completions.matches.slice(0, completionRows).map((m, i) => (
            <text
              key={m}
              fg={i === completions.selectedIndex ? theme.text : theme.textMuted}
            >
              {i === completions.selectedIndex ? "› " : "  "}
              {m}
            </text>
          ))}
        </box>
      )}
      <box
        flexDirection="column"
        borderStyle="rounded"
        borderColor={visualFocused ? theme.borderFocused : theme.border}
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" height={promptRows}>
          {runner && (
            <>
              <text fg={theme.textFaint}>{"["}</text>
              <text
                fg={
                  runner === "claude"
                    ? theme.toolBash
                    : runner === "codex"
                      ? theme.toolWeb
                      : theme.runnerVercel
                }
                attributes={TextAttributes.BOLD}
              >
                {runner}
              </text>
              <text fg={theme.textFaint}>{"] "}</text>
            </>
          )}
          <text fg={visualFocused ? theme.accent : theme.textSubtle}>{"› "}</text>
          {locked ? (
            <text fg={theme.textFaint}>
              {text || "input disabled — palette/permission overlay active"}
            </text>
          ) : (
            <textarea
              ref={inputRef}
              placeholder={hint ?? "ask anything — / for commands"}
              focused={focused}
              keyBindings={PROMPT_KEY_BINDINGS}
              onSubmit={handleSubmit}
              onContentChange={syncFromBuffer}
              flexGrow={1}
            />
          )}
        </box>
        <PromptRail rail={rail} />
        <DelegationRow stats={delegations ?? null} />
      </box>
    </box>
  );
}

// Whitespace-separated tokens; empty/whitespace-only input is 0 words.
function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// Walks the visible prompt text left-to-right and substitutes each
// `[Pasted Text …]` placeholder with the next stashed raw blob. If
// the user manually deleted a placeholder, its blob silently drops out (we
// never resurrect it). Extra placeholders past the blob count stay as-is so
// the model still sees that something was there.
function expandPastes(text: string, blobs: string[]): string {
  if (blobs.length === 0) return text;
  let i = 0;
  return text.replace(PASTE_PLACEHOLDER_RE, (match) => {
    if (i < blobs.length) return blobs[i++];
    return match;
  });
}

type RailSegment = {
  value: string;
  color: string;
  bold?: boolean;
};

type PromptRailState = {
  segments: RailSegment[];
  keys: string[];
};

// Generic key-value strip rendered above the prompt box, right-aligned.
// Hidden when no pairs are supplied. Caps at META_PAIR_LIMIT so the row stays
// a single line even on narrow terminals.
function MetaRow({ pairs }: { pairs: MetaPair[] | undefined }) {
  if (!pairs || pairs.length === 0) return null;
  const limited = pairs.slice(0, META_PAIR_LIMIT);
  return (
    <box flexDirection="row" height={1}>
      <box flexGrow={1} />
      {limited.map((pair, i) => (
        <box key={`${pair.label}-${i}`} flexDirection="row" flexShrink={0}>
          {i > 0 && <Dot />}
          <text fg={theme.textFaint}>{`${pair.label}: `}</text>
          <text fg={theme.textMuted}>{pair.value}</text>
        </box>
      ))}
    </box>
  );
}

function PromptRail({ rail }: { rail: PromptRailState }) {
  return (
    <box flexDirection="row" height={1}>
      {rail.segments.map((seg, i) => (
        <box key={`${seg.value}-${i}`} flexDirection="row" flexShrink={0}>
          {i > 0 && <Dot />}
          <text
            fg={seg.color}
            attributes={seg.bold ? TextAttributes.BOLD : undefined}
          >
            {seg.value}
          </text>
        </box>
      ))}
      {rail.keys.length > 0 && <box flexGrow={1} />}
      {rail.keys.map((key, i) => (
        <box key={key} flexDirection="row" flexShrink={0}>
          {i > 0 && <Dot />}
          <text fg={theme.textMuted}>{key}</text>
        </box>
      ))}
    </box>
  );
}

function buildPromptRail({
  text,
  locked,
  streaming,
  runner,
  claudeMode,
  slashMenuActive,
  slashSelected,
  completionMenuActive,
  completionSelected,
  slashExtras,
  modelLabel,
  contextPercent,
  projectLabel,
  branch,
  sessionPill,
}: {
  text: string;
  locked: boolean;
  streaming: boolean;
  runner: RunnerKind | null;
  claudeMode: ClaudePermissionMode | undefined;
  slashMenuActive: boolean;
  slashSelected: SlashSuggestion | null;
  completionMenuActive: boolean;
  completionSelected: string | null;
  slashExtras: SlashSuggestion[];
  modelLabel: string | null;
  contextPercent: number | null;
  projectLabel: string | null;
  branch: { name: string; dirty: boolean } | null;
  sessionPill: { name: string; streaming: number } | null;
}): PromptRailState {
  if (locked) {
    return {
      segments: [
        { value: "locked", color: theme.toolError, bold: true },
        { value: "overlay owns input", color: theme.textMuted },
      ],
      keys: [],
    };
  }

  if (slashMenuActive) {
    return {
      segments: [
        { value: "complete", color: theme.toolTask, bold: true },
        {
          value: slashSelected
            ? `${slashSelected.name} · ${slashSelected.help}`
            : "slash command",
          color: theme.textMuted,
        },
      ],
      keys: ["↑↓", "tab", "esc"],
    };
  }

  if (completionMenuActive) {
    return {
      segments: [
        { value: "attach", color: theme.toolRead, bold: true },
        {
          value: completionSelected ? `@${completionSelected}` : "file reference",
          color: theme.textMuted,
        },
      ],
      keys: ["↑↓", "tab", "esc"],
    };
  }

  const trimmed = text.trim();
  const command = trimmed.startsWith("/") ? parseSlash(trimmed) : null;
  if (command) {
    return {
      segments: [
        {
          value: describeSlashCommand(command, runner, slashExtras),
          color: command.type === "unknown" ? theme.toolError : theme.toolBash,
          bold: true,
        },
      ],
      keys: command.type === "unknown"
        ? ["↵ warn", "/help"]
        : streaming
          ? ["↵ run", "esc stop"]
          : ["↵ run"],
    };
  }

  const segments: RailSegment[] = [];
  if (modelLabel) segments.push({ value: modelLabel, color: theme.textMuted });
  if (projectLabel) segments.push({ value: projectLabel, color: theme.textMuted });
  if (branch?.name) {
    segments.push({
      value: branch.dirty ? `${branch.name} *` : branch.name,
      color: branch.dirty ? theme.toolBash : theme.textMuted,
    });
  }

  if (runner === "claude" && claudeMode && claudeMode !== "default") {
    segments.push({
      value: claudeModeLabel(claudeMode),
      color: claudeMode === "bypassPermissions" ? theme.toolError : theme.textMuted,
      bold: claudeMode === "bypassPermissions",
    });
  }

  const fileRefs = countFileReferences(text);
  if (fileRefs > 0) {
    segments.push({
      value: `${fileRefs} file${fileRefs === 1 ? "" : "s"}`,
      color: theme.toolRead,
    });
  }

  if (contextPercent != null && contextPercent > 0) {
    segments.push({ value: `${contextPercent}%`, color: theme.textMuted });
  }

  if (sessionPill) {
    segments.push({
      value: sessionPill.streaming > 0
        ? `${truncate(sessionPill.name, 28)} ●${sessionPill.streaming}`
        : truncate(sessionPill.name, 28),
      color: sessionPill.streaming > 0 ? theme.toolError : theme.textMuted,
    });
  }

  if (segments.length === 0) {
    segments.push({ value: runner ?? "ready", color: runnerColor(runner), bold: !!runner });
  }

  const keys = ["↵ send", "tab runner"];
  if (streaming) keys.push("esc stop");
  if (runner === "claude") keys.push("⇧tab mode");
  else keys.push("/ commands", "@ files");

  return { segments, keys };
}

function describeSlashCommand(
  command: NonNullable<ReturnType<typeof parseSlash>>,
  runner: RunnerKind | null,
  slashExtras: SlashSuggestion[],
): string {
  switch (command.type) {
    case "claude":
    case "codex":
    case "vercel":
      return command.type;
    case "switch":
      return "sessions";
    case "clear":
      return "clear";
    case "help":
      return "help";
    case "context":
      return "context";
    case "sessions":
      return "sessions";
    case "tree":
      return "tree";
    case "consensus":
      return "consensus";
    case "permissions":
      return describePermissionsAction(command.action);
    case "model":
      return describeModelAction(command.action, runner);
    case "effort":
      return describeEffortAction(command.action);
    case "plan":
      return describePlanAction(command.action);
    case "skills":
      return describeSkillsAction(command.action);
    case "mcp":
      return describeMcpAction(command.action);
    case "new":
      return "new session";
    case "unknown": {
      const extra = slashExtras.find((s) => s.name.slice(1) === command.name);
      return extra ? `skill ${extra.name}` : `unknown /${command.name}`;
    }
  }
}

function describePermissionsAction(
  action: Extract<NonNullable<ReturnType<typeof parseSlash>>, { type: "permissions" }>["action"],
): string {
  switch (action.kind) {
    case "list": return "permissions";
    case "add": return "allow rule";
    case "remove": return "remove rule";
    case "clear": return "clear permissions";
  }
}

function describeModelAction(
  action: Extract<NonNullable<ReturnType<typeof parseSlash>>, { type: "model" }>["action"],
  runner: RunnerKind | null,
): string {
  switch (action.kind) {
    case "picker": return "model picker";
    case "show": return "models";
    case "set": return `${runner ?? "active"} model`;
    case "setRunner": return `${action.runner} model`;
    case "reset": return `reset ${runner ?? "active"} model`;
    case "resetRunner": return `reset ${action.runner} model`;
  }
}

function describeEffortAction(
  action: Extract<NonNullable<ReturnType<typeof parseSlash>>, { type: "effort" }>["action"],
): string {
  switch (action.kind) {
    case "picker": return "effort";
    case "show": return "effort: show";
    case "set": return `effort: ${action.effort}`;
    case "setRunner": return `${action.runner} effort: ${action.effort}`;
    case "reset": return "effort: reset";
    case "resetRunner": return `${action.runner} effort: reset`;
  }
}

function describePlanAction(
  action: Extract<NonNullable<ReturnType<typeof parseSlash>>, { type: "plan" }>["action"],
): string {
  switch (action.kind) {
    case "toggle": return "toggle plan";
    case "on": return "plan on";
    case "off": return "plan off";
    case "status": return "plan status";
  }
}

function describeSkillsAction(
  action: Extract<NonNullable<ReturnType<typeof parseSlash>>, { type: "skills" }>["action"],
): string {
  switch (action.kind) {
    case "list": return "skills";
    case "add": return "skill add";
    case "import": return "skill import";
    case "remove": return "skill remove";
    case "info": return "skill info";
  }
}

function describeMcpAction(
  action: Extract<NonNullable<ReturnType<typeof parseSlash>>, { type: "mcp" }>["action"],
): string {
  switch (action.kind) {
    case "list": return "mcp";
    case "add": return "mcp add";
    case "remove": return "mcp remove";
    case "test": return "mcp test";
  }
}

function runnerColor(runner: RunnerKind | null): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  if (runner === "vercel") return theme.runnerVercel;
  return theme.text;
}

function isSlashQuery(text: string): boolean {
  return /^\/([A-Za-z0-9][A-Za-z0-9:_.-]*)?$/.test(text);
}

function isFileQuery(text: string): boolean {
  return /(?:^|\s)@([^\s]*)$/.test(text);
}

function countFileReferences(text: string): number {
  return (text.match(/(?:^|\s)@\S+/g) ?? []).length;
}

// Second meta row, rendered only when this session has delegated at least
// once. Shows lifetime total, currently-running peers (with name), and
// terminal-state counts. Hidden completely when total === 0 so the prompt
// stays a single row for non-orchestrating sessions.
function DelegationRow({ stats }: { stats: DelegationStats | null }) {
  if (!stats || stats.total === 0) return null;

  const segments: Array<{ label: string; value: string; color: string }> = [];
  // Total first — it's the primary "I've delegated N times" metric.
  segments.push({
    label: "peers",
    value: String(stats.total),
    color: theme.toolTask,
  });
  if (stats.running > 0) {
    const peer = stats.activePeer ? ` ${stats.activePeer}` : "";
    segments.push({
      label: "running",
      value: `${stats.running}${peer}`,
      color: stats.activePeer === "claude"
        ? theme.runnerClaude
        : stats.activePeer === "codex"
          ? theme.runnerCodex
          : stats.activePeer === "vercel"
            ? theme.runnerVercel
            : theme.text,
    });
  }
  if (stats.ok > 0) {
    segments.push({ label: "ok", value: String(stats.ok), color: theme.toolEdit });
  }
  if (stats.error > 0) {
    segments.push({
      label: "err",
      value: String(stats.error),
      color: theme.toolError,
    });
  }
  if (stats.cancelled > 0) {
    segments.push({
      label: "cxl",
      value: String(stats.cancelled),
      color: theme.textMuted,
    });
  }

  return (
    <box flexDirection="row" height={1}>
      {segments.map((seg, i) => (
        <box key={seg.label} flexDirection="row">
          {i > 0 && <Dot />}
          <text fg={theme.textMuted}>{`${seg.label} `}</text>
          <text fg={seg.color} attributes={TextAttributes.BOLD}>{seg.value}</text>
        </box>
      ))}
    </box>
  );
}

function Dot() {
  return <text fg={theme.textSubtle}>{"  ·  "}</text>;
}

function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return `${s.slice(0, n - 1)}…`;
}

// Sliding window over the slash-suggestion list. Mirrors the Palette viewport
// fix: the old static `slice(0, 8)` stranded the cursor when it moved past row
// 7, so arrow-down past the 8th entry had no visible effect. Anchors the
// selected row ~3 rows below the top so it stays in view while scrolling.
const SLASH_VIEWPORT_ROWS = 8;
const SLASH_VIEWPORT_ANCHOR = 3;
function sliceSlashViewport(
  items: SlashSuggestion[],
  selected: number,
): { rows: SlashSuggestion[]; start: number; tail: number } {
  const start = Math.max(
    0,
    Math.min(
      selected - SLASH_VIEWPORT_ANCHOR,
      Math.max(0, items.length - SLASH_VIEWPORT_ROWS),
    ),
  );
  const end = Math.min(items.length, start + SLASH_VIEWPORT_ROWS);
  return { rows: items.slice(start, end), start, tail: items.length - end };
}
