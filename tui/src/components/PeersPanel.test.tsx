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
