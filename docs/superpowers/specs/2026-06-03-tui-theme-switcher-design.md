# TUI Theme Switcher (`/theme`)

Date: 2026-06-03
Status: Approved design, pending spec review

## Goal

Let the user switch the TUI's accent color scheme at runtime via a `/theme`
command, choosing among a small set of well-known palettes. The monochrome base
(backgrounds, text grays, borders, selection, transcript layout) stays exactly
as it is today and is identical in every theme. Only the accent tokens that
already carry hue change.

## Scope

In scope:
- Split `tui/src/theme.ts` into a fixed BASE and swappable ACCENT layer.
- Ship four palettes: Gruvbox (default), Catppuccin Mocha, Nord, Tokyo Night.
- `/theme` interactive picker, `/theme <name>` direct set, `/theme list` notice.
- Persist the chosen palette and restore it on launch.
- Live re-render on switch (no restart, scroll position preserved).

Out of scope:
- Changing any BASE token, background, or transcript rendering/layout.
- A user-authored / custom palette format. (YAGNI for now.)
- Theming anything that does not already read a color from `theme`.
- Server-side persistence — theme is a pure TUI presentation concern.

## Token model

`theme.ts` is reorganized into two groups. The exported `theme` object is the
merge of BASE plus the active palette's ACCENT values, and is the live object
every component reads today (no consumer import changes).

