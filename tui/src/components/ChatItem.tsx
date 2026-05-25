import type { ReactNode } from "react";
import { theme } from "../theme";

export type ChatItemProps = {
  id: string;
  selected: boolean;
  expanded?: boolean;
  expandable?: boolean;
  hint?: string | null;
  onActivate?: () => void;
  marginTop?: number;
  nested?: boolean;
  children: ReactNode;
  expandedContent?: ReactNode;
};

// Invariant: when `nested` is true, ChatItem returns a Fragment with no flex
// container. It MUST be rendered inside a column-flex ancestor (this is how
// DelegationGroup composes the inner header ToolCard without doubling padding).
export function ChatItem({
  id: _id,
  selected,
  expanded = false,
  expandable = false,
  hint = null,
  onActivate,
  marginTop = 1,
  nested = false,
  children,
  expandedContent,
}: ChatItemProps) {
  if (nested) {
    return (
      <>
        {children}
        {expanded && expandedContent}
      </>
    );
  }
  const showExpanded = expanded && expandedContent != null;
  const showHint = selected && expandable && hint;
  return (
    <box
      flexDirection="column"
      paddingLeft={selected ? 0 : 1}
      paddingRight={1}
      marginTop={marginTop}
      border={selected ? ["left"] : undefined}
      borderStyle={selected ? "single" : undefined}
      borderColor={selected ? theme.borderFocused : undefined}
      onMouseDown={onActivate ? () => onActivate() : undefined}
    >
      {children}
      {showExpanded && expandedContent}
      {showHint && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  "}</text>
          <text fg={theme.textFaint}>{hint}</text>
        </box>
      )}
    </box>
  );
}
