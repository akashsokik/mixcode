# Peers Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lift in-flight peer activity (delegate / consensus / validate) out of the scrolling chat into a fixed right-side rail that auto-shows when peers run and auto-hides otherwise.

**Architecture:** New `PeersPanel` component re-uses the existing `groupDelegations` data path — it consumes the same pending `delegation_group` entries that `Transcript`'s inline `PendingHeader` reads. App wraps `Transcript + Spinner + Prompt` in a horizontal flex with the rail to its right. Visibility is auto by default, with a `ctrl+b` manual override and a 90-col terminal-width guard. No backend / shared-protocol changes.

**Tech Stack:** TypeScript, React 19, `@opentui/react`, `bun:test` with `@opentui/react/test-utils`.

**Design doc:** `docs/plans/2026-05-25-peers-panel-design.md`

---

## Task 1: `pendingDelegations` helper

Add a thin selector over `groupDelegations` that returns just the pending `delegation_group` entries for the most recent assistant message of a session. The rail consumes this.

**Files:**
- Modify: `tui/src/util/blocks.ts` (add export at end of file)
- Test: `tui/src/util/blocks.test.ts` (add new `describe` block)

**Step 1: Write the failing test**

Add to `tui/src/util/blocks.test.ts`:

```typescript
import { collectChatItemIds, pendingDelegations } from "./blocks";

// ... existing helpers ...

describe("pendingDelegations", () => {
  test("returns empty list when session is null", () => {
    expect(pendingDelegations(null, null)).toEqual([]);
  });

  test("returns empty list when no delegate_run started", () => {
    const session = makeSession();
    expect(pendingDelegations(session, session.messages.at(-1)!.id)).toEqual([]);
  });

  test("returns pending group when peer is in-flight on the streaming message", () => {
    const session: Session = {
      ...makeSession(),
      streaming: true,
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "",
          createdAt: "2026-05-25T10:00:00.000Z",
          events: [
            // delegate_run anchor not yet emitted; only a peer text_delta
            // has arrived — groupDelegations synthesises a pending group.
            { type: "peer_text_delta", runner: "claude", delta: "drafting" },
          ],
        },
      ],
    };
    const out = pendingDelegations(session, "m1");
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("delegation_group");
    expect(out[0].header).toBeNull();
    expect(out[0].pendingRunner).toBe("claude");
  });

  test("ignores pending groups on a non-streaming message", () => {
    const session = makeSession();
    // streamingMessageId points to a different / older id
    expect(pendingDelegations(session, "msg-that-isnt-streaming")).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd tui && bun test src/util/blocks.test.ts
```

Expected: tests fail with `pendingDelegations is not a function` (or similar import error).

**Step 3: Implement**

Append to `tui/src/util/blocks.ts`:

```typescript
/**
 * Returns the pending delegation_group entries for the most recent assistant
 * message in `session`. A pending group has `header === null` and is only
 * eligible while its owner message is still streaming — matches the gating
 * the Transcript uses to decide whether to render a synthetic PendingHeader.
 *
 * Used by PeersPanel to drive the right-side rail. Empty list = no rail.
 */
export function pendingDelegations(
  session: Session | null,
  streamingMessageId: string | null,
): Extract<GroupedBlock, { kind: "delegation_group" }>[] {
  if (!session || !streamingMessageId) return [];
  const msg = session.messages.find((m) => m.id === streamingMessageId);
  if (!msg || msg.role !== "assistant") return [];
  const grouped = groupDelegations(blocksFromEvents(msg.events), msg.id, true);
  return grouped.filter(
    (g): g is Extract<GroupedBlock, { kind: "delegation_group" }> =>
      g.kind === "delegation_group" && g.header === null,
  );
}
```

(Imports for `Session`, `GroupedBlock`, `blocksFromEvents`, `groupDelegations` should already be in the file.)

**Step 4: Run tests to verify pass**

```bash
cd tui && bun test src/util/blocks.test.ts
```

Expected: all four `pendingDelegations` tests PASS, existing tests still PASS.

**Step 5: Commit**

