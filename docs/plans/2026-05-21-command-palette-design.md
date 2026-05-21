# Command Palette Design

Date: 2026-05-21
Status: approved, ready for implementation plan

## Goal

Remove the always-on sidebar in favor of an interactive command palette overlay
that handles session switching today and grows to cover skills, MCP servers,
and a global Ctrl+K jump-to-anything. Free up 28 columns of permanent terminal
real estate and unify the three currently-static read-only commands
(`/sessions`, `/skills`, `/mcp`) under one consistent UI.

## Scope

In scope:
- Build a reusable `<Palette>` component (search + filtered list + per-item
  actions).
- Wire four modes: `sessions`, `skills`, `mcp`, `global`.
- Trigger via slash commands and a new Ctrl+K hotkey.
- Delete `Sidebar.tsx` and the related browse-mode keyboard logic.
- Add a compact session pill (`sess 3●1`) to the existing `MetaRow` so users
  retain at-a-glance awareness.

Out of scope (deferred):
- Folding `ModelPicker` into the palette. It stays as-is for now.
- Multi-select / batch operations.
- Mouse support.

## Approach (chosen)

Build the palette by hand using opentui's existing `<input>`, `<scrollbox>`,
and `useKeyboard` primitives, following the established `ModelPicker.tsx`
overlay pattern. Filter with the already-installed `fuzzysort`. No new
dependencies.

Rejected alternatives:
- Adopt `opentui-ui`'s `useDialog()` modal manager. Adds a dep and a second
  overlay mental model when we already have one working.
