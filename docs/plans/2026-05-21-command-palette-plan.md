# Command Palette Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the always-on sidebar with a reusable `<Palette>` overlay
that handles session switching, skills, MCP server management, and a global
Ctrl+K jump-to-anything.

**Architecture:** One presentational component built from opentui's existing
`<input>`, `<scrollbox>`, and `useKeyboard` primitives. Fuzzy matching via the
already-installed `fuzzysort`. `App.tsx` owns palette mode state and builds
the item list per mode. No new dependencies.

**Tech Stack:** React 19, `@opentui/react` 0.2.14, `@opentui/core` 0.2.14,
`fuzzysort` 3.x, TypeScript (strict).

**Verification gate:** This project has no automated test runner for the TUI.
Each task's automated gate is `cd tui && bun run typecheck`. Behavior is
verified manually at the end (Task 14). Commit after every passing task.

**Design doc:** `docs/plans/2026-05-21-command-palette-design.md`

---

### Task 1: Scaffold the Palette component

**Files:**
- Create: `tui/src/components/Palette.tsx`

**Step 1: Write the file**

```tsx
import { useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

export type PaletteAction = {
  key: string;
  label: string;
  destructive?: boolean;
  run: () => void;
};

export type PaletteItem = {
  id: string;
  label: string;
  detail?: string;
  badge?: { text: string; color: string };
  streaming?: boolean;
  actions?: PaletteAction[];
  onActivate: () => void;
};

type Props = {
  title: string;
  placeholder: string;
  items: PaletteItem[];
  onClose: () => void;
  footer?: string;
  onCreate?: () => void; // ctrl+n — sessions mode only
};

export function Palette({ title, placeholder, items, onClose, footer, onCreate }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const haystacks = items.map((i) => `${i.badge?.text ?? ""} ${i.label} ${i.detail ?? ""}`);
    const results = fuzzysort.go(query, haystacks, { threshold: -10000 });
    const order = new Map<number, number>();
    results.forEach((r, rank) => order.set(r.obj as unknown as number, rank));
    return items
      .map((item, i) => ({ item, rank: order.get(haystacks[i] as unknown as number) }))
      .filter((x) => x.rank !== undefined)
      .sort((a, b) => (a.rank as number) - (b.rank as number))
      .map((x) => x.item);
  }, [items, query]);

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>{title}</text>
      <box flexDirection="row" height={1}>
        <text fg={theme.textSubtle}>{"› "}</text>
        <input value={query} onInput={setQuery} placeholder={placeholder} focused flexGrow={1} />
      </box>
      <box flexDirection="column" flexShrink={0}>
        {filtered.slice(0, 10).map((item, i) => (
          <Row key={item.id} item={item} selected={i === index} />
        ))}
        {filtered.length === 0 && <text fg={theme.textFaint}>(no matches)</text>}
      </box>
      <text fg={theme.textFaint}>{footer ?? "↑↓ nav   enter activate   esc close"}</text>
    </box>
  );
}

function Row({ item, selected }: { item: PaletteItem; selected: boolean }) {
  const marker = selected ? "›" : " ";
  return (
    <box flexDirection="row">
      <text fg={selected ? theme.accent : theme.textFaint}>{`${marker} `}</text>
      {item.badge && <text fg={item.badge.color}>{`${item.badge.text.padEnd(8, " ")} `}</text>}
      <text fg={selected ? theme.text : theme.textMuted} attributes={selected ? TextAttributes.BOLD : 0}>
        {item.label}
      </text>
      {item.streaming && <text fg={theme.toolError}>{" ●"}</text>}
      {item.detail && <text fg={theme.textFaint}>{`   ${item.detail}`}</text>}
    </box>
  );
}
```

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS. Component is imported by nothing yet but compiles standalone.

**Step 3: Commit**

```bash
git add tui/src/components/Palette.tsx
git commit -m "Add Palette component scaffold (search, list, no keys yet)"
```

---

