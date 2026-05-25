# Peers Panel Design

Date: 2026-05-25
Status: approved, ready for implementation plan

## Goal

Lift the in-flight peer state (delegate / consensus / validate) out of the
scrolling transcript and into a fixed side rail on the right of the TUI so
users can keep watching a peer's progress while they scroll the chat. The
rail only exists when there is at least one running peer; on idle sessions
the chat reclaims full width.

Closes the recurring "I scrolled up to re-read the prompt and lost sight of
what the delegate is doing" friction. Today the `PendingHeader` inside the
assistant message is the only live view, and it gets pushed out of view by
subsequent assistant blocks.

## Scope

In scope:

- New `<PeersPanel>` component rendered to the right of the chat column.
- Auto-appears when `session.delegations.running > 0`; auto-hides
  otherwise.
- One block per in-flight peer: status dot, runner badge, tag, verb, live
  elapsed timer, tool/char counters, last tool summary, writing tail.
- A short-lived completion footer (~6 s) showing the verdict before the
  block disappears, so the user sees how it ended even if they were
  scrolled elsewhere.
- Width responsive: hidden on terminals narrower than 90 cols (chat
  fully reclaims). Toggleable with `ctrl+b` for explicit show/hide.

Out of scope (deferred):

- Persistent history of completed peers. Closed runs disappear once the
  6-second completion glance ends; chat is the historical record.
- Multiple-session rollup (e.g. "5 peers running across 3 sessions").
  Rail only shows the active session's peers.
- Click-to-jump from a rail block to its inline `PendingHeader` in the
  transcript. Nice-to-have, not v1.
- Pinning, manual reordering, collapsing individual blocks.

## Approach (chosen)

Reuse the data path that already feeds `PendingHeader`. The
`groupDelegations` helper in `tui/src/util/blocks.ts` already builds a
`delegation_group` for every in-flight peer of the active session, with
the same `pendingRunner`, `tag`, and child stream the inline header reads.
The rail is a second consumer of that grouping — no new server work, no
new event types.

The rail mounts when grouping returns ≥1 `delegation_group` with
`header === null` (pending). Each pending group becomes one rail block;
the inline `PendingHeader` continues to render unchanged inside the
transcript (deliberate redundancy — same lesson as the Prompt rail's
duplicated meta fields, see memory `feedback_dedupe_visible_info.md`).

Completion footer: when a previously-pending group flips to
`header !== null`, the rail keeps the block for 6 s with the verdict /
runner / char-count, then drops it. Tracked in component-local state
keyed by `group.id` — no protocol change.

Rejected alternatives:

- **Reuse `<ToolCard>` for rail blocks.** Cards are tuned for the
  full-width transcript; squeezing them into 24–32 cols breaks their
  meta row. A dedicated `PeerBlock` renderer is cheaper than retrofitting.
- **Server-pushed `peer_panel` snapshot event.** Would let the rail
  render without traversing message events, but the data is already on
  the client and re-deriving it for the rail is microseconds. Adding an
  event type now is premature.
- **Always-on rail with an "idle" placeholder.** Repeats the session
  sidebar mistake (commit 209ba3f) — static rail competing for space
  with cmd+k. Hide-when-empty is what makes this earn its room.

## Component shape

One file: `tui/src/components/PeersPanel.tsx`.

```ts
type PeersPanelProps = {
  session: Session | null;
  // Width of the rail in columns once visible (computed by App).
  width: number;
  // The latest assistant message id is needed to know which delegation
  // groups are eligible to be "pending" (same gating as Transcript).
  streamingMessageId: string | null;
};

// Block-level data the rail consumes. Computed in PeersPanel from the
// active session's delegation_groups; closed runs the rail still wants
// to show get the same shape plus `verdict`.
type PeerBlock = {
  id: string;
  state: "running" | "completing";
  tag: "delegate" | "validate" | "consensus";
  runner: RunnerKind | null;
  startedAt: number;          // ms epoch from first peer event
  toolCount: number;
  lastSummary: string | null;
  replyChars: number;
  replyTail: string;
  // Only set when state === "completing"
  verdict?: { kind: "pass" | "needs_changes" | "fail" | "ok" | "error"; summary: string };
};
```

Internal state:

```ts
// Completion glance: maps group id -> when the run finished (ms). Driven
// by an effect that diffs the previous-vs-current set of pending groups.
const [completed, setCompleted] = useState<Record<string, CompletedEntry>>({});
```

Rendering:

- Outer `<box>` width = `props.width`, full vertical, single left border.
- Header row: `peer activity` + count badge in muted text.
- Body: `<scrollbox>` containing one `<PeerBlock>` per active+completing
  block, sorted by `startedAt` ascending (oldest at top — long-running
  delegates stay anchored while short validates flash in and out).