- Use `SelectRenderable` (opentui core's imperative list widget). Doesn't
  match the React component style used throughout `tui/src/components/`.

## Component shape

One file: `tui/src/components/Palette.tsx`.

```ts
type PaletteItem = {
  id: string;
  label: string;            // primary line, used for fuzzy match
  detail?: string;          // dim secondary line / right-side metadata
  badge?: { text: string; color: string }; // optional left-side type tag
  streaming?: boolean;      // shows pulsing dot (sessions mode)
  actions?: PaletteAction[];// secondary actions opened on space
  onActivate: () => void;   // primary action — fired on enter
};

type PaletteAction = {
  key: string;              // single-letter shortcut inside action sheet
  label: string;
  destructive?: boolean;
  run: () => void;
};

type PaletteProps = {
  title: string;            // e.g. "switch session", "jump to anything"
  placeholder: string;      // e.g. "search sessions…"
  items: PaletteItem[];
  onClose: () => void;
  footer?: string;          // optional override of the default key hints
};
```

The palette is purely presentational — `App.tsx` builds the `PaletteItem[]`
for each mode and passes it in. That keeps domain logic (session/skill/mcp
state) where it already lives.

## Keyboard model

Identical across all modes:

```
↑ / ↓        navigate
type         filter (fuzzysort over label + detail)
enter        run primary action
space        open per-item action sheet (if item has actions)
esc          close (or back out of action sheet)
ctrl+n       sessions mode only: new session
```

When the action sheet is open it captures keystrokes:
- Letter keys match `PaletteAction.key`.
- `esc` returns to the list.
- Destructive actions (delete) require a double-press within 1.5s — same
  pattern as the current `dd` in browse mode.

## State flow

```
App.tsx
 ├─ palette: { mode } | null      (new useState)
 │
 ├─ slash handler
 │    case "sessions": setPalette({ mode: "sessions" })
 │    case "skills":   setPalette({ mode: "skills" })
 │    case "mcp":      setPalette({ mode: "mcp" })
 │      (the bare command — sub-commands like /mcp add still print notices)
 │
 ├─ global keyboard
 │    ctrl+k: setPalette({ mode: "global" })
 │
 └─ render
      {palette && <Palette {...itemsFor(palette.mode)} onClose={() => setPalette(null)} />}
```

Palette and `Prompt` lock each other the same way `ModelPicker` already does:
when `palette !== null`, the prompt receives `locked={true}` and ignores
keystrokes; the palette owns `useKeyboard` until it closes.

## Per-mode item generation

**sessions mode** — items from `api.sessions`:
- label: `session.title`
- detail: `basename(cwd) · runner · N msgs`
- streaming: `session.streaming`
- badge: runner color
- onActivate: `api.setActive(session.id)` then close
- actions:
  - `d` delete (destructive, double-tap)
  - `r` rename (opens an inline input replacing the action sheet)
- ctrl+n: `api.createSession()` then close

**skills mode** — items from `listSkills(activeRunner)`:
- label: `skill.name`
- detail: `skill.description` clipped
- onActivate: show frontmatter (`skillInfoLines`) as a notice and close
- actions:
  - `d` remove (destructive, double-tap)
  - `i` info (same as activate)

**mcp mode** — items from `listMcp(activeRunner)` (parsed from CLI stdout):
- label: server name
- detail: command string
- onActivate: test (`testMcp`) — fire-and-forget, notice rendered when done
- actions:
  - `t` test (same as activate)
  - `d` remove (destructive, double-tap)

**global mode** — concatenated items:
- All sessions (badge "session")
- All slash commands from `SLASH_COMMANDS` (badge "cmd")
- All skills (badge "skill")
- All mcp servers (badge "mcp")

The fuzzy filter is run over `"${badge.text} ${label} ${detail}"` so users can
type `sess foo` to find a session, or `mcp fetch` to find an MCP server.

## Sidebar removal

Files affected:
- `tui/src/components/Sidebar.tsx` — deleted.
- `tui/src/app.tsx`:
  - Remove `SIDEBAR_WIDTH`, the `<Sidebar/>` element, and the row layout
    wrapping it.
  - Delete the `focus` state, the `useKeyboard` browse-mode block (j/k/n/dd,
    ctrl+b), `lastDeleteRef`, and the `onUnfocus` plumbing on `Prompt`.
  - Remove the `ctrl+b` and j/k/n/dd entries from `helpLines()` in
    `tui/src/util/notice.ts`. Replace with `ctrl+k palette` and
    `/sessions, /skills, /mcp open palette`.
- `tui/src/components/Prompt.tsx`:
  - Drop `onUnfocus` and the `ctrl+b` handler (palette replaces browse mode).
  - In `MetaRow`, add the session pill: render `sess Nact●Sstr` where `Nact`
    is the total session count and `Sstr` is the streaming count. Hidden when
    only 1 non-streaming session exists.

## Data flow for the session pill

`App.tsx` already has `api.sessions`. Compute `{ total: sessions.length,
streaming: sessions.filter(s => s.streaming).length }` and pass to `Prompt` as
new `sessionPill` prop. Pure derivation, no new state.

## Testing & verification

This is UI code without an automated test harness in the project, so the
verification gate is manual:
- TypeScript: `npm run typecheck` must pass.
- Launch the TUI, confirm:
  - sidebar gone, terminal width reclaimed
  - `/sessions` opens palette, arrow keys move, enter switches, esc closes
  - typing filters via fuzzysort
  - space opens action sheet, `d` deletes (double-tap), `r` renames
  - ctrl+n creates a new session
  - ctrl+k opens global mode, fuzzy across types works
  - `/skills` and `/mcp` open their modes
  - session pill in MetaRow reflects count + streaming count live

## Migration / cleanup checklist

- [ ] Add `Palette.tsx`
- [ ] Wire palette state + slash routing + ctrl+k in `App.tsx`
- [ ] Add session pill to `MetaRow` in `Prompt.tsx`
- [ ] Delete `Sidebar.tsx`
- [ ] Strip browse-mode state from `App.tsx` and `Prompt.tsx`
- [ ] Update `helpLines()` in `notice.ts`
- [ ] Remove now-unused `sessionsLines`, `skillsLines`, `mcpListLines` text
      builders if no other callers remain (likely yes — bare commands now
      open the palette; the sub-commands with args still print notices, so
      these helpers may stay)
- [ ] Manual verification per above
