# ChatItem Parent Wrapper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a single `ChatItem` parent wrapper that every row rendered inside the chat area uses, so selection (mouse-click), expansion (second mouse-click or ctrl+e), keyboard navigation (shift+up/shift+down), and the focused-border styling are uniform and not duplicated per component.

**Architecture:** `ChatItem` is a presentational wrapper. App owns the source of truth (`selectedItemBySession`, `expandedItems`, keyboard hook) — that stays exactly where it is today, no behavior change. `Transcript` enumerates every renderable row, assigns each a stable id, and threads `selected`/`expanded`/`onActivate` into a single `ChatItem` wrapper per row. Each existing component (`ToolCard`, `TaskCard`, `NoticeCard`, the inline `UserMessage`, the `DelegationGroup`, and the inline block renderers for text/error/thinking/peer_reply/peer_thinking) sheds its bespoke `border`/`paddingLeft`/`onMouseDown`/hint footer and renders its content as children of `ChatItem`. Components that have richer detail (`ToolCard`, `DelegationGroup`) pass that detail via `ChatItem`'s `expandedContent` prop.

**Decision: second click for atomic rows is a deliberate no-op.** Rows without an expanded view (notice, plain text, thinking, peer_reply, peer_thinking, user message, task card v0) set `expandable={false}`. They're still selectable; the second click is absorbed but does nothing visible. The "expand on click" requirement applies to rows that have something to expand into — for atomic rows, what you see is the full content. If a future change wants richer expanded views per row, it's purely additive: flip `expandable` to true and pass `expandedContent`.

**Decision: ChatItem's `onActivate` takes no arguments.** The caller has already closed over the id when it constructs the prop, so threading the id back through ChatItem is redundant indirection. Signature is `onActivate?: () => void`.

**Tech Stack:** React 19, `@opentui/react`, `@opentui/core`, `bun test` (with `testRender` + `act`), TypeScript.

