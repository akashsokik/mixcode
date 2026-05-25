// Single-cycle actor/critic consensus decision modal.
//
// Mounted when a `consensus_ready` server msg arrives. The producer wrote
// one draft, the critic reviewed it once, and that's the cycle. This modal
// shows the draft alongside the critic's verdict so the user can read both
// before picking an implementer. No retry path — disagreement is surfaced
// to the user, not used to drive another round.
//
// Key bindings:
//   tab         toggle between "final" view (just the draft) and "thread"
//               view (producer draft + critic review side by side)
//   c           implement with claude
//   x           implement with codex
//   esc / n     cancel (drop the proposal; nothing applied)
//
// On `implement`, the server triggers a normal turn on the chosen runner
// with the draft as the prompt; the chosen runner does the actual work
// via the standard tool path.

import { useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
  ConsensusReady,
  RunnerKind,
} from "../../../shared/events.ts";
import { theme } from "../theme";

type ConsensusModalProps = {
  ready: ConsensusReady;
  onAction: (
    action: "implement" | "cancel",
    payload?: { runner?: RunnerKind; plan?: string },
  ) => void;
};

type View = "final" | "thread";

const MAX_BODY_LINES = 22;
const MAX_LINE_CHARS = 200;

function runnerAccent(runner: RunnerKind): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  return theme.accent;
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function bodyLines(text: string): { lines: string[]; overflow: number } {
  const split = text.split("\n").map((l) => clamp(l, MAX_LINE_CHARS));
  if (split.length <= MAX_BODY_LINES) return { lines: split, overflow: 0 };
  return {
    lines: split.slice(0, MAX_BODY_LINES),
    overflow: split.length - MAX_BODY_LINES,
  };
}

export function ConsensusModal({ ready, onAction }: ConsensusModalProps) {
  const [view, setView] = useState<View>("final");

  useKeyboard((key) => {
    const name = key.name;
    if (name === "tab") {
      setView((v) => (v === "final" ? "thread" : "final"));
      return;
    }
    if (name === "c") {
      onAction("implement", {
        runner: "claude",
        plan: ready.finalDraft,
      });
      return;
    }
    if (name === "x") {
      onAction("implement", {
        runner: "codex",
        plan: ready.finalDraft,
      });
      return;
    }
    if (name === "return") {
      onAction("implement", {
        runner: ready.suggestedRunner,
        plan: ready.finalDraft,
      });
      return;
    }
    if (name === "escape" || name === "n") {
      onAction("cancel");
      return;
    }
  });

  const verdict = ready.iterations[0]?.verdict ?? "unknown";
  const headerAccent =
    verdict === "agree"
      ? theme.toolEdit
      : verdict === "revise"
        ? theme.toolBash
        : theme.textMuted;
  const verdictLabel =
    verdict === "agree"
      ? "critic AGREED"
      : verdict === "revise"
        ? "critic flagged issues (verdict: REVISE)"
        : "critic verdict unknown";

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={headerAccent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={headerAccent} attributes={TextAttributes.BOLD}>
          {"consensus  "}
        </text>
        <text fg={theme.textMuted}>{clamp(ready.task, 80)}</text>
      </box>

      <box flexDirection="row">
        <text fg={runnerAccent(ready.producer)} attributes={TextAttributes.BOLD}>
          {`producer=${ready.producer}`}
        </text>
        <text fg={theme.textMuted}>{"   "}</text>
        <text fg={runnerAccent(ready.critic)} attributes={TextAttributes.BOLD}>
          {`critic=${ready.critic}`}
        </text>
        <text fg={theme.textMuted}>{"   "}</text>
        <text fg={headerAccent}>{verdictLabel}</text>
      </box>

      {view === "final" ? (
        <FinalView ready={ready} />
      ) : (
        <ThreadView ready={ready} />
      )}

      <box flexDirection="row">
        <text fg={theme.textMuted}>{"["}</text>
        <text fg={theme.runnerClaude} attributes={TextAttributes.BOLD}>{"c"}</text>
        <text fg={theme.textMuted}>{"] implement w/ claude   ["}</text>
        <text fg={theme.runnerCodex} attributes={TextAttributes.BOLD}>{"x"}</text>
        <text fg={theme.textMuted}>{"] implement w/ codex   ["}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"tab"}</text>
        <text fg={theme.textMuted}>
          {view === "final" ? "] thread   [" : "] final   ["}
        </text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"esc"}</text>
        <text fg={theme.textMuted}>{"] cancel"}</text>
      </box>
    </box>
  );
}

function FinalView({ ready }: { ready: ConsensusReady }) {
  const { lines, overflow } = useMemo(
    () => bodyLines(ready.finalDraft || "(empty draft)"),
    [ready.finalDraft],
  );
  return (
    <box flexDirection="column">
      <text fg={theme.textFaint}>{`── final draft (by ${ready.producer}) ──`}</text>
      {lines.map((line, i) => (
        <text key={i} fg={theme.text}>
          {line || " "}
        </text>
      ))}
      {overflow > 0 && (
        <text fg={theme.textFaint}>{`  … +${overflow} more lines (tab to view thread)`}</text>
      )}
    </box>
  );
}

// Compact thread view: each iteration as
//   [producer] <first line of draft>
//   [critic] (verdict) <first line of critique>
// with a fold count so the user can see the shape of the conversation
// without scrolling pages of text.
function ThreadView({ ready }: { ready: ConsensusReady }) {
  const items: { fg: string; label: string; preview: string }[] = [];
  for (const it of ready.iterations) {
    items.push({
      fg: runnerAccent(ready.producer),
      label: `[${ready.producer} #${it.index + 1}] DRAFT`,
      preview: firstNonEmptyLine(it.producerText),
    });
    const verdict =
      it.verdict === "agree"
        ? "AGREE"
        : it.verdict === "revise"
          ? "REVISE"
          : "UNPARSED";
    items.push({
      fg: runnerAccent(ready.critic),
      label: `[${ready.critic} #${it.index + 1}] ${verdict}`,
      preview: it.summary || firstNonEmptyLine(it.criticText),
    });
  }
  const shown = items.slice(-MAX_BODY_LINES);
  const overflow = items.length - shown.length;
  return (
    <box flexDirection="column">
      <text fg={theme.textFaint}>{"── iteration thread ──"}</text>
      {overflow > 0 && (
        <text fg={theme.textFaint}>{`  (showing last ${shown.length} of ${items.length})`}</text>
      )}
      {shown.map((it, i) => (
        <box key={i} flexDirection="row">
          <text fg={it.fg} attributes={TextAttributes.BOLD}>
            {it.label}
          </text>
          <text fg={theme.textMuted}>{"  "}</text>
          <text fg={theme.text}>{clamp(it.preview || "(no text)", 140)}</text>
        </box>
      ))}
    </box>
  );
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
