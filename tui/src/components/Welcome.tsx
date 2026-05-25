import { useEffect, useState } from "react";
import { theme } from "../theme";
import pkg from "../../../package.json" with { type: "json" };

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["enter", "send prompt"],
  ["/help", "show commands"],
  ["@", "insert file"],
  ["ctrl-b", "browse sessions"],
  ["ctrl-c", "quit"],
];

const BOOT_STEPS: ReadonlyArray<readonly [string, string]> = [
  ["linking sessions", "peer memory"],
  ["warming runners", "claude · codex"],
  ["mcp bus online", "tools armed"],
  ["ready", "runners online"],
];

const LOGO = "MixCode";
const LOGO_NOISE = "ZXCVBNMASDFGHJKL";
const SCAN_LINES = [
  "· · · · · · · · · · ·",
  "• · · · · · · · · · ·",
  "· • · · · · · · · · ·",
  "· · • · · · · · · · ·",
  "· · · • · · · · · · ·",
  "· · · · • · · · · · ·",
  "· · · · · • · · · · ·",
  "· · · · · · • · · · ·",
  "· · · · · · · • · · ·",
  "· · · · · · · · • · ·",
  "· · · · · · · · · • ·",
  "· · · · · · · · · · •",
];

export function Welcome() {
  const [frame, setFrame] = useState(0);
  const keyCol = Math.max(...SHORTCUTS.map(([k]) => k.length));
  const labelCol = Math.max(...SHORTCUTS.map(([, l]) => l.length));
  const stepIndex = Math.min(BOOT_STEPS.length - 1, Math.floor(frame / 5));
  const [status, detail] = BOOT_STEPS[stepIndex];
  const ready = stepIndex === BOOT_STEPS.length - 1;
  const logoText = LOGO.split("")
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
    const tick = setInterval(() => setFrame((value) => value + 1), 120);
    return () => clearInterval(tick);
  }, []);

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center">
      <box flexDirection="column" alignItems="center">
        <box flexDirection="row" marginBottom={1}>
          <text fg={theme.textFaint}>╭─ </text>
          <text fg={ready ? theme.textMuted : theme.textFaint}>
            {SCAN_LINES[frame % SCAN_LINES.length]}
          </text>
          <text fg={theme.textFaint}> ─╮</text>
        </box>

        <ascii-font text={logoText} font="block" color={logoColor} />

        <box marginTop={1} flexDirection="row">
          <text fg={theme.textFaint}>v{pkg.version}</text>
          <text fg={theme.textFaint}> · </text>
          <text fg={ready ? theme.toolEdit : theme.textMuted}>{detail}</text>
        </box>

        <box marginTop={1} flexDirection="row">
          <text fg={theme.textMuted}>boot: </text>
          <text fg={ready ? theme.toolEdit : theme.textSubtle}>{status}</text>
        </box>

        <box flexDirection="column" marginTop={3} alignItems="stretch">
          <box flexDirection="row" marginBottom={1}>
            <text fg={theme.textFaint}>╭───── </text>
            <text fg={theme.textMuted}>{"> mixcode --wake"}</text>
            <text fg={theme.textFaint}> ──────────╮</text>
          </box>

          <box flexDirection="column" alignSelf="center">
            {SHORTCUTS.map(([key, label], index) => {
              const visible = frame >= 8 + index * 2;
              return (
                <box key={key} flexDirection="row">
                  <text fg={visible ? theme.text : theme.textFaint}>
                    {visible ? key.padStart(keyCol, " ") : " ".repeat(keyCol)}
                  </text>
                  <text fg={theme.textFaint}>{"  →  "}</text>
                  <text fg={visible ? theme.textSubtle : theme.textFaint}>
                    {(visible ? label : "").padEnd(labelCol, " ")}
                  </text>
                </box>
              );
            })}
          </box>

          <box flexDirection="row" marginTop={1}>
            <text fg={theme.textFaint}>╰───── </text>
            <text fg={ready ? theme.textMuted : theme.textFaint}>
              {ready ? "commands unlocked" : "calibrating input"}
            </text>
            <text fg={theme.textFaint}> ─────────╯</text>
          </box>
        </box>
      </box>
    </box>
  );
}
