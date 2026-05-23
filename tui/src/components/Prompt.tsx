import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
  ClaudePermissionMode,
  DelegationStats,
  RunnerKind,
} from "../../../shared/events.ts";
import {
  useCompletions,
  useHistory,
  useSlashCompletions,
} from "../state/prompt";
import { theme } from "../theme";
import { claudeModeLabel } from "../util/notice";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

function isEnterKey(name: string | undefined): boolean {
  return !!name && ENTER_KEYS.has(name);
}

type PromptProps = {
  focused: boolean;
  onSubmit: (text: string) => void;
  hint?: string;
  locked?: boolean;
  streaming?: boolean;
  onInterrupt?: () => void;
  runner?: RunnerKind | null;
  claudeMode?: ClaudePermissionMode;
  onCycleClaudeMode?: () => void;
  modelLabel?: string | null;
  contextPercent?: number | null;
  projectLabel?: string | null;
  branch?: { name: string; dirty: boolean } | null;
  delegations?: DelegationStats | null;
  sessionPill?: { name: string; streaming: number } | null;
};

export function Prompt({
  focused,
  onSubmit,
  hint,
  locked,
  streaming,
  onInterrupt,
  runner,
  claudeMode,
  onCycleClaudeMode,
  modelLabel,
  contextPercent,
  projectLabel,
  branch,
  delegations,
  sessionPill,
}: PromptProps) {
  const [text, setText] = useState("");
  const history = useHistory();
  const completions = useCompletions();
  const slash = useSlashCompletions();

  useEffect(() => {
    const slashMatch = text.match(/^\/(\w*)$/);
    if (slashMatch) {
      if (completions.active) completions.close();
      if (!slash.active) slash.open(slashMatch[1]);
      else slash.setQuery(slashMatch[1]);
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
    if (history.value != null) setText(history.value);
  }, [history.value]);

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
      if (key.name === "tab") return applySlashCompletion();
      if (isEnter && slash.selected) {
        applySlashCompletion();
        return;
      }
    }

    if (completions.active) {
      if (key.name === "up") return completions.moveUp();
      if (key.name === "down") return completions.moveDown();
      if (key.name === "tab") return applyCompletion();
      if (isEnter && completions.selected) {
        applyCompletion();
        return;
      }
    }

    if (isEnter && !completions.active && !slash.active) {
      handleSubmit(text);
      return;
    }

    if (!completions.active && !slash.active) {
      if (key.name === "up") return history.movePrev();
      if (key.name === "down") return history.moveNext();
    }
  });

  function applyCompletion(): void {
    const selected = completions.selected;
    if (!selected) return;
    const next = text.replace(/(?:^|\s)@([^\s]*)$/, (match) => {
      const prefix = match.startsWith("@") ? "" : " ";
      return `${prefix}@${selected} `;
    });
    setText(next);
    completions.close();
  }

  function applySlashCompletion(): void {
    const sel = slash.selected;
    if (!sel) return;
    setText(`${sel.name} `);
    slash.close();
  }

  function handleSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    history.push(trimmed);
    onSubmit(trimmed);
    setText("");
    history.reset();
  }

  const completionRows = Math.min(completions.matches.length, 6);
  const slashRows = Math.min(slash.matches.length, 8);

  return (
    <box flexDirection="column" flexShrink={0}>
      {slash.active && slash.matches.length > 0 && (
        <box
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.border}
          backgroundColor={theme.bgPanel}
          paddingLeft={1}
          paddingRight={1}
          height={slashRows + 2}
        >
          {slash.matches.slice(0, slashRows).map((m, i) => {
            const isSel = i === slash.selectedIndex;
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
        </box>
      )}
      {!slash.active && completions.active && completions.matches.length > 0 && (
        <box
          flexDirection="column"
          borderStyle="single"
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
        borderStyle="single"
        borderColor={focused ? theme.borderFocused : theme.border}
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" height={1}>
          {runner && (
            <>
              <text fg={theme.textFaint}>{"["}</text>
              <text
                fg={runner === "claude" ? theme.toolBash : theme.toolWeb}
                attributes={TextAttributes.BOLD}
              >
                {runner}
              </text>
              <text fg={theme.textFaint}>{"] "}</text>
            </>
          )}
          <text fg={focused && !locked ? theme.accent : theme.textSubtle}>{"› "}</text>
          {locked ? (
            <text fg={theme.textFaint}>
              {text || "input disabled — palette/permission overlay active"}
            </text>
          ) : (
            <input
              value={text}
              onInput={setText}
              focused={focused}
              placeholder={
                placeholderForMode(claudeMode, runner) ??
                hint ??
                "ask anything — /switch flips runners"
              }
              flexGrow={1}
            />
          )}
        </box>
        <MetaRow
          runner={runner ?? null}
          claudeMode={claudeMode}
          modelLabel={modelLabel ?? null}
          contextPercent={contextPercent ?? null}
          projectLabel={projectLabel ?? null}
          branch={branch ?? null}
          streaming={!!streaming}
          sessionPill={sessionPill ?? null}
        />
        <DelegationRow stats={delegations ?? null} />
      </box>
    </box>
  );
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
    <box flexDirection="row" height={1} paddingLeft={1}>
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

function MetaRow({
  runner,
  claudeMode,
  modelLabel,
  contextPercent,
  projectLabel,
  branch,
  streaming,
  sessionPill,
}: {
  runner: RunnerKind | null;
  claudeMode: ClaudePermissionMode | undefined;
  modelLabel: string | null;
  contextPercent: number | null;
  projectLabel: string | null;
  branch: { name: string; dirty: boolean } | null;
  streaming: boolean;
  sessionPill: { name: string; streaming: number } | null;
}) {
  if (!runner) return null;
  const showMode = runner === "claude" && claudeMode && claudeMode !== "default";
  const showCtx = contextPercent != null && contextPercent > 0;
  const showCycleHint = runner === "claude";

  const segments: Array<"model" | "project" | "branch" | "mode" | "ctx" | "sess"> = [];
  if (modelLabel) segments.push("model");
  if (projectLabel) segments.push("project");
  if (branch?.name) segments.push("branch");
  if (showMode) segments.push("mode");
  if (showCtx) segments.push("ctx");
  if (sessionPill) segments.push("sess");

  return (
    <box flexDirection="row" height={1} paddingLeft={1}>
      {segments.map((seg, i) => (
        <box key={seg} flexDirection="row">
          {i > 0 && <Dot />}
          {seg === "model" && <text fg={theme.textMuted}>{modelLabel}</text>}
          {seg === "project" && <text fg={theme.textMuted}>{projectLabel}</text>}
          {seg === "branch" && (
            <>
              <text fg={theme.toolBash}>{branch!.name}</text>
              {branch!.dirty && <text fg={theme.toolError}>{" *"}</text>}
            </>
          )}
          {seg === "mode" && (
            <text fg={theme.textMuted}>{claudeModeLabel(claudeMode!)}</text>
          )}
          {seg === "ctx" && (
            <text fg={theme.textMuted}>{`${contextPercent}%`}</text>
          )}
          {seg === "sess" && (
            <>
              <text fg={theme.textMuted}>{truncate(sessionPill!.name, 28)}</text>
              {sessionPill!.streaming > 0 && (
                <text fg={theme.toolError}>{`●${sessionPill!.streaming}`}</text>
              )}
            </>
          )}
        </box>
      ))}
      <box flexGrow={1} />
      {streaming && (
        <>
          <text fg={theme.toolError} attributes={TextAttributes.BOLD}>{"esc"}</text>
          <text fg={theme.textMuted}>{" stop"}</text>
          {showCycleHint && <Dot />}
        </>
      )}
      {showCycleHint && (
        <text fg={theme.textMuted}>{"shift+tab mode"}</text>
      )}
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

function placeholderForMode(
  mode: ClaudePermissionMode | undefined,
  runner: RunnerKind | null | undefined,
): string | null {
  if (runner !== "claude") return null;
  if (mode === "plan") return "plan mode — Claude will propose a plan, no tools will run";
  if (mode === "acceptEdits") return "accept-edits mode — Claude auto-allows file edits";
  if (mode === "bypassPermissions")
    return "BYPASS mode — Claude will run every tool without asking";
  return null;
}