### Task 2: Add keyboard navigation and activation

**Files:**
- Modify: `tui/src/components/Palette.tsx`

**Step 1: Insert keyboard handling**

Inside the `Palette` function, BEFORE the `return` statement, add:

```tsx
  // Clamp index when filtered shrinks below it.
  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useKeyboard((key) => {
    if (key.name === "escape") return onClose();
    if (key.name === "up") {
      setIndex(() => Math.max(0, safeIndex - 1));
      return;
    }
    if (key.name === "down") {
      setIndex(() => Math.min(filtered.length - 1, safeIndex + 1));
      return;
    }
    if (key.ctrl && key.name === "n" && onCreate) {
      onCreate();
      return;
    }
    if (ENTER_KEYS.has(key.name ?? "")) {
      const item = filtered[safeIndex];
      if (item) item.onActivate();
      return;
    }
  });
```

Replace `i === index` in the row render with `i === safeIndex`.

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/components/Palette.tsx
git commit -m "Wire keyboard nav (arrows, enter, esc, ctrl+n) in Palette"
```

---

### Task 3: Add the per-item action sheet

**Files:**
- Modify: `tui/src/components/Palette.tsx`

**Step 1: Add action-sheet state and rendering**

Add inside `Palette`, near the other `useState` calls:

```tsx
  const [actionSheet, setActionSheet] = useState<PaletteItem | null>(null);
  const [pendingDestructive, setPendingDestructive] = useState<string | null>(null);
```

Replace the existing `useKeyboard` body with:

```tsx
  useKeyboard((key) => {
    if (actionSheet) {
      if (key.name === "escape") {
        setActionSheet(null);
        setPendingDestructive(null);
        return;
      }
      const action = actionSheet.actions?.find((a) => a.key === key.name);
      if (!action) return;
      if (action.destructive) {
        if (pendingDestructive === action.key) {
          action.run();
          setActionSheet(null);
          setPendingDestructive(null);
        } else {
          setPendingDestructive(action.key);
          setTimeout(() => setPendingDestructive((p) => (p === action.key ? null : p)), 1500);
        }
        return;
      }
      action.run();
      setActionSheet(null);
      return;
    }

    if (key.name === "escape") return onClose();
    if (key.name === "up") {
      setIndex(() => Math.max(0, safeIndex - 1));
      return;
    }
    if (key.name === "down") {
      setIndex(() => Math.min(filtered.length - 1, safeIndex + 1));
      return;
    }
    if (key.name === "space") {
      const item = filtered[safeIndex];
      if (item?.actions?.length) setActionSheet(item);
      return;
    }
    if (key.ctrl && key.name === "n" && onCreate) {
      onCreate();
      return;
    }
    if (ENTER_KEYS.has(key.name ?? "")) {
      const item = filtered[safeIndex];
      if (item) item.onActivate();
      return;
    }
  });
```

Add an action-sheet renderer just above the existing footer text:

```tsx
      {actionSheet && (
        <box flexDirection="column" borderStyle="single" borderColor={theme.toolError} paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>{`actions: ${actionSheet.label}`}</text>
          {actionSheet.actions!.map((a) => {
            const pending = pendingDestructive === a.key;
            return (
              <text key={a.key} fg={a.destructive ? theme.toolError : theme.textMuted}>
                {`  ${a.key}  ${a.label}${pending ? "  (press again to confirm)" : ""}`}
              </text>
            );
          })}
          <text fg={theme.textFaint}>{"esc back"}</text>
        </box>
      )}
```

Update the default `footer` text to mention space:

```tsx
      <text fg={theme.textFaint}>{footer ?? "↑↓ nav   enter activate   space actions   esc close"}</text>
```

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/components/Palette.tsx
git commit -m "Add per-item action sheet with destructive double-tap to Palette"
```

---

### Task 4: Wire palette state and Ctrl+K in App.tsx (no items yet)

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Add the import and state**

Near the other component imports at the top of `App.tsx`:

