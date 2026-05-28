import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { CollabCard } from "./CollabCard";
import type { Block } from "../../util/blocks";

function frameText(setup: Awaited<ReturnType<typeof testRender>>): string {
  return setup.captureSpans().lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

describe("CollabCard", () => {
  test("shows an open collab as idle after the assistant turn settles", async () => {
    const blocks: Block[] = [
      {
        kind: "tool",
        log: {
          name: "mcp__orchestrator__collab_ask_peer",
          input: { collabId: "collab_abcdef12" },
          output: { ok: true },
        },
      },
    ];
    const setup = await testRender(
      <CollabCard
        id="m1:c:0"
        selected={false}
        active={false}
        snapshot={{
          id: "collab:log_1",
          name: "collab",
          input: { planId: "plan_abcdef12", path: "docs/plans/demo.md" },
          output: {
            collabId: "collab_abcdef12",
            planId: "plan_abcdef12",
            planPath: "docs/plans/demo.md",
            leadRunner: "claude",
            peerRunner: "codex",
            status: "running",
            phases: [],
            messages: 2,
            decisions: 0,
            peerTurns: 1,
            maxPeerTurns: 8,
          },
        }}
        blocks={blocks}
      />,
      { width: 120, height: 8, exitOnCtrlC: false },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const screen = frameText(setup);
      expect(screen).toContain("open");
      expect(screen).not.toContain("running");
      expect(screen).not.toContain("waiting on codex");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
