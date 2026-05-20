import { TextAttributes } from "@opentui/core";
import type { RunnerKind, Session } from "../../../shared/events.ts";
import { theme } from "../theme";
import { shortPath } from "../util/path";

type Props = {
  active: Session | null;
  width: number;
};

export function Header({ active, width }: Props) {
  const compact = width < 76;
  const tiny = width < 44;
  const inset = 4;
  const title = active?.title ?? "no active session";
  const titleBudget = tiny
    ? Math.max(8, width - 16)
    : compact
      ? Math.max(12, width - 30)
      : Math.max(16, width - 62);

  return (
    <box
      height={2}
      flexDirection="row"
      alignItems="center"
      paddingLeft={inset}
      paddingRight={inset}
      border={["bottom"]}
      borderStyle="single"
      borderColor={active?.streaming ? theme.borderFocused : theme.border}
    >
      <Brand compact={tiny} />
      {active && (
        <>
          <Dot />
          {!tiny && (
            <>
              <text fg={runnerColor(active.activeRunner)} attributes={TextAttributes.BOLD}>
                {active.activeRunner}
              </text>
              <Dot />
            </>
          )}
          <text
            fg={active.streaming ? theme.accent : theme.text}
            attributes={TextAttributes.BOLD}
          >
            {truncate(title, titleBudget)}
          </text>
          {!compact && (
            <>
              <Dot />
              <text fg={theme.textMuted}>
                {truncate(
                  shortPath(active.cwd),
                  Math.max(12, Math.floor(width * 0.28)),
                )}
              </text>
              {modelLabel(active) && (
                <>
                  <Dot />
                  <text fg={theme.textMuted}>
                    {truncate(modelLabel(active)!, Math.max(10, Math.floor(width * 0.18)))}
                  </text>
                </>
              )}
              <Dot />
              <text fg={theme.textSubtle}>
                {`${active.messages.length} msg${active.messages.length === 1 ? "" : "s"}`}
              </text>
            </>
          )}
        </>
      )}
      {!active && (
        <>
          <Dot />
          <text fg={theme.textMuted}>{truncate(title, titleBudget)}</text>
        </>
      )}
    </box>
  );
}

function Brand({ compact }: { compact: boolean }) {
  if (compact) {
    return (
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        adv-code
      </text>
    );
  }

  return (
    <>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        adverserial
      </text>
      <text fg={theme.textSubtle}>-code</text>
    </>
  );
}

function Dot() {
  return <text fg={theme.textFaint}>{"  ·  "}</text>;
}

function runnerColor(runner: RunnerKind): string {
  return runner === "claude" ? theme.toolBash : theme.toolWeb;
}

function modelLabel(session: Session): string | null {
  return session.models?.[session.activeRunner] ?? null;
}

function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n <= 3) return s.slice(0, n);
  return `${s.slice(0, n - 3)}...`;
}
