import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

const { Welcome } = await import("./Welcome");

function frameText(setup: Awaited<ReturnType<typeof testRender>>): string {
  return setup.captureSpans().lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

describe("Welcome", () => {
  test("renders the welcome layout with tip, hints, and runner status", async () => {
    const setup = await testRender(<Welcome />, {
      width: 90,
      height: 30,
      exitOnCtrlC: false,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      const screen = frameText(setup);
      expect(screen).toContain("TIP:");
      expect(screen).toContain("/sessions");
      expect(screen).toContain("ctrl+k");
      expect(screen).toContain("Claude");
      expect(screen).toContain("Codex");
      expect(screen).toContain("Vercel");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