### BASE (fixed monochrome — never swapped, identical across all themes)
- `bg`, `bgPanel`, `bgCard`, `bgHeader`
- `text`, `textMuted`, `textSubtle`, `textFaint`
- `border`, `borderFocused`
- `selectionBg`, `selectionFg`
- `accent` (#ffffff), `accentDim`
- `mdHeading`, `mdQuote`, `mdListMarker`, `mdStrikethrough`
- `diffAddBg`, `diffRemBg` (subtle dark tints; structural to diff rendering)

### ACCENT (supplied by the active palette — the only tokens that change)
- Tool category: `toolEdit`, `toolRead`, `toolBash`, `toolWeb`, `toolTask`, `toolError`
- Markdown: `mdCode`, `mdLink`, `mdLinkUrl`
- Diff foreground: `diffAddFg`, `diffRemFg`
- Runner identity: `runnerClaude`/`runnerClaudeIdle`, `runnerCodex`/`runnerCodexIdle`,
  `runnerVercel`/`runnerVercelIdle`, `runnerOllama`/`runnerOllamaIdle`
- `gitDirty`

### Semantic mapping rule
Runner hues keep their family in every palette so identity stays recognizable:
claude = green, codex = amber/orange, vercel = teal/aqua, ollama = violet/mauve.
Each `*Idle` is a darkened version of its active hue. Tool/markdown tokens map to
the nearest role in the palette (edit/add = green, bash = yellow, web/code/link =
blue, task = mauve/purple, error/remove = red).

## Palette definitions

All hexes below are ACCENT values only; BASE is unchanged. Where a palette's
limited range forces `toolTask` and `runnerOllama` onto the same purple, that is
accepted — they never render adjacent in a confusing way.

### Gruvbox (default)
| token | hex |
|-------|-----|
| toolEdit | #b8bb26 |
| toolRead | #a89984 |
| toolBash | #fabd2f |
| toolWeb | #83a598 |
| toolTask | #d3869b |
| toolError | #fb4934 |
| mdCode | #83a598 |
| mdLink | #83a598 |
| mdLinkUrl | #458588 |
| diffAddFg | #b8bb26 |
| diffRemFg | #fb4934 |
| runnerClaude / Idle | #b8bb26 / #79740e |
| runnerCodex / Idle | #fe8019 / #7c4a1e |
| runnerVercel / Idle | #8ec07c / #4a6b42 |
| runnerOllama / Idle | #b16286 / #5c3450 |
| gitDirty | #d65d0e |

### Catppuccin Mocha
| token | hex |
|-------|-----|
| toolEdit | #a6e3a1 |
| toolRead | #bac2de |
| toolBash | #f9e2af |
| toolWeb | #89b4fa |
| toolTask | #cba6f7 |
| toolError | #f38ba8 |
| mdCode | #89b4fa |
| mdLink | #89b4fa |
| mdLinkUrl | #6c95d6 |
| diffAddFg | #a6e3a1 |
| diffRemFg | #f38ba8 |
| runnerClaude / Idle | #a6e3a1 / #4f7a4c |
| runnerCodex / Idle | #fab387 / #7a5a42 |
| runnerVercel / Idle | #94e2d5 / #486e68 |
| runnerOllama / Idle | #b4befe / #5a5e7e |
| gitDirty | #eba0ac |

### Nord
| token | hex |
|-------|-----|
| toolEdit | #a3be8c |
| toolRead | #8b94a3 |
| toolBash | #ebcb8b |
| toolWeb | #81a1c1 |
| toolTask | #b48ead |
| toolError | #bf616a |
| mdCode | #88c0d0 |
| mdLink | #88c0d0 |
| mdLinkUrl | #5e81ac |
| diffAddFg | #a3be8c |
| diffRemFg | #bf616a |
| runnerClaude / Idle | #a3be8c / #50603f |
| runnerCodex / Idle | #d08770 / #6e4639 |
| runnerVercel / Idle | #8fbcbb / #496160 |
| runnerOllama / Idle | #b48ead / #5c4a58 |
| gitDirty | #d0a070 |

### Tokyo Night
| token | hex |
|-------|-----|
| toolEdit | #9ece6a |
| toolRead | #a9b1d6 |
| toolBash | #e0af68 |
| toolWeb | #7aa2f7 |
| toolTask | #bb9af7 |
| toolError | #f7768e |
| mdCode | #7dcfff |
| mdLink | #7aa2f7 |
| mdLinkUrl | #547ac0 |
| diffAddFg | #9ece6a |
| diffRemFg | #f7768e |
| runnerClaude / Idle | #9ece6a / #4f6837 |
| runnerCodex / Idle | #e0af68 / #6f5736 |
| runnerVercel / Idle | #7dcfff / #3f687f |
| runnerOllama / Idle | #bb9af7 / #5d4d7b |
| gitDirty | #ff9e64 |

## Switch mechanism (minimal store + live re-render)

Chosen over the per-consumer `useTheme()` hook because the TUI uses **no
`React.memo`** and `Transcript` renders its items inline (verified), so a single
root subscription re-renders the whole tree and every inline `theme.*` read
updates. This keeps the diff small and preserves scroll position (no remount).

`theme.ts` gains:
- `PALETTES`: a record of palette name -> ACCENT map.
- `theme`: the live exported object, initialized to `{ ...BASE, ...PALETTES[active].accents }`.
- `applyPalette(name)`: `Object.assign(theme, PALETTES[name])`, update the stored
  active name, rebuild the markdown style, and notify subscribers.
- A minimal store: `subscribeTheme(cb)` / `getThemeName()` for `useSyncExternalStore`.
- `THEME_NAMES` and an alias resolver (`catppuccin`/`mocha`, `tokyonight`/`tokyo`, etc.).

`app.tsx`:
- `const themeName = useSyncExternalStore(subscribeTheme, getThemeName)` near the
  root. When `applyPalette` notifies, `themeName` changes and the tree re-renders,
  re-reading the mutated `theme`.
- A one-line guard comment at the transcript render boundary: themed via live
  re-render; do not wrap in `React.memo` without switching that subtree to a
  `useTheme()` hook.

`markdown-style.ts`:
- Replace the module-scope `markdownStyle` const with `buildMarkdownStyle()` that
  reads the current `theme`. `applyPalette` rebuilds it and the consumer
  (`Transcript`) selects the current built style keyed on `themeName`, so markdown
  accents (`mdCode`/`mdLink`/`mdLinkUrl`) update on switch.
- `index.tsx` keeps reading `selectionBg`/`selectionFg` (BASE) — unaffected.

## Command + picker UX (mirrors `/model`)

Grammar (parsed in `tui/src/util/slash.ts`):
- `/theme` (no args) -> `{ kind: "picker" }`
- `/theme <name>` -> `{ kind: "set", name }` (resolved through the alias table)
- `/theme list` | `show` | `status` -> `{ kind: "list" }`
- unknown name -> `{ kind: "list" }` (prints options as a notice rather than failing)

Add a `SlashCommand` variant `{ type: "theme"; action: ThemeAction }` and a
`SLASH_COMMANDS` entry: `/theme [list | <name>]` -> "switch color palette".

`ThemePicker.tsx` (new): an overlay modeled on `ModelPicker.tsx` — arrow keys to
move, enter to apply, esc to cancel. Each row shows the palette name plus a small
swatch line of its key accents (edit/bash/web/task/error) rendered with that
palette's hexes so the user previews before committing. Applying calls
`applyPalette(name)` and persists.

`app.tsx` handles the command: `picker` opens the overlay (a `themePicker`
state flag like `modelPicker`); `set` calls `applyPalette` + persist + notice;
`list` prints a notice of available names with the active one marked.

## Persistence

A small TUI-local prefs file (the only field for now is the palette name), stored
under the user's config directory (`XDG_CONFIG_HOME` or `~/.config`, app subdir).
- Read on boot in `index.tsx` and call `applyPalette(stored)` **before first
  render**, so launch colors and the initial markdown style are correct.
- Write on every successful switch (picker apply or `/theme <name>`).
- Missing/unreadable/invalid value -> fall back to Gruvbox; never throw.

## Error handling

- Unknown `/theme <name>` -> list notice, no state change.
- Prefs read failure (missing file, bad JSON, unknown name) -> default Gruvbox.
- Prefs write failure -> swallow with a debug-level log; the in-session switch
  still applies (persistence is best-effort, not load-bearing).

## Testing

- `slash.test.ts`: `/theme`, `/theme nord`, `/theme TokyoNight` (alias + case),
  `/theme list`, `/theme bogus` -> `list`.
- `theme.ts` unit test: `applyPalette` mutates the live `theme` accent tokens,
  leaves every BASE token unchanged, notifies subscribers, and resolves aliases.
- Persistence unit test: round-trip write/read; invalid/missing -> Gruvbox.
- All hexes are ASCII; no emoji anywhere (repo rule).

## Notes / decisions

- Default on fresh install is **Gruvbox**, not the previous grayscale-accent set;
  this intentionally changes first-launch accent colors. The Mono accent set is
  retired and not offered as a selectable palette.
- Mechanism tradeoff accepted: live re-render depends on the transcript subtree
  not being memoized (true today, guarded by comment). If memoization is later
  introduced, migrate consumers to a `useTheme()` hook.