```bash
git add tui/src/util/blocks.ts tui/src/util/blocks.test.ts
git commit -m "feat(tui): pendingDelegations selector for peers rail"
```

---

## Task 2: Elapsed-time helper

Tiny formatter used by the rail's live timers. Pure function, trivial to test.

**Files:**
- Create: `tui/src/util/elapsed.ts`
- Test: `tui/src/util/elapsed.test.ts`

**Step 1: Write the failing test**

Create `tui/src/util/elapsed.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  test("returns '0s' for negative or zero", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(-1000)).toBe("0s");
  });
  test("seconds under a minute", () => {
    expect(formatElapsed(1_000)).toBe("1s");
    expect(formatElapsed(23_400)).toBe("23s");
    expect(formatElapsed(59_999)).toBe("59s");
  });
  test("minutes + seconds under an hour", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(64_000)).toBe("1m 4s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
  });
  test("hours + minutes at or above an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });
});
```

**Step 2: Run test, expect fail**

```bash
cd tui && bun test src/util/elapsed.test.ts
```

Expected: FAIL — `./elapsed` cannot be resolved.

**Step 3: Implement**

Create `tui/src/util/elapsed.ts`:

```typescript
export function formatElapsed(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h ${m}m`;
}
```

**Step 4: Run test, expect pass**

```bash
cd tui && bun test src/util/elapsed.test.ts
```

Expected: all four tests PASS.

**Step 5: Commit**

```bash
git add tui/src/util/elapsed.ts tui/src/util/elapsed.test.ts
git commit -m "feat(tui): formatElapsed helper for peer timers"
```

---

## Task 3: `PeersPanel` scaffold (renders null when empty)

Create the component file with the props contract and the empty-state behaviour. No visible output yet.

**Files:**
- Create: `tui/src/components/PeersPanel.tsx`
- Test: `tui/src/components/PeersPanel.test.tsx`

**Step 1: Write the failing test**

Create `tui/src/components/PeersPanel.test.tsx`:

```typescript
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Session } from "../../../shared/events.ts";

const { PeersPanel } = await import("./PeersPanel");

