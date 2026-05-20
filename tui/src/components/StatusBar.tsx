import { TextAttributes } from "@opentui/core";
import type { WSStatus } from "../api/ws";
import type {
  ClaudePermissionMode,
  Session,
} from "../../../shared/events.ts";
import { theme } from "../theme";
import { claudeModeLabel } from "../util/notice";
import {
  assistantMessageCount,
  contextLimit,
  formatTokens,
  latestContextTokens,
  prettyModelLabel,
  progressBar,
  projectName,
} from "../util/status";

type Props = {
  status: WSStatus;
  active: Session | null;
  sessionCount: number;
  focus: "prompt" | "browse";
  width: number;
};

export function StatusBar({ status, active, focus, width }: Props) {
  const compact = width < 92;
  const inset = 4;

  const projName = active ? projectName(active.cwd) : "—";
  const branchPart = active ? branchSegment(active) : null;
  const modelId =
    active && active.activeRunner === "claude"
      ? active.models.claude
      : active?.models.codex;
  const modelLabel = active
    ? prettyModelLabel(modelId, active.activeRunner)
    : "—";

  const tokensUsed = active ? latestContextTokens(active) : 0;
  const limit = active ? contextLimit(modelId, active.activeRunner) : 0;
  const ratio = limit > 0 ? Math.min(1, tokensUsed / limit) : 0;
  const percent = Math.round(ratio * 100);
  const barWidth = compact ? 6 : 10;
  const msgCount = active ? assistantMessageCount(active) : 0;

  const focusChar = focus === "prompt" ? "I" : "N";
  const focusFg = focus === "prompt" ? theme.toolEdit : theme.textMuted;
  const focusLabel = focus === "prompt" ? "insert" : "browse";

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingBottom={1}
      border={["top"]}
      borderStyle="single"
      borderColor={active?.streaming ? theme.borderFocused : theme.border}
    >
      <box
        height={1}
        flexDirection="row"
        alignItems="center"
        paddingLeft={inset}
        paddingRight={inset}
      >
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          {projName}
        </text>
        {branchPart && (
          <>
            <Pipe />
            <text fg={theme.toolBash}>{branchPart.name}</text>
            {branchPart.dirty && <text fg={theme.toolError}>{" *"}</text>}
          </>
        )}
        {active && (
          <>
            <Pipe />
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {modelLabel}
            </text>
            <Pipe />
            <text fg={theme.toolEdit}>{progressBar(ratio, barWidth)}</text>
            <text fg={theme.textMuted}>{` ${percent}%`}</text>
            <Pipe />
            <text fg={focusFg} attributes={TextAttributes.BOLD}>
              {focusChar}
            </text>
            <Pipe />
            <text fg={theme.textMuted}>
              {`${formatTokens(tokensUsed)}/${msgCount}`}
            </text>
          </>
        )}
        <box flexGrow={1} />
        <ConnectionDot status={status} />
      </box>
      <box
        height={1}
        flexDirection="row"
        alignItems="center"
        paddingLeft={inset}
        paddingRight={inset}
      >
        <text fg={focusFg} attributes={TextAttributes.BOLD}>{focusLabel}</text>
        {active?.streaming && (
          <>
            <Pipe />
            <text fg={theme.toolError} attributes={TextAttributes.BOLD}>
              {"esc"}
            </text>
            <text fg={theme.textFaint}>{" stop"}</text>
          </>
        )}
        {active && (
          <>
            <Pipe />
            <ClaudeModeIndicator
              active={active}
              claudeMode={active.claudeMode}
            />
          </>
        )}
      </box>
    </box>
  );
}

function ClaudeModeIndicator({
  active,
  claudeMode,
}: {
  active: Session;
  claudeMode: ClaudePermissionMode;
}) {
  if (active.activeRunner !== "claude") {
    return <text fg={theme.textFaint}>{"mode N/A on codex"}</text>;
  }
  const { fg, bold } = styleForMode(claudeMode);
  return (
    <>
      <text fg={fg} attributes={bold ? TextAttributes.BOLD : 0}>
        {claudeModeLabel(claudeMode)}
      </text>
      <text fg={theme.textFaint}>{"  ·  shift+tab to cycle"}</text>
    </>
  );
}

function styleForMode(mode: ClaudePermissionMode): { fg: string; bold: boolean } {
  switch (mode) {
    case "default":
      return { fg: theme.textMuted, bold: false };
    case "acceptEdits":
      return { fg: theme.toolEdit, bold: true };
    case "plan":
      return { fg: theme.toolTask, bold: true };
    case "bypassPermissions":
      return { fg: theme.toolError, bold: true };
  }
}

function branchSegment(session: Session): { name: string; dirty: boolean } | null {
  const g = session.git;
  if (!g || !g.branch) return null;
  return { name: g.branch, dirty: g.dirty };
}

function Pipe() {
  return <text fg={theme.textFaint}>{"  ·  "}</text>;
}

function ConnectionDot({ status }: { status: WSStatus }) {
  const fg =
    status === "open"
      ? theme.toolEdit
      : status === "connecting"
        ? theme.textMuted
        : theme.toolError;
  return <text fg={fg}>{"●"}</text>;
}
