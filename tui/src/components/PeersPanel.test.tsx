import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
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
          // peer_text_delta does not exist on RunEvent — the wire shape is a
          // synthesised tool_log whose name matches `^\[runner\] (reply|thinking)$`
          // (see blocksFromEvents + matchPeerSynthetic). The tool_log's
          // `output` becomes the peer_reply.text after folding.
          {
            type: "tool_log",
            log: { name: "[claude] reply", input: {}, output: "drafting the patch" },
          },
        ],
      },
    ],
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

describe("PeersPanel (multiple)", () => {
  // Plan v1 asked for "two concurrent pending peers in one message", but
  // groupDelegations folds all trailing peer events into a single pending
  // group (one inferred runner) and pendingDelegations operates on a single
  // streaming message — so the literal scenario is structurally impossible.
  //
  // The honest "stack multiple peer blocks" invariant the rail actually
  // supports is mixed: one pending peer alongside one freshly-completed peer
  // from a previous (now-settled) assistant message. The two render as
  // stacked blocks with the older (completed) one above the newer (pending)
  // one — insertion order matches when each entered the rail.
  test("stacks a completed glance above a fresh pending peer", async () => {
    const initial: Session = {
      ...emptySession(),
      streaming: true,
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "",
          createdAt: "2026-05-25T10:00:00.000Z",
          events: [
            {
              type: "tool_log",
              log: { name: "[claude] reply", input: {}, output: "drafting" },
            },
          ],
        },
      ],
    };
    // After the first peer settles its delegate_run anchor lands on m1 and a
    // new assistant message m2 begins streaming with a codex peer.
    const next: Session = {
      ...initial,
      messages: [
        {
          ...initial.messages[0],
          events: [
            ...initial.messages[0].events,
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
        {
          id: "m2",
          role: "assistant",
          text: "",
          createdAt: "2026-05-25T10:00:05.000Z",
          events: [
            {
              type: "tool_log",
              log: { name: "[codex] reply", input: {}, output: "reviewing" },
            },
          ],
        },
      ],
    };

    let setSession: ((s: Session) => void) | null = null;
    let setStreamingId: ((id: string) => void) | null = null;
    function Wrapper() {
      const [s, setS] = useState<Session>(initial);
      const [sid, setSid] = useState<string>("m1");
      setSession = setS;
      setStreamingId = setSid;
      return (
        <PeersPanel
          session={s}
          width={28}
          streamingMessageId={sid}
          completionMs={6000}
        />
      );
    }

    const setup = await testRender(<Wrapper />, {
      width: 32,
      height: 24,
      exitOnCtrlC: false,
    });
    try {
      await act(async () => { await setup.renderOnce(); });
      // Initial frame: only claude pending.
      expect(frameText(setup)).toContain("[claude]");

      await act(async () => {
        setSession!(next);
        setStreamingId!("m2");
      });
      await act(async () => { await setup.renderOnce(); });

      const out = frameText(setup);
      // Both peers visible: claude as the lingering completion glance,
      // codex as the new pending block. Completion glance appears first
      // because it entered the rail before the pending swap.
      const claudeIdx = out.indexOf("[claude]");
      const codexIdx = out.indexOf("[codex]");
      expect(claudeIdx).toBeGreaterThanOrEqual(0);
      expect(codexIdx).toBeGreaterThan(claudeIdx);
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});

describe("PeersPanel (width threshold)", () => {
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
});

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

    // testRender does not expose a `rerender`, so drive the swap via a
    // stateful wrapper. The module-level setter is captured on first render
    // and reused inside an act() block to push the settled session.
    let setSession: ((s: Session) => void) | null = null;
    function Wrapper({ initial }: { initial: Session }) {
      const [s, setS] = useState(initial);
      setSession = setS;
      return (
        <PeersPanel
          session={s}
          width={28}
          streamingMessageId="m1"
          completionMs={6000}
        />
      );
    }

    const setup = await testRender(<Wrapper initial={running} />, {
      width: 32,
      height: 16,
      exitOnCtrlC: false,
    });
    try {
      await act(async () => { await setup.renderOnce(); });
      expect(frameText(setup)).toContain("working");
      await act(async () => { setSession!(settled); });
      await act(async () => { await setup.renderOnce(); });
      // Still visible because we are inside the 6s window.
      const after = frameText(setup);
      expect(after).toContain("claude");
      expect(after).toContain("patched");
    } finally {
      await act(async () => { setup.renderer.destroy(); });
    }
  });
});
