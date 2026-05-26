// Visual primitives shared by every TuiCard. Cards compose these pieces to
// keep the typographic rhythm consistent: status dot, accent verb, dim id
// chip, middot-separated meta, tree-style sub-rows. Each card retains its own
// body but every card's headline reads the same way.

import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { theme } from "../../theme";
import { StatusDot } from "./StatusDot";
import { useAnimatedNumber, useFadeInPhase, usePulsePhase } from "./hooks";
import { runnerColor } from "./format";
import type { Chip, TuiStatus } from "./types";

// One-line header. The `peer` prefix is reserved for sub-runner tools so the
// owning agent always reads in front of the verb. Status dot leads so the
// whole transcript scans down a single status column.
export function CardHeader({
  status,
  peer,
  verb,
  verbColor,
  title,
  id,
  shimmer = true,
}: {
  status: TuiStatus | string;
  peer?: { name: string; color?: string };
  verb: string;
  verbColor: string;
  title?: string;
  id?: string;
  shimmer?: boolean;
}) {
  return (
    <box flexDirection="row">
      <StatusDot status={status} />
      <text fg={theme.text}>{" "}</text>
      {peer && (
        <text
          fg={peer.color ?? runnerColor(peer.name)}
          attributes={TextAttributes.BOLD}
        >{`[${peer.name}] `}</text>
      )}
      <ShimmerText
        text={verb}
        color={verbColor}
        bold
        active={shimmer && status === "running"}
      />
      {title && <text fg={theme.text}>{` ${title}`}</text>}
      {id && <IdChip id={id} />}
    </box>
  );
}

// Inline list of chips joined by ` · `. Each chip can carry its own color +
// weight; defaults fall back to textMuted/textFaint depending on `dim`.
export function MetaChips({ chips }: { chips: Chip[] }) {
  return (
    <>
      {chips.map((c, i) => (
        <ChipText key={i} chip={c} sep={i > 0} />
      ))}
    </>
  );
}

function ChipText({ chip, sep }: { chip: Chip; sep: boolean }) {
  const fg = chip.dim
    ? theme.textFaint
    : chip.color ?? theme.textMuted;
  return (
    <>
      {sep && <text fg={theme.textFaint}>{"  ·  "}</text>}
      <text fg={fg} attributes={chip.bold ? TextAttributes.BOLD : 0}>
        {chip.text}
      </text>
    </>
  );
}

// Tree-style sub-row. Use `last` to switch the marker from ├ to └ so the
// final row closes the branch cleanly. `fadeIn` lights up newly-mounted rows
// from dim → bright so freshly-appended sub-tasks/phases visually announce
// themselves without changing layout.
export function SubRow({
  last = false,
  status,
  children,
  fadeIn = false,
}: {
  last?: boolean;
  status?: TuiStatus | string;
  children: ReactNode;
  fadeIn?: boolean;
}) {
  const marker = last ? "  └ " : "  ├ ";
  const fadePhase = useFadeInPhase();
  const markerFg = fadeIn
    ? [theme.textFaint, theme.textSubtle, theme.textFaint][fadePhase] ??
      theme.textFaint
    : theme.textFaint;
  return (
    <box flexDirection="row">
      <text fg={markerFg}>{marker}</text>
      {status && (
        <>
          <StatusDot status={status} />
          <text fg={theme.text}>{" "}</text>
        </>
      )}
      {children}
    </box>
  );
}

// Animated counter. Renders an integer that tweens toward `value` over the
// hook's default duration. Optionally pads the display to a min width so a
// counter sitting next to fixed text doesn't shift columns mid-tween.
export function Counter({
  value,
  minWidth = 0,
  color,
  bold,
  suffix = "",
}: {
  value: number;
  minWidth?: number;
  color?: string;
  bold?: boolean;
  suffix?: string;
}) {
  const shown = useAnimatedNumber(value);
  const str = `${shown}${suffix}`.padStart(minWidth, " ");
  return (
    <text fg={color ?? theme.textMuted} attributes={bold ? TextAttributes.BOLD : 0}>
      {str}
    </text>
  );
}

// Small unicode progress bar. Not currently mounted in any card (the user
// preferred a plain counter for ok/total displays), but kept exported so
// future cards can opt in without re-implementing the fill-tween math.
const BAR_FULL = "█";
const BAR_EMPTY = "░";

export function MiniBar({
  value,
  total,
  width = 12,
  color,
}: {
  value: number;
  total: number;
  width?: number;
  color?: string;
}) {
  const shown = useAnimatedNumber(Math.max(0, Math.min(value, total)));
  const safeTotal = Math.max(1, total);
  const filled = Math.max(0, Math.min(width, Math.round((shown / safeTotal) * width)));
  const empty = Math.max(0, width - filled);
  return (
    <box flexDirection="row">
      <text fg={color ?? theme.runnerClaude}>{BAR_FULL.repeat(filled)}</text>
      <text fg={theme.textFaint}>{BAR_EMPTY.repeat(empty)}</text>
    </box>
  );
}

// Bold text that gently pulses through a 4-phase palette while `active`.
// Each phase swaps the fg so the verb breathes — readable and quiet, no
// flashing. Inactive renders as plain text with the supplied color.
export function ShimmerText({
  text,
  color,
  active,
  bold = false,
}: {
  text: string;
  color: string;
  active: boolean;
  bold?: boolean;
}) {
  const phase = usePulsePhase(active, 1200, 4);
  // [bright, color, dim, color] — the dip happens once per cycle so the eye
  // catches the pulse without being annoyed by constant strobing.
  const palette = [color, color, theme.textMuted, color];
  const fg = active ? palette[phase] ?? color : color;
  return (
    <text fg={fg} attributes={bold ? TextAttributes.BOLD : 0}>
      {text}
    </text>
  );
}

// Small ID chip rendered as a dim trailing column. Centralised so every card
// formats short ids identically.
export function IdChip({ id }: { id: string }) {
  if (!id) return null;
  return <text fg={theme.textFaint}>{`  ${id}`}</text>;
}
