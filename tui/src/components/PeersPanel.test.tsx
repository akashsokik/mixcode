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
