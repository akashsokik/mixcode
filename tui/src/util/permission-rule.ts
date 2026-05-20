// Permission-rule input from the user is typically a bare command like
// "npm install:*" or "ls -la". The SDK matcher only understands the
// ToolName / ToolName(content) shape — so we auto-wrap anything that
// doesn't already look like one.
//
// Examples:
//   "npm install:*"       -> Bash(npm install:*)
//   "Bash(npm install:*)" -> Bash(npm install:*)
//   "Read"                -> Read
//   "Read(/tmp/**)"       -> Read(/tmp/**)

const TOOL_RULE = /^[A-Z][A-Za-z0-9_-]*(\(.+\))?$/s;

export type Normalized = {
  rule: string;
  // The user's original input, before normalization. Useful when echoing
  // back so they can see what was actually stored.
  original: string;
  rewritten: boolean;
};

export function normalizeRule(input: string): Normalized | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (TOOL_RULE.test(trimmed)) {
    return { rule: trimmed, original: trimmed, rewritten: false };
  }
  return {
    rule: `Bash(${trimmed})`,
    original: trimmed,
    rewritten: true,
  };
}