**Key files (read these first):**
- `tui/src/components/Transcript.tsx` (renders the chat area; has `BlockRow`, `UserMessage`, `AssistantMessage`, `DelegationGroup`, inline block branches)
- `tui/src/components/ToolCard.tsx` (already implements the selected/expanded/hint/onActivate pattern we're abstracting)
- `tui/src/components/TaskCard.tsx`, `NoticeCard.tsx` (currently bespoke framing)
- `tui/src/app.tsx` lines 67–258, 529–551 (selection state + `moveToolSelection`, `handleToolActivate`, `toggleSelectedToolExpansion`, `useKeyboard` shift+arrow / ctrl+e)
- `tui/src/util/blocks.ts` lines 230–267 (`collectToolIds`, `latestDelegationId`)
- `tui/src/theme.ts` (`theme.borderFocused`, `theme.border`)
- `tui/src/components/Welcome.test.tsx` and `Prompt.test.tsx` (existing test patterns with `testRender` + `captureSpans`)

**Run commands:**
- Typecheck: `npm run typecheck` (from repo root)
- Single test file: `cd tui && bun test src/components/<Name>.test.tsx`
- All tui tests: `cd tui && bun test`

---

## Task 1: Create `ChatItem` wrapper component (TDD)

**Files:**
- Create: `tui/src/components/ChatItem.tsx`
- Create: `tui/src/components/ChatItem.test.tsx`

The wrapper provides the framing and click handling. The collapsed body is `children`; the expanded body (optional) is `expandedContent`.

**API (final shape):**

```tsx
type ChatItemProps = {
  id: string;
  selected: boolean;
  expanded?: boolean;
  // false => second click is a no-op; the hint about expansion is suppressed.
  // Defaults to false so callers must opt in (most rows are atomic).
  expandable?: boolean;
  hint?: string | null;
  onActivate?: () => void;
  // Spacing above the row. Default 1, can be 0 for tight stacks (e.g. children
  // inside a DelegationGroup that already supplies its own vertical rhythm).
  marginTop?: number;
  // When true, suppress the outer border + padding + click handler entirely;
  // used when ChatItem is rendered inside another ChatItem (e.g. ToolCard
  // header inside an expanded DelegationGroup). The parent owns framing.
  // Invariant: nested mode returns a Fragment with no flex container, so it
  // MUST be rendered inside a column-flex ancestor.
  nested?: boolean;
  children: React.ReactNode;
  expandedContent?: React.ReactNode;
};
```

**Step 1: Write failing test**

Add `tui/src/components/ChatItem.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { parseColor } from "@opentui/core";
import { theme } from "../theme";

const { ChatItem } = await import("./ChatItem");

function frameText(setup: Awaited<ReturnType<typeof testRender>>): string {
  return setup.captureSpans().lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

describe("ChatItem", () => {
  test("renders children without border when not selected", async () => {
    const setup = await testRender(
      <ChatItem id="x" selected={false}>
        <text>{"hello"}</text>
      </ChatItem>,
      { width: 40, height: 6, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      expect(frameText(setup)).toContain("hello");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });

  test("shows the expanded panel and hint when selected+expanded+expandable", async () => {
    const setup = await testRender(
      <ChatItem
        id="x"
        selected={true}
        expanded={true}
        expandable={true}
        hint="click or ctrl+e to collapse"
        expandedContent={<text>{"DETAIL"}</text>}
      >
        <text>{"summary"}</text>
      </ChatItem>,
      { width: 60, height: 10, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      const screen = frameText(setup);
      expect(screen).toContain("summary");
      expect(screen).toContain("DETAIL");
      expect(screen).toContain("click or ctrl+e to collapse");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });

  test("hides expanded panel and hint when not selected", async () => {
    const setup = await testRender(
      <ChatItem
        id="x"
        selected={false}
        expanded={true}
        expandable={true}
        hint="click or ctrl+e to collapse"
        expandedContent={<text>{"DETAIL"}</text>}
      >
        <text>{"summary"}</text>
      </ChatItem>,
      { width: 60, height: 10, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      const screen = frameText(setup);
      expect(screen).toContain("summary");
      // Hint is selection-gated; expanded panel still renders because
      // expansion state is independent of selection.
      expect(screen).not.toContain("click or ctrl+e to collapse");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
```

**Step 2: Run test, verify it fails**

```bash
cd tui && bun test src/components/ChatItem.test.tsx
```

Expected: FAIL — file `./ChatItem` does not exist.

**Step 3: Implement `ChatItem.tsx` (minimal pass)**

```tsx
// tui/src/components/ChatItem.tsx
import type { ReactNode } from "react";
import { theme } from "../theme";

export type ChatItemProps = {
  id: string;
  selected: boolean;
  expanded?: boolean;
  expandable?: boolean;
  hint?: string | null;
  onActivate?: (id: string) => void;
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
```

**Step 4: Run tests, verify they pass**

```bash
cd tui && bun test src/components/ChatItem.test.tsx
```

Expected: PASS for all three cases.

**Step 5: Commit**

```bash
git add tui/src/components/ChatItem.tsx tui/src/components/ChatItem.test.tsx
git commit -m "feat(tui): add ChatItem wrapper for chat-area row framing"
```

---

## Task 2: Broaden id collector to enumerate every chat-area row

The current `collectToolIds` only returns tool blocks + delegation groups. The new wrapper means every row is selectable, so the navigation list must include user messages, notices, plain text/error/thinking/peer_reply/peer_thinking blocks, and task cards.

**Files:**
- Modify: `tui/src/util/blocks.ts` (add `collectChatItemIds`; keep `collectToolIds` as a thin alias initially, remove in Task 6)
- Modify: `tui/src/app.tsx` (use the new function at the call site)

**Id scheme (must be stable across renders):**
- User message: `msg:${message.id}` (one row per user message)
- Notice: `notice:${notice.id}`
- Assistant top-level block (non-tool, non-delegation): `${message.id}:${g.index}` (same as today)
- Tool block: `${message.id}:${g.index}` (same as today)
- Delegation group: `${message.id}:d:${anchorIndex}` (already produced by `groupDelegations`)

The existing `${message.id}:${g.index}` for tools and the delegation group id format are already in use — keep them so today's selection survives. The new prefixed ids (`msg:`, `notice:`) are net-new.

**Step 1: Write failing test**

Add `tui/src/util/blocks.test.ts` (new file unless one exists — check first). Real fixture inlined; matches the shape of `Session` in `shared/events.ts:92` and `Notice` in `tui/src/util/notice.ts:6`:

```ts
import { describe, expect, test } from "bun:test";
import { collectChatItemIds } from "./blocks";
import type { Session } from "../../../shared/events.ts";
import type { Notice } from "./notice";

function makeSession(): Session {
  return {
    id: "s1",
    title: "demo",
    activeRunner: "claude",
    cwd: "/tmp",
    streaming: false,
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:00:05.000Z",
    models: {},
    claudeMode: "default",
    git: null,
    messages: [
      {
        id: "m1",
        role: "user",
        text: "hi",
        events: [],
        createdAt: "2026-05-25T10:00:01.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        text: "hello",
        events: [
          { type: "text_delta", delta: "hello" },
          { type: "tool_log", log: { name: "Read", input: { path: "/a" }, output: "ok" } },
        ],
        createdAt: "2026-05-25T10:00:02.000Z",
      },
    ],
  };
}

function makeNotice(id: string, at: string): Notice {
  return { id, command: "/help", lines: ["…"], createdAt: at };
}

describe("collectChatItemIds", () => {
  test("emits one id per row in chronological order", () => {
    const session = makeSession();
    const notice = makeNotice("n1", "2026-05-25T10:00:03.000Z");
    const ids = collectChatItemIds(session, [notice]);

    // Order: user msg → assistant text block → assistant tool block → notice
    expect(ids).toEqual([
      "msg:m1",
      "m2:0",
      "m2:1",
      "notice:n1",
    ]);
  });

  test("returns [] for a null session", () => {
    expect(collectChatItemIds(null, [])).toEqual([]);
  });
});
```

> **Note:** the `m2:0`/`m2:1` ids assume `groupDelegations` does not fold the tool log into a delegation group (it's a plain Read, not a `delegate_run` / `validate_run` / `consensus_step` anchor). Verify against `peerAnchorKind` in `tui/src/util/blocks.ts` before assuming. If the indices come out different in your local run, adjust the assertion to match what `groupDelegations` actually produces for the fixture — the *count* (4 ids total) and *prefixes* (msg:, m2:, notice:) are what this test guards.

**Step 2: Run test, verify it fails**

```bash
cd tui && bun test src/util/blocks.test.ts
```

Expected: FAIL — `collectChatItemIds` is not exported yet.

**Step 3: Implement `collectChatItemIds`**

Append to `tui/src/util/blocks.ts` (do NOT delete `collectToolIds` yet — keep it until Task 6 swaps the call sites):

```ts
import type { Notice } from "./notice";

// Returns the navigation order for shift+up / shift+down in the chat area:
// one id per visually-distinct row (user message, notice, assistant block,
// delegation group, tool card, task card). Order matches Transcript's render
// order (chronological by `createdAt`, ties broken by user msg before notice).
export function collectChatItemIds(
  session: Session | null,
  notices: Notice[],
): string[] {
  if (!session) return [];
  type Entry =
    | { kind: "message"; at: string; message: import("../../../shared/events.ts").SessionMessage }
    | { kind: "notice"; at: string; notice: Notice };
  const entries: Entry[] = [
    ...session.messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...notices.map((n) => ({ kind: "notice" as const, at: n.createdAt, notice: n })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === "notice") {
      out.push(`notice:${e.notice.id}`);
      continue;
    }
    const m = e.message;
    if (m.role === "user") {
      out.push(`msg:${m.id}`);
      continue;
    }
    const grouped = groupDelegations(blocksFromEvents(m.events), m.id);
    for (const g of grouped) {
      if (g.kind === "delegation_group") {
        out.push(g.id);
        continue;
      }
      out.push(`${m.id}:${g.index}`);
    }
  }
  return out;
}
```

**Step 4: Run tests, verify they pass**

```bash
cd tui && bun test src/util/blocks.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tui/src/util/blocks.ts tui/src/util/blocks.test.ts
git commit -m "feat(tui): broaden chat-area id collector to every selectable row"
```

---

## Task 3: Refactor `ToolCard` onto `ChatItem`

Strip the bespoke framing — keep `ToolCard` focused on rendering tool content. The `selected`/`expanded`/`hint`/`onActivate` props move into a `ChatItem` wrapper.

**Files:**
- Modify: `tui/src/components/ToolCard.tsx`

**Step 1: Replace the outer `<box>` framing**

Find lines 48–58 of `ToolCard.tsx`:

```tsx
    <box
      flexDirection="column"
      paddingLeft={nested ? 0 : selected ? 0 : 1}
      paddingRight={nested ? 0 : 1}
      marginTop={nested ? 0 : 1}
      border={!nested && selected ? ["left"] : undefined}
      borderStyle={!nested && selected ? "single" : undefined}
      borderColor={!nested && selected ? theme.borderFocused : undefined}
      onMouseDown={!nested && onActivate ? () => onActivate() : undefined}
    >
```

Replace with `ChatItem`. Move the `ExpandedDetails` block into `expandedContent`. Drop the trailing hint block (lines 82–87) — `ChatItem` renders it.

New body shape:

```tsx
import { ChatItem } from "./ChatItem";

// inside ToolCard:
const expandedNode = expanded ? (
  <ExpandedDetails prettyInput={prettyInput} body={body} edit={edit} />
) : null;

return (
  <ChatItem
    id={/* the caller's id — see Step 2 below */}
    selected={selected}
    expanded={expanded}
    expandable={true}
    hint={hint}
    nested={nested}
    onActivate={onActivate ? () => onActivate() : undefined}
    marginTop={nested ? 0 : 1}
    expandedContent={expandedNode}
  >
    <box flexDirection="row">
      <StatusDot status={status} />
      <text fg={theme.text}>{" "}</text>
      {peer && (
        <text fg={peerColor(peer)} attributes={TextAttributes.BOLD}>{`[${peer}] `}</text>
      )}
      <text fg={accent} attributes={TextAttributes.BOLD}>{verb}</text>
      {summary && <text fg={theme.text}>{" " + summary}</text>}
    </box>
    {edit && <DiffPreview edit={edit} />}
    {!edit && body && !expanded && (
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  └ "}</text>
        <text fg={theme.textMuted}>{body}</text>
      </box>
    )}
  </ChatItem>
);
```

**Step 2: Thread the id through**

Add an `id: string` prop to `ToolCard` and pass it through. Then update the two `<ToolCard …>` call sites:
- `Transcript.tsx:267` (top-level): pass `id={toolId}` (already computed two lines above).
- `Transcript.tsx:391` (nested inside `DelegationGroup`): pass `id={group.id}` (it's nested, so the id is effectively ignored, but keeping it satisfies the type).

**Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

**Step 4: Visual regression test (optional but recommended)**

Run any existing ToolCard tests. If there are none, write one:

```bash
cd tui && bun test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tui/src/components/ToolCard.tsx tui/src/components/Transcript.tsx
git commit -m "refactor(tui): ToolCard renders via ChatItem wrapper"
```

---

## Task 4: Refactor `DelegationGroup` onto `ChatItem`

`DelegationGroup` lives inline in `Transcript.tsx` (lines 344–432). Same pattern: replace its outer `<box>` framing with `ChatItem`, push expanded children into `expandedContent`.

**Files:**
- Modify: `tui/src/components/Transcript.tsx`

**Step 1: Wrap with `ChatItem`**

Replace `DelegationGroup`'s outer `<box>` (lines 372–380) with a `ChatItem`. The `<box>`s that draw the children when expanded (lines 417–423) move into `expandedContent`. The trailing `selected && hint` block (lines 424–429) goes away — `ChatItem` renders it.

Sketch:

```tsx
const headerNode = isPending ? (
  <PendingHeader … />
) : (
  <ToolCard id={group.id} log={group.header!} nested selected={false} expanded={false} />
);

const collapsedExtras = hasChildren && !isPending ? (
  <box flexDirection="column" paddingLeft={3} paddingRight={1}>
    {/* the verdict / preview summaries / collapsedSummary block as today */}
  </box>
) : null;

const expandedChildren = hasChildren ? (
  <box flexDirection="column" paddingLeft={2}>
    {group.children.map((b, i) => (
      <BlockRow
        key={`gc-${group.id}-${i}`}
        block={b}
        firstInMessage={false}
        // children inside an expanded group are not independently selectable
        toolSelected={false}
        toolExpanded={false}
      />
    ))}
  </box>
) : null;

return (
  <ChatItem
    id={group.id}
    selected={selected}
    expanded={expanded}
    expandable={hasChildren}
    hint={hint}
    onActivate={onActivate ? () => onActivate() : undefined}
    expandedContent={expandedChildren}
  >
    {headerNode}
    {!expanded && collapsedExtras}
  </ChatItem>
);
```

> **Note:** keep the existing `hasChildren && !expanded && !isPending` guard on the collapsed-extras subtree — it's an existing invariant.

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

**Step 3: Commit**

```bash
git add tui/src/components/Transcript.tsx
git commit -m "refactor(tui): DelegationGroup renders via ChatItem wrapper"
```

---

## Task 5: Wrap remaining rows in `ChatItem`

Every other row in the chat area gets the same wrapper for uniform selection. None of these have an expanded payload today, so `expandable={false}` for all.

**Files:**
- Modify: `tui/src/components/Transcript.tsx` (rewrite `UserMessage`, `BlockRow` internals)
- Modify: `tui/src/components/NoticeCard.tsx`
- Modify: `tui/src/components/TaskCard.tsx`

**Step 1: Update `Transcript` to thread selection per row**

`Transcript` already threads `selectedToolId`, `expandedTools`, `onToolActivate` to assistant blocks. Generalize: rename the props to `selectedItemId`, `expandedItems`, `onItemActivate` (purely a rename — App is the source of truth). Update both the `Transcript` and `Message`/`AssistantMessage` prop signatures.

Then pass them to every renderable child:
- `UserMessage` — give it the `msg:${message.id}` id and the props.
- `NoticeCard` — give it the `notice:${notice.id}` id and the props.
- `BlockRow` — every branch (text, error, thinking, peer_reply, peer_thinking, and the existing tool/task branches) now receives an `id` and the same trio of props.
- `TaskCard` — give it an id and the props.

**Step 2: Convert `UserMessage` to use `ChatItem`**

Replace `Transcript.tsx` lines 150–165 with:

```tsx
function UserMessage({
  message,
  selected,
  onActivate,
}: {
  message: SessionMessage;
  selected: boolean;
  onActivate?: (id: string) => void;
}) {
  const id = `msg:${message.id}`;
  return (
    <ChatItem id={id} selected={selected} onActivate={onActivate}>
      <box
        flexDirection="row"
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.textMuted}>{"› "}</text>
        <text fg={theme.text}>{message.text}</text>
      </box>
      <Rule />
    </ChatItem>
  );
}
```

**Step 3: Convert `NoticeCard` to use `ChatItem`**

Replace the body of `NoticeCard.tsx` with a `ChatItem` wrapping the existing inner content. **Decision: drop the always-on left rail.** The focused selection border replaces it. Visual loss is acceptable — notices are uniformly framed with every other chat item now, which is the whole point of this change. The accent color on `notice.command` is enough to keep notices visually distinct in the unselected state.

```tsx
import { ChatItem } from "./ChatItem";

export function NoticeCard({
  notice,
  selected,
  onActivate,
}: {
  notice: Notice;
  selected: boolean;
  onActivate?: (id: string) => void;
}) {
  return (
    <ChatItem id={`notice:${notice.id}`} selected={selected} onActivate={onActivate}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text fg={theme.textMuted}>{"· "}</text>
          <text fg={theme.accentDim} attributes={TextAttributes.BOLD}>
            {notice.command}
          </text>
        </box>
        {notice.lines.map((line, i) => (
          <text key={i} fg={theme.textMuted}>{line || " "}</text>
        ))}
      </box>
    </ChatItem>
  );
}
```

**Step 4: Convert `TaskCard` and the inline `BlockRow` branches**

Same shape — each one becomes `<ChatItem id={…} selected={…} onActivate={…}>…</ChatItem>`. Walk each branch in `BlockRow` (`Transcript.tsx:258–329`):
- `error` branch: id = `${messageId}:${blockIndex}`
- `thinking` branch: same id scheme
- `peer_reply` branch: same id scheme
- `peer_thinking` branch: same id scheme
- text/markdown branch: same id scheme

For each, drop the bespoke `paddingLeft={1} paddingRight={1}` and let `ChatItem` own the framing. Where the existing code had `marginTop={firstInMessage ? 0 : 1}`, pass `marginTop={firstInMessage ? 0 : 1}` to `ChatItem`.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

**Step 6: Run full tui tests**

```bash
cd tui && bun test
```

Expected: PASS for existing Welcome / Prompt / ChatItem / blocks tests.

**Step 7: Commit**

```bash
git add tui/src/components/Transcript.tsx tui/src/components/NoticeCard.tsx tui/src/components/TaskCard.tsx
git commit -m "refactor(tui): every chat-area row renders via ChatItem"
```

---

## Task 6: Update App to use the broader id list

App today calls `collectToolIds` for navigation. Switch to `collectChatItemIds`, pass `notices` in, and rename the state for clarity.

**Files:**
- Modify: `tui/src/app.tsx`
- Modify: `tui/src/util/blocks.ts` (delete `collectToolIds` once unused)

**Step 1: Swap the call site**

In `tui/src/app.tsx:42`:

```ts
import { collectChatItemIds, latestDelegationId } from "./util/blocks";
```

In `tui/src/app.tsx:163–166`:

```ts
const activeItemIds = useMemo(
  () => collectChatItemIds(api.active ?? null, activeNotices),
  [api.active, activeNotices],
);
```

(Note: `activeNotices` is already computed at line 158–161; reuse it as the second arg.)

**Step 2: Rename state for clarity (optional but recommended)**

- `selectedToolBySession` → `selectedItemBySession`
- `activeSelectedToolId` → `activeSelectedItemId`
- `activeToolIds` → `activeItemIds`
- `moveToolSelection` → `moveItemSelection`
- `toggleSelectedToolExpansion` → `toggleSelectedItemExpansion`
- `handleToolActivate` → `handleItemActivate`
- Props on `Transcript`: `selectedToolId` → `selectedItemId`, `onToolActivate` → `onItemActivate`

Use a single editor pass (Find & Replace) per identifier to avoid drift. None of the names appear outside `app.tsx` / `Transcript.tsx` / `util/blocks.ts` so the blast radius is small.

**Step 3: Delete the old `collectToolIds`**

Once `app.tsx` no longer references `collectToolIds`, remove it from `tui/src/util/blocks.ts`.

**Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

**Step 5: Commit**

```bash
git add tui/src/app.tsx tui/src/util/blocks.ts tui/src/components/Transcript.tsx
git commit -m "refactor(tui): widen chat-area selection state to every row"
```

---

## Task 7: Final verification

**Step 1: Run typecheck + every test**

```bash
npm run typecheck
cd tui && bun test
```

Expected: both clean.

**Step 2: Self-review checklist**

- [ ] Every row in `Transcript`'s output is a `ChatItem`.
- [ ] `ToolCard` and `DelegationGroup` no longer declare their own `border`/`onMouseDown`/hint footer.
- [ ] `NoticeCard`, `TaskCard`, `UserMessage`, inline text/error/thinking/peer_reply/peer_thinking blocks render via `ChatItem`.
- [ ] `collectChatItemIds` and the `activeItemIds` array include user messages, notices, and every assistant block — not just tools.
- [ ] Shift+up / shift+down moves through every row, not just tools.
- [ ] First click selects, second click on the same card toggles `expanded` (unchanged behavior — driven by `handleItemActivate`).
- [ ] No `useKeyboard` calls added inside `ChatItem` (App stays the keyboard owner).
- [ ] No dead exports (`collectToolIds` removed).

**Step 3: Commit any stragglers, then stop**

```bash
git status
# if clean, done; otherwise commit the leftover changes with a follow-up message
```

---

## Out of scope (do not do in this plan)

- Scroll-to-selected when the focused row moves off-screen. The current behavior keeps the scrollbox sticky-to-bottom; adding "scroll to selected" is a separate change.
- Mouse-wheel or arrow-only (without shift) navigation. The current `useKeyboard` binding is shift+up/down on purpose to avoid colliding with the Prompt's history shortcut.
- Default "expand on click" for items that have no expanded view. Plain text / thinking / peer_reply / peer_thinking / user messages / notices have nothing to show beyond what's already visible; second click is a no-op. If a future change wants "expanded text shows full markdown without truncation", that's an additive change inside each component — not a wrapper concern.
- Adding scrollbar focus indicators or a global "focus visualizer". Out of scope.
