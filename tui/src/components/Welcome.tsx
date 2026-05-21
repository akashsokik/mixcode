import { theme } from "../theme";
import pkg from "../../package.json" with { type: "json" };

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["enter", "send prompt"],
  ["/help", "show commands"],
  ["@", "insert file"],
  ["ctrl-b", "browse sessions"],
  ["ctrl-c", "quit"],
];

export function Welcome() {
  const keyCol = Math.max(...SHORTCUTS.map(([k]) => k.length));

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center">
      <box flexDirection="column" alignItems="center">
        <ascii-font text="MixCode" font="block" color={theme.textSubtle} />
        <box marginTop={1}>
          <text fg={theme.textSubtle}>v{pkg.version}</text>
        </box>
        <box flexDirection="column" marginTop={3}>
          {SHORTCUTS.map(([key, label]) => (
            <box key={key} flexDirection="row">
              <text fg={theme.textMuted}>{key.padStart(keyCol, " ")}</text>
              <text fg={theme.textSubtle}>{"   "}</text>
              <text fg={theme.textSubtle}>{label}</text>
            </box>
          ))}
        </box>
      </box>
    </box>
  );
}
