import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { theme } from "../theme";
import pkg from "../../../package.json" with { type: "json" };

const LOGO = "MixCode";
const LOGO_NOISE = "ZXCVBNMASDFGHJKL";

const TIP = "Use /sessions to browse previous conversations";
const HINTS_TOP = "ctrl+k for palette  ·  shift+tab to cycle modes";
const HINTS_BOT = "@ to insert files  ·  /help for commands";

type Runner = readonly [name: string, ready: boolean];
const RUNNERS: ReadonlyArray<Runner> = [
  ["Claude", true],
  ["Codex", true],
  ["Vercel", true],
];

const SETTLE_FRAME = LOGO.length + 4;

export function Welcome() {
  const [frame, setFrame] = useState(0);
  const settled = frame >= SETTLE_FRAME;

  const logoText = settled
    ? LOGO
    : LOGO.split("")
        .map((char, index) =>
          frame > index + 2
            ? char
            : LOGO_NOISE[(frame + index * 3) % LOGO_NOISE.length],
        )
        .join("");
  const logoColor = frame < 4
    ? theme.textFaint
    : frame < 10
      ? theme.textSubtle
      : theme.text;

  useEffect(() => {
    if (settled) return;
    const tick = setInterval(() => setFrame((value) => value + 1), 90);
    return () => clearInterval(tick);
  }, [settled]);

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center">
      <box flexDirection="column" alignItems="center">
        <ascii-font text={logoText} font="block" color={logoColor} />

        <box marginTop={1}>
          <text fg={theme.textMuted}>v{pkg.version}</text>
        </box>

        <box marginTop={2} flexDirection="row">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            TIP:
          </text>
          <text fg={theme.text}>{` ${TIP}`}</text>
        </box>

        <box marginTop={2} flexDirection="column" alignItems="center">
          <text fg={theme.textMuted}>{HINTS_TOP}</text>
          <text fg={theme.textMuted}>{HINTS_BOT}</text>
        </box>

        <box marginTop={2} flexDirection="row">
          {RUNNERS.map(([name, ok], i) => (
            <box key={name} flexDirection="row">
              {i > 0 && <text fg={theme.textFaint}>{"   "}</text>}
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {name}
              </text>
              <text fg={ok ? theme.toolEdit : theme.toolError}>
                {ok ? " ✓" : " ✗"}
              </text>
            </box>
          ))}
        </box>
      </box>
    </box>
  );
}
