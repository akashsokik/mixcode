import { describe, expect, mock, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { theme } from "../theme";

mock.module("../util/files", () => ({
  listCwdFiles: () => new Promise<string[]>(() => {}),
}));

const { Prompt } = await import("./Prompt");

function topBorderColor(setup: Awaited<ReturnType<typeof testRender>>): string {
  const span = setup.captureSpans().lines[0]?.spans[0];
  if (!span) throw new Error("prompt top border was not rendered");
  return span.fg.toString();
}

describe("Prompt", () => {
  test("dims the prompt border when the input renderable loses focus", async () => {
    const setup = await testRender(
      <Prompt
        focused
        onSubmit={() => {}}
        runner="claude"
        claudeMode="default"
      />,
      { width: 80, height: 12, exitOnCtrlC: false },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      expect(topBorderColor(setup)).toBe(parseColor(theme.borderFocused).toString());

      await act(async () => {
        setup.renderer.currentFocusedRenderable?.blur();
      });
      await act(async () => {
        await setup.renderOnce();
      });

      expect(topBorderColor(setup)).toBe(parseColor(theme.border).toString());
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
