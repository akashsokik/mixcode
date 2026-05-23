import type { ToolLog } from "../../../shared/events.ts";
import { theme } from "../theme";
import { useBlinkFrame } from "../util/spinner";

export type DotStatus =
  | "running"
  | "ok"
  | "done"
  | "error"
  | "timeout"
  | "queued"
  | "pending"
  | "cancelled"
  | "unknown";

// Colored circle reflecting status. Blinking ● while running (same vocabulary
// as the live delegation pending header). Hollow ○ for not-yet-started states
// (queued/pending) and cancelled.
export function StatusDot({ status }: { status: string }) {
  const frame = useBlinkFrame(status === "running");
  if (status === "running") return <text fg={theme.toolBash}>{frame}</text>;
  if (status === "ok" || status === "done") return <text fg={theme.runnerClaude}>{"●"}</text>;
  if (status === "error" || status === "timeout") return <text fg={theme.toolError}>{"●"}</text>;
  if (status === "cancelled") return <text fg={theme.textSubtle}>{"○"}</text>;
  if (status === "queued" || status === "pending") return <text fg={theme.textMuted}>{"○"}</text>;
  return <text fg={theme.textMuted}>{"○"}</text>;
}

// Derive a dot status from a generic ToolLog. The wire shape doesn't carry an
// explicit status, so we infer:
//   - isError true        -> "error"
//   - output present      -> "ok"
//   - output null/empty   -> "running" (in-flight; tool_log re-emit with id
//                            will flip it to ok once output lands)
export function toolLogStatus(log: ToolLog): DotStatus {
  if (log.isError === true) return "error";
  const out = log.output;
  if (out === null || out === undefined) return "running";
  if (typeof out === "string" && out.length === 0) return "running";
  return "ok";
}
