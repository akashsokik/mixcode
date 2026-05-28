# /new Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/new [title] [runner]` command to create new sessions from the prompt, with optional title and runner arguments.

**Architecture:** Extend the existing slash command system in `slash.ts` with a new `NewAction` type, add parsing logic for title and optional runner, then handle it in `app.tsx` by calling `api.createSession()` with the parsed arguments.

**Tech Stack:** TypeScript, React, existing slash command parser pattern

---

## File Structure

- **`tui/src/util/slash.ts`**: Add `NewAction` type, parser for `/new [title] [runner]`
- **`tui/src/app.tsx`**: Add case handler for `type: "new"` that calls `api.createSession()`
- **Tests**: Update `tui/src/util/blocks.test.ts` if existing tests check slash command parsing

---

### Task 1: Define NewAction type and add to SlashCommand union

**Files:**
- Modify: `tui/src/util/slash.ts:1-84`

- [ ] **Step 1: Add NewAction type above SlashCommand union**

After line 60 (after `McpAction` definition), add:

```typescript
// /new grammar:
//   (no args)            — create a new session with default title and active runner
//   <title>              — create with custom title, active runner
//   <title> <runner>     — create with custom title and runner (claude|codex|vercel)
export type NewAction = {
  title: string | null;
  runner: RunnerKind | null;
};
```

- [ ] **Step 2: Add new case to SlashCommand union**

In the `SlashCommand` union type (around line 62), add this variant before the closing `|`:

```typescript
  | { type: "new"; action: NewAction }
```

- [ ] **Step 3: Commit the type definitions**

```bash
git add tui/src/util/slash.ts
git commit -m "types: add NewAction for /new command"
```

---

### Task 2: Implement parseNewAction parser function

**Files:**
- Modify: `tui/src/util/slash.ts:140-178` (after parseSkillsAction)

- [ ] **Step 1: Add parseNewAction function after parseMcpAction**

After the `parseMcpAction` function (around line 207), add:

```typescript
function parseNewAction(rest: string): NewAction {
  if (!rest) return { title: null, runner: null };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const title = tokens[0] ?? null;
  const runnerStr = tokens[1]?.toLowerCase();
  let runner: RunnerKind | null = null;
  if (runnerStr === "claude" || runnerStr === "codex" || runnerStr === "vercel") {
    runner = runnerStr;
  }
  return { title, runner };
}
```

- [ ] **Step 2: Commit the parser function**

```bash
git add tui/src/util/slash.ts
git commit -m "feat: add parseNewAction parser for /new command"
```

---

### Task 3: Wire parseNewAction into parseSlash dispatcher

**Files:**
- Modify: `tui/src/util/slash.ts:91-140`

- [ ] **Step 1: Add "new" case in parseSlash switch statement**

In the `parseSlash` function's switch statement, add this case after the "mcp" case (around line 134):

```typescript
    case "new":
      return { type: "new", action: parseNewAction(rest) };
```

- [ ] **Step 2: Commit the dispatcher wiring**

```bash
git add tui/src/util/slash.ts
git commit -m "feat: wire /new command into slash parser"
```

---

### Task 4: Add /new to SLASH_COMMANDS help list

**Files:**
- Modify: `tui/src/util/slash.ts:308-325`

- [ ] **Step 1: Add help entry for /new**

In the `SLASH_COMMANDS` array, add this entry (order by alphabetical, so after `/mcp`):

```typescript
  { name: "/new [title] [runner]", help: "create a new session (optional: title and runner—claude|codex|vercel)" },
```

The full array should have `/new` inserted before `/permissions` to keep alphabetical order. Find the line with the `mcp` entry and add it after.

- [ ] **Step 2: Commit the help text**

```bash
git add tui/src/util/slash.ts
git commit -m "docs: add /new to slash command help"
```

---

### Task 5: Add handler in app.tsx switch statement

**Files:**
- Modify: `tui/src/app.tsx` (in the slash command handler switch, after "mcp" case)

- [ ] **Step 1: Locate the slash command handler in app.tsx**

Find the `handleSendMessage` function and the switch statement that handles slash command types (search for `case "mcp":`).

- [ ] **Step 2: Add "new" case handler after "mcp"**

Add this case:

```typescript
        case "new": {
          const { title, runner } = slash.action;
          api.createSession(title ?? undefined, runner ?? undefined);
          return;
        }
```

- [ ] **Step 3: Verify the syntax matches surrounding cases**

Check that the indentation and brace style match the surrounding `case` blocks (e.g., `case "permissions"`, `case "model"`).

- [ ] **Step 4: Commit the handler**

```bash
git add tui/src/app.tsx
git commit -m "feat: add /new command handler to create sessions"
```

---

### Task 6: Test the implementation

**Files:**
- Test: `tui/src/util/slash.test.ts` (if exists) or manual testing

- [ ] **Step 1: Check if slash tests exist**

Run:
```bash
ls -la tui/src/util/*.test.ts* 2>/dev/null | head -5
```

If `slash.test.ts` or similar exists, add a test. Otherwise, manual testing is sufficient.

- [ ] **Step 2: Manual test in TUI**

Start the TUI:
```bash
bun start
```

In the prompt, type and test these:
- `/new` — should create a new session with default title and runner
- `/new mysession` — should create a session titled "mysession"
- `/new mysession claude` — should create a session with Claude runner
- `/new mysession codex` — should create a session with Codex runner
- `/new mysession vercel` — should create a session with Vercel runner
- `/new mysession invalid` — should ignore invalid runner and create with current runner

Verify each creates a new session in the sidebar and switches focus to it.

- [ ] **Step 3: Type check**

```bash
bun run typecheck
```

Expected: No errors in `tui/src/util/slash.ts` or `tui/src/app.tsx`

- [ ] **Step 4: Commit test results**

```bash
git add -A
git commit -m "test: verify /new command works end-to-end"
```