- Per block: leading `StatusDot` (running/pending), `[runner] tag`
  header in the runner colour, verb, elapsed time, counters, summary,
  writing tail.
- A `useEffect` ticks a 1 Hz timer to refresh elapsed timers in the
  visible blocks. Only one timer for the whole panel; bail when no
  pending blocks.

## Behavior

### Show/hide

```
delegations.running > 0   ->  rail visible
delegations.running == 0
   AND no `completing` blocks  ->  rail hidden
```

Plus the manual `ctrl+b` toggle, which overrides the auto rule until the
user toggles again or switches sessions.

### Width

```
visible = (railToggle === "auto" && railEligible)
        || railToggle === "shown"
width  = clamp(22, round(terminalWidth * 0.22), 32)
hidden when terminalWidth < 90  (regardless of toggle, to protect chat)
```

### States per block

| Phase       | StatusDot | Tag colour                        | Verb          |
|-------------|-----------|-----------------------------------|---------------|
| delegate    | pulsing   | `theme.toolTask` (mauve)          | `working…`    |
| validate    | pulsing   | `theme.toolEdit` (sage)           | `validating…` |
| consensus   | pulsing   | `theme.toolBash` (amber)          | `drafting…`   |
| completing  | static ✓ / ✗ | verdict colour (pass/sage, needs_changes/amber, fail/brick) | verdict text |

### Completion glance

When a `delegation_group` transitions from `header === null` to
`header !== null`, the rail keeps the block with `state: "completing"`
for 6 s. The block's writing tail is replaced by the verdict + summary
line. After the timer the block is removed; if it was the last one and
no new peer started, the entire rail unmounts.

## Integration points

- `tui/src/app.tsx`
  - Wrap the existing `<Transcript> + <Spinner> + <Prompt>` stack in a
    horizontal `<box>` with a left "chat column" and a right
    `<PeersPanel>`.
  - Add `railToggle: "auto" | "shown" | "hidden"` state (per-session
    would be over-engineered; global is fine for v1).
  - Add `ctrl+b` handler next to the existing `ctrl+k` / `ctrl+e`
    handlers.
  - Pass `streamingMessageId = session.streaming ? lastMsg?.id : null`
    so PeersPanel matches the transcript's pending-group gating.

- `tui/src/util/blocks.ts`
  - Export a thin helper `pendingDelegations(session, streamingMessageId)
    -> GroupedBlock[]` that returns just the `delegation_group` entries
    with `header === null` for the most recent assistant message. Used
    by the rail; existing `groupDelegations` stays untouched.

- `tui/src/components/PeersPanel.tsx` (new)
- `tui/src/components/PeerBlock.tsx` (new, internal to PeersPanel; one
  file unless it grows past ~150 lines)

No backend or shared-protocol changes.

## Empty states & edge cases

- Session switched mid-flight: the rail re-derives from the new session
  on next render. The previous session's running peer is still tracked
  by the server; switching back resumes the live view.
- Session deleted while its peer is running: rail unmounts with the
  session (no special handling — App already drops state).
- Terminal resize that crosses the 90-col threshold: rail auto-hides /
  appears with no transition animation. opentui re-layout is instant.
- `ctrl+b` while rail is auto-hidden because of terminal width: still
  toggles the preference, but takes effect only when width allows.
- `ctrl+b` while the prompt has focus: must coexist with whatever the
  prompt input binds. Confirmed unused today (`Prompt.tsx` does not
  bind `ctrl+b`). If a future input addition reclaims it, swap to
  `ctrl+\\`.

## Open questions

1. **Completion glance duration.** 6 s is a guess. The `validate`
   verdict ("pass") needs less time than a `consensus` summary
   ("agree on approach but suggest splitting login.ts"). Could vary by
   tag. Punting until we see real usage.
2. **Order: oldest-first or newest-first?** Picked oldest-first so a
   long delegate doesn't reshuffle when a fast validate fires in the
   middle. Will revisit if it feels wrong.
3. **Rail above prompt vs full-height?** Full-height in v1 (visually
   simplest). If the prompt's meta row clashes at the bottom, the rail
   can stop above the prompt instead.

## Risk

Low. New code is rail-side and purely presentational; no protocol
changes; reuses an existing data path. Worst-case rollback is deleting
two files and the four-line app.tsx wrapper.

The sole behavioural change visible outside the new component is the
chat column shrinking by 22–32 cols when peers run, which has the same
markdown-wrap impact as opening any overlay today. The 90-col guard
keeps narrow-terminal users unaffected.