function frameText(setup: Awaited<ReturnType<typeof testRender>>): string {
  return setup.captureSpans().lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

function emptySession(): Session {
  return {
    id: "s1",
    title: "demo",
    activeRunner: "claude",
    cwd: "/tmp",
    streaming: false,
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:00:01.000Z",
    models: {},
    claudeMode: "default",
    git: null,
    messages: [],
  };
}

describe("PeersPanel", () => {
  test("renders nothing when session has no pending peers", async () => {
    const setup = await testRender(
      <PeersPanel session={emptySession()} width={26} streamingMessageId={null} />,
      { width: 30, height: 10, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      // Empty frame: no header, no rows.
      expect(frameText(setup).trim()).toBe("");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
```

**Step 2: Run test, expect fail**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: FAIL — `./PeersPanel` cannot be resolved.

**Step 3: Implement**

Create `tui/src/components/PeersPanel.tsx`:

```typescript
import type { Session } from "../../../shared/events.ts";
import { pendingDelegations } from "../util/blocks";

export type PeersPanelProps = {
  session: Session | null;
  width: number;
  streamingMessageId: string | null;
};

export function PeersPanel({ session, streamingMessageId }: PeersPanelProps) {
  const pending = pendingDelegations(session, streamingMessageId);
  if (pending.length === 0) return null;
  // Visible rendering arrives in Task 4 — for now just emit a placeholder so
  // we can verify mount/unmount behaviour in isolation.
  return null;
}
```

**Step 4: Run test, expect pass**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tui/src/components/PeersPanel.tsx tui/src/components/PeersPanel.test.tsx
git commit -m "feat(tui): PeersPanel scaffold returns null on empty"
```

---

## Task 4: Render one running peer block

Replace the placeholder with an actual block per pending peer. Static elapsed time for now (no timer yet — Task 5 adds the ticker).

**Files:**
- Modify: `tui/src/components/PeersPanel.tsx`
- Modify: `tui/src/components/PeersPanel.test.tsx`

**Step 1: Write the failing test**

Add to `tui/src/components/PeersPanel.test.tsx`:

```typescript
function streamingClaudeSession(): Session {
  return {
    ...emptySession(),
    streaming: true,
    messages: [
      {
        id: "m1",
        role: "assistant",
        text: "",
        createdAt: "2026-05-25T10:00:00.000Z",
        events: [
          { type: "peer_text_delta", runner: "claude", delta: "drafting the patch" },
        ],
      },
    ],
  };
}

describe("PeersPanel (single peer)", () => {
  test("renders header, runner badge, tag, verb, and writing tail", async () => {
    const setup = await testRender(
      <PeersPanel session={streamingClaudeSession()} width={28} streamingMessageId="m1" />,
      { width: 32, height: 16, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      const out = frameText(setup);
      expect(out).toContain("peer activity");
      expect(out).toContain("claude");
      expect(out).toContain("delegate");
      expect(out).toContain("working");
      expect(out).toContain("drafting the patch");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
```

**Step 2: Run test, expect fail**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: FAIL — output does not contain "peer activity".

**Step 3: Implement**

Replace the body of `tui/src/components/PeersPanel.tsx`:

```typescript
import type { Session } from "../../../shared/events.ts";
import { TextAttributes } from "@opentui/core";
import { pendingDelegations } from "../util/blocks";
import { theme } from "../theme";
import { StatusDot } from "./StatusDot";
import type { GroupedBlock } from "../util/blocks";

type PeerGroup = Extract<GroupedBlock, { kind: "delegation_group" }>;

export type PeersPanelProps = {
  session: Session | null;
  width: number;
  streamingMessageId: string | null;
};

export function PeersPanel({ session, width, streamingMessageId }: PeersPanelProps) {
  const pending = pendingDelegations(session, streamingMessageId);
  if (pending.length === 0) return null;

  return (
    <box
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
      border={["left"]}
      borderStyle="single"
      borderColor={theme.border}
    >
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>peer activity</text>
        <text fg={theme.textFaint}>{`   ${pending.length}`}</text>
      </box>
      {pending.map((g) => (
        <PeerBlock key={g.id} group={g} />
      ))}
    </box>
  );
}

function PeerBlock({ group }: { group: PeerGroup }) {
  const stats = childStats(group);
  const accent =
    group.tag === "validate"
      ? theme.toolEdit
      : group.tag === "consensus"
        ? theme.toolBash
        : theme.toolTask;
  const verb =
    group.tag === "validate"
      ? "validating…"
      : group.tag === "consensus"
        ? "drafting…"
        : "working…";
  const runner = group.pendingRunner ?? "peer";
  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row">
        <StatusDot status="running" />
        <text fg={theme.text}>{" "}</text>
        <text fg={peerColor(runner)} attributes={TextAttributes.BOLD}>{`[${runner}] `}</text>
        <text fg={accent} attributes={TextAttributes.BOLD}>{group.tag}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textFaint}>{"  "}</text>
        <text fg={theme.textMuted}>{verb}</text>
      </box>
      <box flexDirection="row" marginTop={0}>
        <text fg={theme.textFaint}>{"  "}</text>
        <text fg={theme.textMuted}>{`${stats.toolCount} tool${stats.toolCount === 1 ? "" : "s"}`}</text>
      </box>
      {stats.replyChars > 0 && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  "}</text>
          <text fg={theme.textMuted}>{`${formatChars(stats.replyChars)} reply`}</text>
        </box>
      )}
      {stats.lastSummary && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  ↳ "}</text>
          <text fg={theme.textMuted}>{stats.lastSummary}</text>
        </box>
      )}
      {stats.replyTail && (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.textFaint}>{"  writing:"}</text>
          {stats.replyTail.split("\n").map((line, i) => (
            <box key={`tail-${i}`} flexDirection="row">
              <text fg={theme.textFaint}>{"  "}</text>
              <text fg={theme.textMuted}>{line || " "}</text>
            </box>
          ))}
        </box>
      )}
    </box>
  );
}

function peerColor(runner: string): string {
  if (runner === "claude") return theme.runnerClaude;
  if (runner === "codex") return theme.runnerCodex;
  if (runner === "vercel") return theme.runnerVercel;
  return theme.textMuted;
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

// Pulled inline from Transcript.tsx so the rail does not depend on the
// transcript module. Identical shape to childStats() over there; if it
// grows, factor out to util/peer-stats.ts.
type Stats = {
  toolCount: number;
  replyChars: number;
  lastSummary: string | null;
  replyTail: string;
};
const REPLY_TAIL_LINES = 6;
const REPLY_TAIL_CHARS = 320;

function childStats(group: PeerGroup): Stats {
  let toolCount = 0;
  let replyChars = 0;
  let lastSummary: string | null = null;
  let latestReply = "";
  for (const b of group.children) {
    if (b.kind === "tool") {
      toolCount += 1;
      lastSummary = peerToolSummaryName(b);
    } else if (b.kind === "peer_reply" || b.kind === "peer_thinking") {
      replyChars += b.text.length;
      if (b.kind === "peer_reply") latestReply = b.text;
    }
  }
  return {
    toolCount,
    replyChars,
    lastSummary,
    replyTail: tailLines(latestReply, REPLY_TAIL_LINES, REPLY_TAIL_CHARS),
  };
}

function peerToolSummaryName(b: { kind: "tool"; log: { name: string } }): string {
  // Strip "mcp__delegate__" or peer prefixes for the rail. Mirrors
  // peerToolSummary() in util/format but keeps PeersPanel decoupled.
  return b.log.name.replace(/^mcp__[^_]+__/, "").replace(/^\[[^\]]+\]\s*/, "");
}

function tailLines(text: string, maxLines: number, maxChars: number): string {
  if (!text) return "";
  const trimmed = text.length > maxChars ? text.slice(-maxChars) : text;
  const lines = trimmed
    .split("\n")
    .map((l) => (l.length > 200 ? l.slice(0, 199) + "…" : l));
  const tail = lines.slice(-maxLines);
  while (tail.length > 0 && !tail[0].trim()) tail.shift();
  return tail.join("\n");
}
```

**Step 4: Run test, expect pass**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: both PeersPanel tests PASS.

**Step 5: Type-check**

```bash
cd tui && bun run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add tui/src/components/PeersPanel.tsx tui/src/components/PeersPanel.test.tsx
git commit -m "feat(tui): render in-flight peer block in PeersPanel"
```

---

## Task 5: Live elapsed timer

Show `23s`, `1m 4s` etc on the verb line and tick once per second while pending. Single shared `setInterval` for the whole panel, owned by `PeersPanel`. Skip the interval when there are no pending blocks.

**Files:**
- Modify: `tui/src/components/PeersPanel.tsx`
- Modify: `tui/src/components/PeersPanel.test.tsx`

**Step 1: Write the failing test**

Add a test that the verb line contains a seconds suffix. The peer's `startedAt` is derived from the first child event timestamp (or `Date.now()` fallback); we control timing by passing a `nowMs` prop in test mode.

```typescript
describe("PeersPanel (elapsed)", () => {
  test("shows elapsed seconds next to the verb", async () => {
    const session = streamingClaudeSession();
    const setup = await testRender(
      <PeersPanel
        session={session}
        width={28}
        streamingMessageId="m1"
        nowMs={Date.parse("2026-05-25T10:00:23.000Z")}
      />,
      { width: 32, height: 16, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      const out = frameText(setup);
      expect(out).toMatch(/working…\s+23s/);
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
```

(Add `peer_text_delta` event with `createdAt: "2026-05-25T10:00:00.000Z"` to `streamingClaudeSession`, or stash the message createdAt to derive startedAt from — see implementation below.)

**Step 2: Run test, expect fail**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx -t "elapsed"
```

Expected: FAIL — output does not contain "23s".

**Step 3: Implement**

Update `PeersPanelProps`:

```typescript
export type PeersPanelProps = {
  session: Session | null;
  width: number;
  streamingMessageId: string | null;
  // Test seam — production callers omit this and the panel reads Date.now().
  nowMs?: number;
};
```

Inside `PeersPanel`, after the empty check:

```typescript
const [tick, setTick] = useState(0);
useEffect(() => {
  if (pending.length === 0) return;
  const id = setInterval(() => setTick((t) => t + 1), 1000);
  return () => clearInterval(id);
}, [pending.length]);

const now = nowMs ?? Date.now();
```

Compute `startedAt` per group from the owning message's `createdAt` (the message is the closest stable anchor for "when did this assistant turn begin", and the peer events fire near the start of it):

```typescript
function peerStartedAt(session: Session, messageId: string): number {
  const msg = session.messages.find((m) => m.id === messageId);
  return msg ? Date.parse(msg.createdAt) : Date.now();
}
```

Pass `elapsedMs = now - peerStartedAt(session, streamingMessageId)` into each `<PeerBlock>` and append `formatElapsed(elapsedMs)` to the verb line:

```typescript
<text fg={theme.textMuted}>{`${verb}   ${formatElapsed(elapsedMs)}`}</text>
```

Don't forget `import { formatElapsed } from "../util/elapsed";` and `import { useEffect, useState } from "react";`.

Acknowledge `tick` so React keeps re-rendering on each interval fire even when no other prop changes:

```typescript
void tick;
```

**Step 4: Run tests, expect pass**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: all three tests PASS.

**Step 5: Commit**

```bash
git add tui/src/components/PeersPanel.tsx tui/src/components/PeersPanel.test.tsx
git commit -m "feat(tui): live elapsed timer on peer blocks"
```

---

## Task 6: Completion glance (sticky verdict for 6s)

When a previously-pending peer disappears from `pendingDelegations`, keep its block in the rail for 6 s showing a verdict-flavoured summary, then drop it.

For testability the duration is a prop (`completionMs`, default 6000). We diff previous-vs-current pending set in an effect; entries that left get parked in a `completed` map.

**Files:**
- Modify: `tui/src/components/PeersPanel.tsx`
- Modify: `tui/src/components/PeersPanel.test.tsx`

**Step 1: Write the failing test**

```typescript
describe("PeersPanel (completion)", () => {
  test("keeps a completed block visible briefly with verdict", async () => {
    const running = streamingClaudeSession();
    const settled: Session = {
      ...running,
      streaming: false,
      messages: [
        {
          ...running.messages[0],
          events: [
            ...running.messages[0].events,
            // delegate_run anchor arrives → group is no longer pending.
            {
              type: "tool_log",
              log: {
                name: "mcp__delegate__delegate_run",
                input: { runner: "claude" },
                output: JSON.stringify({ ok: true, summary: "patched" }),
              },
            },
          ],
        },
      ],
    };
    const setup = await testRender(
      <PeersPanel
        session={running}
        width={28}
        streamingMessageId="m1"
        completionMs={6000}
      />,
      { width: 32, height: 16, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      expect(frameText(setup)).toContain("working");
      await act(async () => {
        setup.rerender(
          <PeersPanel
            session={settled}
            width={28}
            streamingMessageId="m1"
            completionMs={6000}
          />,
        );
        await setup.renderOnce();
      });
      // Still visible because we are inside the 6s window.
      const after = frameText(setup);
      expect(after).toContain("claude");
      expect(after).toContain("patched");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
```

**Step 2: Run test, expect fail**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx -t "completion"
```

Expected: FAIL — "patched" not in output (block disappears immediately when no longer pending).

**Step 3: Implement**

Add to `PeersPanelProps`:

```typescript
completionMs?: number;
```

State and effect inside `PeersPanel` (before the early return):

```typescript
type CompletedEntry = {
  group: PeerGroup;            // last-seen pending shape (children, runner, tag)
  finishedAt: number;
  summary: string;
};
const [completed, setCompleted] = useState<Record<string, CompletedEntry>>({});

const pendingIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending]);
const prevPendingRef = useRef<Map<string, PeerGroup>>(new Map());

useEffect(() => {
  const prev = prevPendingRef.current;
  const next = new Map(pending.map((p) => [p.id, p]));
  // Find groups that left the pending set this render.
  for (const [id, group] of prev) {
    if (next.has(id)) continue;
    setCompleted((c) => ({
      ...c,
      [id]: {
        group,
        finishedAt: now,
        summary: extractCompletionSummary(session, id),
      },
    }));
  }
  prevPendingRef.current = next;
}, [pending, now, session]);

// Expire completed entries past the window.
useEffect(() => {
  const expired = Object.entries(completed).filter(
    ([, e]) => now - e.finishedAt >= (completionMs ?? 6000),
  );
  if (expired.length === 0) return;
  setCompleted((c) => {
    const out = { ...c };
    for (const [id] of expired) delete out[id];
    return out;
  });
}, [now, completed, completionMs]);
```

`extractCompletionSummary(session, groupId)` reads the now-resolved `delegation_group.header.output` from the full grouping over the message and returns a one-line label:

```typescript
function extractCompletionSummary(session: Session | null, groupId: string): string {
  if (!session) return "completed";
  for (const m of session.messages) {
    if (m.role !== "assistant") continue;
    const grouped = groupDelegations(blocksFromEvents(m.events), m.id, false);
    const g = grouped.find(
      (x) => x.kind === "delegation_group" && x.id === groupId,
    ) as PeerGroup | undefined;
    if (!g || !g.header) continue;
    const out = g.header.output;
    let parsed: unknown = out;
    if (typeof out === "string") {
      try { parsed = JSON.parse(out); } catch { return "completed"; }
    }
    if (!parsed || typeof parsed !== "object") return "completed";
    const p = parsed as Record<string, unknown>;
    if (typeof p.summary === "string" && p.summary) return p.summary;
    if (typeof p.verdict === "string") return `verdict: ${p.verdict}`;
    return "completed";
  }
  return "completed";
}
```

Rendering: union of `pending` + `Object.values(completed)`, with completed blocks rendered in a desaturated style (`StatusDot status="settled"` if available, otherwise `"idle"`) and the `writing:` tail replaced by the summary line.

Imports to add: `useMemo`, `useRef`, plus `groupDelegations` and `blocksFromEvents` (already imported indirectly via `pendingDelegations`; explicit imports clarify).

**Step 4: Run tests, expect pass**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add tui/src/components/PeersPanel.tsx tui/src/components/PeersPanel.test.tsx
git commit -m "feat(tui): 6s completion glance on PeersPanel blocks"
```

---

## Task 7: Multiple peers stacked + scrollbox overflow

Confirm two concurrent pending groups render as stacked blocks and the body overflows into a scrollbox when there's more than fits.

**Files:**
- Modify: `tui/src/components/PeersPanel.tsx`
- Modify: `tui/src/components/PeersPanel.test.tsx`

**Step 1: Write the failing test**

```typescript
describe("PeersPanel (multiple)", () => {
  test("renders one block per pending peer in order", async () => {
    const session: Session = {
      ...emptySession(),
      streaming: true,
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "",
          createdAt: "2026-05-25T10:00:00.000Z",
          events: [
            { type: "peer_text_delta", runner: "claude", delta: "alpha" },
            { type: "peer_text_delta", runner: "codex", delta: "beta" },
          ],
        },
      ],
    };
    const setup = await testRender(
      <PeersPanel session={session} width={28} streamingMessageId="m1" />,
      { width: 32, height: 24, exitOnCtrlC: false },
    );
    try {
      await act(async () => { await setup.renderOnce(); });
      const out = frameText(setup);
      // Both runner labels must appear; codex below claude (claude observed first).
      const claudeIdx = out.indexOf("[claude]");
      const codexIdx = out.indexOf("[codex]");
      expect(claudeIdx).toBeGreaterThanOrEqual(0);
      expect(codexIdx).toBeGreaterThan(claudeIdx);
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
```

**Step 2: Run test, expect outcome**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx -t "multiple"
```

If Task 4 already iterates `pending.map(...)`, this likely passes immediately. If it does, skip to Step 5 with a doc-only commit; otherwise:

**Step 3: Wrap body in a scrollbox**

```typescript
<scrollbox
  flexGrow={1}
  scrollbarOptions={{ showArrows: false }}
>
  {/* pending + completed blocks */}
</scrollbox>
```

Sort key: `startedAt` ascending. Add a comparator before mapping:

```typescript
const blocks = [...pending.map((g) => ({ kind: "pending" as const, group: g })),
                ...Object.values(completed).map((e) => ({ kind: "completed" as const, entry: e }))]
  .sort(byStart);
```

**Step 4: Run test, expect pass**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tui/src/components/PeersPanel.tsx tui/src/components/PeersPanel.test.tsx
git commit -m "feat(tui): stack multiple peer blocks in scrollable rail"
```

---

## Task 8: Wire PeersPanel into `app.tsx`

Add the horizontal flex layout and mount the panel. No width logic yet (Task 9) — use a fixed width for now.

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Add streaming-message accessor**

Add to the `App` body near the existing `promptMeta` memo:

```typescript
const streamingMessageId = useMemo(() => {
  const s = api.active;
  if (!s || !s.streaming) return null;
  const last = s.messages[s.messages.length - 1];
  return last && last.role === "assistant" ? last.id : null;
}, [api.active]);
```

**Step 2: Restructure the JSX**

Currently the outer `<box>` returns a vertical column of `<Transcript>`, overlays, and `<Prompt>`. Wrap them in a horizontal row with the chat column on the left and the panel on the right:

```tsx
<box
  flexDirection="row"
  width={width}
  height={height}
  backgroundColor={theme.bg}
  paddingTop={1}
  paddingBottom={1}
  paddingLeft={2}
  paddingRight={2}
>
  <box flexDirection="column" flexGrow={1}>
    <Transcript ... />
    <Spinner ... />
    { /* overlays as before */ }
    <Prompt ... />
  </box>
  <PeersPanel
    session={api.active}
    width={26}
    streamingMessageId={streamingMessageId}
  />
</box>
```

Import: `import { PeersPanel } from "./components/PeersPanel";`.

**Step 3: Type-check**

```bash
cd tui && bun run typecheck
```

Expected: no errors.

**Step 4: Run all tests**

```bash
cd tui && bun test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add tui/src/app.tsx
git commit -m "feat(tui): mount PeersPanel to the right of chat column"
```

---

## Task 9: Width logic — clamp + 90-col threshold

Compute the panel width from terminal width and force it to `0` (component returns `null`) below 90 cols.

**Files:**
- Modify: `tui/src/app.tsx`
- Modify: `tui/src/components/PeersPanel.tsx`

**Step 1: Add width helper**

In `app.tsx`, above the JSX return:

```typescript
const peersWidth = useMemo(() => {
  if (width < 90) return 0;
  return Math.min(32, Math.max(22, Math.round(width * 0.22)));
}, [width]);
```

Pass `peersWidth` to `<PeersPanel>` instead of the fixed `26`.

**Step 2: Guard the panel**

In `PeersPanel.tsx`, at the top of the body:

```typescript
if (width <= 0) return null;
```

(Above the pending check, so width-zero short-circuits before any work.)

**Step 3: Add a width-threshold test**

Append to `PeersPanel.test.tsx`:

```typescript
test("renders nothing when width is zero (narrow terminal)", async () => {
  const setup = await testRender(
    <PeersPanel session={streamingClaudeSession()} width={0} streamingMessageId="m1" />,
    { width: 60, height: 10, exitOnCtrlC: false },
  );
  try {
    await act(async () => { await setup.renderOnce(); });
    expect(frameText(setup).trim()).toBe("");
  } finally {
    await act(async () => { setup.renderer.destroy(); });
  }
});
```

**Step 4: Run tests, expect pass**

```bash
cd tui && bun test src/components/PeersPanel.test.tsx
```

**Step 5: Commit**

```bash
git add tui/src/app.tsx tui/src/components/PeersPanel.tsx tui/src/components/PeersPanel.test.tsx
git commit -m "feat(tui): clamp PeersPanel width and hide below 90 cols"
```

---

## Task 10: `ctrl+b` manual toggle

User-facing override: `auto` (default), `shown` (force visible when there's anything to show, even on narrow terminals — capped to `width-20`), `hidden` (force off).

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Add toggle state**

Inside `App`:

```typescript
const [railToggle, setRailToggle] = useState<"auto" | "shown" | "hidden">("auto");
```

Bind `ctrl+b` inside the existing `useKeyboard` block:

```typescript
if (key.ctrl && key.name === "b") {
  setRailToggle((m) => (m === "auto" ? "hidden" : m === "hidden" ? "shown" : "auto"));
  return;
}
```

Three-way cycle so the user can both hide on a wide terminal and force-show on a narrow one.

**Step 2: Update `peersWidth` to consult `railToggle`**

Replace the `peersWidth` memo:

```typescript
const peersWidth = useMemo(() => {
  if (railToggle === "hidden") return 0;
  if (railToggle === "shown")  return Math.min(32, Math.max(20, Math.round(width * 0.22)));
  // auto
  if (width < 90) return 0;
  return Math.min(32, Math.max(22, Math.round(width * 0.22)));
}, [width, railToggle]);
```

**Step 3: Type-check + run tests**

```bash
cd tui && bun run typecheck && bun test
```

Expected: no errors, all tests PASS.

**Step 4: Commit**

```bash
git add tui/src/app.tsx
git commit -m "feat(tui): ctrl+b cycles PeersPanel auto/shown/hidden"
```

---

## Task 11: Manual smoke verification

No automated test can fully cover real-world panel behaviour (timer ticking, completion glance, resize). Run the TUI and walk through the matrix. Document any deltas as follow-up issues.

**Step 1: Start the app the user's normal way**

```bash
bun start
```

(`bun start` boots the backend in the background and launches the TUI — see `README.md`. Do **not** run the server separately unless asked.)

**Step 2: Walk through the matrix**

| Scenario | Expected |
|---|---|
| Default state, no peer running | Rail absent, chat full width |
| `/delegate <task>` (or any flow that spawns a peer) | Rail appears, block shows runner, tag, verb, counters |
| Wait ~10 s | Elapsed timer increments live (`10s`) |
| Trigger `/consensus` | Verb is `drafting…` then `reviewing…`, tag colour amber |
| Trigger `/validate` (orchestrator-driven) | Tag sage, verb `validating…` |
| Peer completes | Block stays for ~6 s with summary, then rail unmounts |
| Two concurrent peers | Both blocks visible, stacked oldest-first |
| `ctrl+b` while peers running | Rail hides; pressing again forces shown; third press returns to auto |
| Resize terminal below 90 cols | Rail auto-hides, chat reclaims |
| Resize back above 90 cols mid-peer | Rail re-appears |

**Step 3: Note regressions**

Confirm none of these still work as before:

- Inline `PendingHeader` in the transcript (must still render — it's the historical record).
- `cmd+k` session palette.
- `ctrl+e` chat-item expansion.
- Shift+up/down chat-item navigation.

**Step 4: Final commit if any polish needed**

If the smoke pass surfaces small layout tweaks (spacing, colour, copy), apply them as a single follow-up commit:

```bash
git add ...
git commit -m "polish(tui): PeersPanel layout tweaks from smoke"
```

If nothing needs changing, no commit.

---

## Done criteria

- `pendingDelegations` + `formatElapsed` unit tests green.
- `PeersPanel` component tests green: empty, single peer, elapsed, completion, multiple, narrow-width.
- `tsc --noEmit` clean.
- Manual smoke matrix in Task 11 passes.
- No regression in inline `PendingHeader`, palette, ctrl+e, shift+up/down.

## Follow-ups (not in this plan)

- Per-tag completion-glance duration (validate < consensus).
- Click-to-jump from rail block to inline anchor in transcript.
- Rail persistence preference (remember `railToggle` per session or globally).
- Surface skipped/cancelled verdicts distinctly (currently both render as "completed").
