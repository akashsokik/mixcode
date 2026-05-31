// Shared vocabulary for everything in tuicards/. A TuiCard is anything that
// renders into the transcript scrollback as a selectable, optionally expandable
// chunk. Each card type (tool, task, collab, notice) layers its own data on
// top, but they all share the same activation/selection lifecycle so the App's
// keyboard + mouse routing stays uniform.
//
// `TuiCardBaseProps` is the canonical prop set the bottom-level frame
// (`ChatItem`) consumes. Cards may relax pieces of it when they don't apply
// — e.g. `TaskCard` is never expandable, `NoticeCard` derives `id` from the
// `notice` it owns — but every card still goes through ChatItem, so this is
// the contract that matters in practice.

export type TuiCardKind = "tool" | "task" | "collab" | "workflow" | "notice" | "welcome";

export type TuiCardBaseProps = {
  id: string;
  selected: boolean;
  expanded?: boolean;
  expandable?: boolean;
  hint?: string | null;
  onActivate?: () => void;
};

// Status vocabulary shared by every card's status indicator. Centralised so
// the dot, the verb pill, the row marker, and the optional shimmer all key
// off the same set of strings — no per-card divergence.
export type TuiStatus =
  | "running"
  | "ok"
  | "done"
  | "error"
  | "timeout"
  | "queued"
  | "pending"
  | "cancelled"
  | "open"
  | "unknown";

// A single inline chip rendered in a meta row. `dim` collapses to textMuted,
// `bold` adds BOLD weight, and `color` overrides the default muted hue.
export type Chip = {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
};