```tsx
import { Palette, type PaletteItem } from "./components/Palette";
```

Inside `App()`, near the other `useState` calls (next to `modelPicker`):

```tsx
  const [paletteMode, setPaletteMode] = useState<
    "sessions" | "skills" | "mcp" | "global" | null
  >(null);
```

**Step 2: Add a global ctrl+k binding**

In the existing top-level `useKeyboard((key) => { ... })` block (the one that
currently handles browse-mode keys), add at the very top — BEFORE the
`if (focus === "prompt") return;` guard:

```tsx
    if (key.ctrl && key.name === "k") {
      setPaletteMode((m) => (m === "global" ? null : "global"));
      return;
    }
```

**Step 3: Lock the prompt when the palette is open**

Find the `<Prompt ... locked={...} />` line and update:

```tsx
            locked={api.pendingPermissions.length > 0 || modelPicker !== null || paletteMode !== null}
```

**Step 4: Render the palette (empty items for now)**

Inside the column box that contains `<Transcript>`, `<Spinner>`, etc., right
ABOVE the `<Prompt ... />` line, add:

```tsx
          {paletteMode && (
            <Palette
              title={titleForMode(paletteMode)}
              placeholder="type to filter…"
              items={[]}
              onClose={() => setPaletteMode(null)}
            />
          )}
```

At the bottom of the file (after `App`), add the helper:

```tsx
function titleForMode(mode: "sessions" | "skills" | "mcp" | "global"): string {
  switch (mode) {
    case "sessions": return "switch session";
    case "skills":   return "skills";
    case "mcp":      return "mcp servers";
    case "global":   return "jump to anything";
  }
}
```

**Step 5: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tui/src/app.tsx
git commit -m "Wire palette state + ctrl+k trigger in App (empty items)"
```

---

### Task 5: Route /sessions, /skills, /mcp (bare) to open the palette

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Hijack the bare command cases**

Find the `case "sessions":` block in `handleSubmit`. Replace its body with:

```tsx
        case "sessions":
          setPaletteMode("sessions");
          return;
```

Find the `case "skills":` block. Inside the `switch (action.kind)`, change
only the `case "list":` branch to:

```tsx
            case "list":
              setPaletteMode("skills");
              return;
```

Find the `case "mcp":` block. Inside the `switch (action.kind)`, change only
the `case "list":` branch to:

```tsx
            case "list": {
              setPaletteMode("mcp");
              return;
            }
```

(The sub-commands `/skills add|remove|info` and `/mcp add|remove|test <name>`
keep their existing notice-printing behavior. Only the bare form opens the
palette.)

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/app.tsx
git commit -m "Open palette from bare /sessions, /skills, /mcp commands"
```

---

### Task 6: Build sessions-mode items

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Add the items builder**

Inside `App()`, after the existing `useMemo` blocks, add:

```tsx
  const sessionItems = useMemo<PaletteItem[]>(() => {
    return api.sessions.map((s) => {
      const runnerColor = s.activeRunner === "claude" ? theme.runnerClaude : theme.runnerCodex;
      const detail = `${basename(s.cwd) || "~"} · ${s.activeRunner} · ${s.messages.length} msg`;
      return {
        id: s.id,
        label: s.title,
        detail,
        badge: { text: s.activeRunner, color: runnerColor },
        streaming: s.streaming,
        onActivate: () => {
          api.setActive(s.id);
          setPaletteMode(null);
        },
        actions: [
          {
            key: "d",
            label: "delete (press d again to confirm)",
            destructive: true,
            run: () => api.deleteSession(s.id),
          },
        ],
      };
    });
  }, [api.sessions, api.setActive, api.deleteSession]);
```

Add the missing imports at the top of the file:

```tsx
import { basename } from "./util/path";
import { theme } from "./theme";
```

(`theme` may already be imported — check, do not duplicate.)

**Step 2: Pass items into the palette**

Replace the existing `<Palette ... items={[]} />` block with:

```tsx
          {paletteMode && (
            <Palette
              title={titleForMode(paletteMode)}
              placeholder={placeholderForMode(paletteMode)}
              items={itemsForMode(paletteMode)}
              onClose={() => setPaletteMode(null)}
              onCreate={paletteMode === "sessions" ? () => { api.createSession(); setPaletteMode(null); } : undefined}
              footer={
                paletteMode === "sessions"
                  ? "↑↓ nav   enter switch   space actions   ctrl+n new   esc close"
                  : undefined
              }
            />
          )}
```

Add inside `App()`, near the items builder:

```tsx
  function itemsForMode(mode: "sessions" | "skills" | "mcp" | "global"): PaletteItem[] {
    switch (mode) {
      case "sessions": return sessionItems;
      case "skills":   return [];
      case "mcp":      return [];
      case "global":   return sessionItems;
    }
  }
```

Add the helper at the bottom of the file (next to `titleForMode`):

```tsx
function placeholderForMode(mode: "sessions" | "skills" | "mcp" | "global"): string {
  switch (mode) {
    case "sessions": return "search sessions…";
    case "skills":   return "search skills…";
    case "mcp":      return "search mcp servers…";
    case "global":   return "jump to anything…";
  }
}
```

**Step 3: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tui/src/app.tsx
git commit -m "Build sessions-mode palette items with switch + delete + ctrl+n new"
```

---

### Task 7: Build skills-mode items

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Add skills items builder**

After the `sessionItems` `useMemo`, add:

```tsx
  const skillItems = useMemo<PaletteItem[]>(() => {
    if (!api.active) return [];
    const runner = api.active.activeRunner;
    const entries = listSkills(runner);
    const runnerColor = runner === "claude" ? theme.runnerClaude : theme.runnerCodex;
    return entries.map((e) => ({
      id: `${runner}:${e.name}`,
      label: e.name,
      detail: e.description ? clipDetail(e.description, 60) : (e.isSymlink ? "(symlink)" : "(dir)"),
      badge: { text: runner, color: runnerColor },
      onActivate: () => {
        const sid = api.activeId;
        if (!sid) return;
        const fm = readSkillFrontmatter(runner, e.name);
        addNotice(sid, "/skills info", skillInfoLines(runner, e.name, fm));
        setPaletteMode(null);
      },
      actions: [
        {
          key: "d",
          label: "remove (press d again to confirm)",
          destructive: true,
          run: () => {
            const sid = api.activeId;
            const res = removeSkill(runner, e.name);
            if (sid) {
              addNotice(
                sid,
                "/skills remove",
                skillsLines(runner, listSkills(runner), res.ok ? `removed: ${res.name}` : `failed: ${res.error}`),
              );
            }
            setPaletteMode(null);
          },
        },
      ],
    }));
  // Re-run when sessions change because activeRunner might switch; the skills
  // list itself is read from disk so we just key on the runner identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.active?.activeRunner, paletteMode]);
```

Add the `clipDetail` helper at the bottom of the file (next to
`titleForMode`):

```tsx
function clipDetail(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
```

Update `itemsForMode` to wire it in:

```tsx
      case "skills": return skillItems;
```

And add `skillItems` to the `global` case:

```tsx
      case "global": return [...sessionItems, ...skillItems];
```

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/app.tsx
git commit -m "Build skills-mode palette items (activate=info, action=remove)"
```

---

### Task 8: Build mcp-mode items

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Parse MCP server names from the CLI output**

Add at the bottom of the file (next to other helpers):

```tsx
function parseMcpNames(stdout: string): string[] {
  // Both runners emit name-colon-rest lines. Skip blank/heading lines.
  const names: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s/);
    if (m) names.push(m[1]);
  }
  return names;
}
```

**Step 2: Add the items builder**

After `skillItems`, add:

```tsx
  const mcpItems = useMemo<PaletteItem[]>(() => {
    if (!api.active) return [];
    const runner = api.active.activeRunner;
    const out = listMcp(runner);
    if (!out.ok) return [];
    const runnerColor = runner === "claude" ? theme.runnerClaude : theme.runnerCodex;
    return parseMcpNames(out.stdout).map((name) => ({
      id: `${runner}:mcp:${name}`,
      label: name,
      detail: `mcp server (${runner})`,
      badge: { text: "mcp", color: runnerColor },
      onActivate: () => {
        const sid = api.activeId;
        if (!sid) return;
        addNotice(sid, "/mcp test", [`testing ${runner}/${name} — spawning for 2s…`]);
        testMcp(runner, name)
          .then((res) => addNotice(sid, "/mcp test", mcpTestLines(runner, name, res)))
          .catch((err) => addNotice(sid, "/mcp test", [`test crashed: ${(err as Error).message}`]));
        setPaletteMode(null);
      },
      actions: [
        {
          key: "d",
          label: "remove (press d again to confirm)",
          destructive: true,
          run: () => {
            const sid = api.activeId;
            const res = removeMcp(runner, name);
            if (sid) addNotice(sid, "/mcp remove", mcpActionLines(runner, "remove", name, res));
            setPaletteMode(null);
          },
        },
      ],
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.active?.activeRunner, paletteMode]);
```

Update `itemsForMode`:

```tsx
      case "mcp":    return mcpItems;
      case "global": return [...sessionItems, ...skillItems, ...mcpItems];
```

**Step 3: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tui/src/app.tsx
git commit -m "Build mcp-mode palette items (activate=test, action=remove)"
```

---

### Task 9: Add slash-command items to global mode

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Add command items builder**

Import `SLASH_COMMANDS` at the top (it lives in `./util/slash`):

```tsx
import { parseSlash, SLASH_COMMANDS, toggleRunner } from "./util/slash";
```

After `mcpItems`, add:

```tsx
  const commandItems = useMemo<PaletteItem[]>(() => {
    return SLASH_COMMANDS.map((cmd) => ({
      id: `cmd:${cmd.name}`,
      label: cmd.name,
      detail: cmd.help,
      badge: { text: "cmd", color: theme.textMuted },
      onActivate: () => {
        // For commands with arguments, drop the name into the prompt and let
        // the user finish typing. For zero-arg commands, run immediately.
        const bare = cmd.name.split(" ")[0];
        const hasArgs = cmd.name.includes("[") || cmd.name.includes("<");
        setPaletteMode(null);
        if (!hasArgs) handleSubmit(bare);
        else handleSubmit(bare); // bare form is fine for our commands — args are optional
      },
    }));
  }, []);
```

Update the `global` case in `itemsForMode`:

```tsx
      case "global": return [...sessionItems, ...commandItems, ...skillItems, ...mcpItems];
```

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/app.tsx
git commit -m "Add slash-command items to global palette mode"
```

---

### Task 10: Add session pill to MetaRow

**Files:**
- Modify: `tui/src/components/Prompt.tsx`
- Modify: `tui/src/app.tsx`

**Step 1: Accept the new prop in Prompt**

In `PromptProps`, add:

```ts
  sessionPill?: { total: number; streaming: number } | null;
```

Destructure it in the function signature:

```ts
  sessionPill,
```

Pass it down to `MetaRow`:

```tsx
        <MetaRow
          runner={runner ?? null}
          claudeMode={claudeMode}
          modelLabel={modelLabel ?? null}
          contextPercent={contextPercent ?? null}
          projectLabel={projectLabel ?? null}
          branch={branch ?? null}
          streaming={!!streaming}
          sessionPill={sessionPill ?? null}
        />
```

In the `MetaRow` definition, add to the props type:

```ts
  sessionPill: { total: number; streaming: number } | null;
```

Destructure `sessionPill` in the function signature.

Just BEFORE the existing `<box flexGrow={1} />` (the spacer), insert a new
"sessions" segment. The cleanest way is to push it into the existing segments
array. Replace:

```tsx
  const segments: Array<"model" | "project" | "branch" | "mode" | "ctx"> = [];
```

with:

```tsx
  const segments: Array<"model" | "project" | "branch" | "mode" | "ctx" | "sess"> = [];
```

and at the end of the existing segment-push block add:

```tsx
  if (sessionPill && sessionPill.total > 1) segments.push("sess");
```

Then inside the render `.map((seg, i) => ...)` add a branch:

```tsx
          {seg === "sess" && (
            <>
              <text fg={theme.textMuted}>{`sess ${sessionPill!.total}`}</text>
              {sessionPill!.streaming > 0 && (
                <text fg={theme.toolError}>{`●${sessionPill!.streaming}`}</text>
              )}
            </>
          )}
```

**Step 2: Wire the prop in App.tsx**

In `App()`, compute the pill inside the existing `promptMeta` `useMemo` or
add a new `useMemo`:

```tsx
  const sessionPill = useMemo(
    () => ({
      total: api.sessions.length,
      streaming: api.sessions.filter((s) => s.streaming).length,
    }),
    [api.sessions],
  );
```

Pass it to `<Prompt sessionPill={sessionPill} ... />`.

**Step 3: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tui/src/components/Prompt.tsx tui/src/app.tsx
git commit -m "Add sess N●M pill to MetaRow (hidden when single non-streaming)"
```

---

### Task 11: Remove the Sidebar component

**Files:**
- Delete: `tui/src/components/Sidebar.tsx`
- Modify: `tui/src/app.tsx`

**Step 1: Delete the file**

```bash
rm tui/src/components/Sidebar.tsx
```

**Step 2: Strip Sidebar usage from App.tsx**

Remove the import:

```tsx
import { Sidebar } from "./components/Sidebar";
```

Remove the constant:

```tsx
const SIDEBAR_WIDTH = 28;
```

Replace the outer layout:

```tsx
  return (
    <box flexDirection="row" width={width} height={height} backgroundColor={theme.bg}>
      <Sidebar sessions={api.sessions} activeId={api.activeId} width={SIDEBAR_WIDTH} />
      <box flexDirection="column" flexGrow={1}>
        ...
```

with:

```tsx
  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.bg}>
      ...
```

(Drop the outer row, drop the inner column wrapper — the inner box becomes
the new root flex column.)

**Step 3: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add -A tui/src/components/Sidebar.tsx tui/src/app.tsx
git commit -m "Remove Sidebar in favor of palette + MetaRow session pill"
```

---

### Task 12: Strip browse-mode state from App.tsx and Prompt.tsx

**Files:**
- Modify: `tui/src/app.tsx`
- Modify: `tui/src/components/Prompt.tsx`

**Step 1: Remove browse state from App.tsx**

Delete these lines from `App()`:

```tsx
  const [focus, setFocus] = useState<"prompt" | "browse">("prompt");
  const lastDeleteRef = useRef(0);
```

Replace the existing top-level `useKeyboard((key) => { ... })` block with one
that ONLY handles ctrl+k (the rest of the browse logic is gone):

```tsx
  useKeyboard((key) => {
    if (key.ctrl && key.name === "k") {
      setPaletteMode((m) => (m === "global" ? null : "global"));
      return;
    }
  });
```

Also remove the `focused={focus === "prompt"}` and `onUnfocus={() =>
setFocus("browse")}` props from `<Prompt />` — they no longer exist.

The `<Prompt focused={true} ... />` is the new default. Set:

```tsx
          <Prompt
            focused
            onSubmit={handleSubmit}
            ...
          />
```

**Step 2: Remove the onUnfocus prop from Prompt**

In `Prompt.tsx`, edit `PromptProps`:

- Remove `onUnfocus: () => void;`
- Remove the `onUnfocus` destructure
- Remove the `ctrl+b` branch from the `useKeyboard` handler:

```tsx
    if (key.ctrl && key.name === "b") {
      if (slash.active) slash.close();
      if (completions.active) completions.close();
      onUnfocus();
      return;
    }
```

Delete that whole branch.

**Step 3: Drop unused React imports**

If `useRef` is no longer used in `app.tsx`, remove it from the import.

**Step 4: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tui/src/app.tsx tui/src/components/Prompt.tsx
git commit -m "Remove browse mode (focus state, ctrl+b, j/k/n/dd) — palette replaces it"
```

---

### Task 13: Update help text

**Files:**
- Modify: `tui/src/util/notice.ts`

**Step 1: Rewrite the keys section in `helpLines()`**

Find the `keys` block (it currently lists `ctrl-b`, `j/k`, `n`, `dd`). Replace
it with:

```ts
    "keys",
    "  enter        send",
    "  esc          stop streaming turn / close menu",
    "  ctrl-k       open command palette (sessions, skills, mcp, commands)",
    "  /sessions    open session switcher",
    "  /skills      open skills picker for the active runner",
    "  /mcp         open mcp picker for the active runner",
    "  up / down    prompt history",
    "  @            file completion",
    "  ctrl-c       quit",
```

(Specifically remove the four lines about `ctrl-b`, `j/k`, `n`, `dd`.)

**Step 2: Typecheck**

```bash
cd tui && bun run typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/util/notice.ts
git commit -m "Update /help to document palette + ctrl+k, drop browse-mode keys"
```

---

### Task 14: Manual verification

**This task is a checklist, no code. Mark each item before declaring done.**

Run `npm run server` in one terminal and `npm run tui` in another. In the
TUI:

- [ ] Sidebar is gone; transcript and prompt now use the full terminal width.
- [ ] `MetaRow` shows `sess N` (and `●M` if any session is streaming) when N>1.
- [ ] `/sessions` opens the palette with a search box and the existing sessions.
- [ ] Typing filters the list (fuzzysort).
- [ ] `↑ ↓` navigate; `enter` switches to the highlighted session and closes.
- [ ] `space` opens the action sheet for the highlighted session.
- [ ] In the sheet, `d` once shows "press d again to confirm"; `d` again
      deletes; `esc` cancels the sheet.
- [ ] `ctrl+n` while the sessions palette is open creates a new session.
- [ ] `ctrl+k` opens the global palette; items show a `session`/`cmd`/`skill`/
      `mcp` badge.
- [ ] Typing `sess foo` narrows to a session; typing `skills` narrows to a
      command; etc.
- [ ] Activating a command item from the global palette runs that command
      (try `/help`).
- [ ] `/skills` opens skills mode; `enter` prints the skill's info as a
      notice; `space → d → d` removes a skill (test on a throwaway symlink).
- [ ] `/mcp` opens mcp mode; `enter` runs `mcp test` for the highlighted
      server; `space → d → d` removes.
- [ ] `esc` closes the palette anywhere.
- [ ] `/help` no longer mentions `ctrl-b`, `j/k`, `n`, `dd`.

**Step 1: Run typecheck one more time across the whole repo**

```bash
npm run typecheck
```

Expected: PASS for both server and tui workspaces.

**Step 2: If anything in the checklist fails, fix it and commit. If everything passes:**

```bash
git log --oneline -15
```

Confirm the commit chain matches the task order, then post a summary back to
the user.

---

## Notes for the executor

- **Do not** add backwards-compat shims. Browse mode is fully removed; if a
  helper becomes unused after Task 12, delete it.
- **Do not** add tests — the project has no test runner for the TUI side. The
  gate is `bun run typecheck` plus Task 14's manual checks.
- **Do not** fold `ModelPicker` into the palette in this plan. It stays a
  separate overlay (the design doc explicitly defers this).
- **Do not** add a "rename session" action. The server has no rename API and
  adding one is out of scope.
- If a typecheck fails mid-task, fix it before committing. Do not stack
  failing commits.
