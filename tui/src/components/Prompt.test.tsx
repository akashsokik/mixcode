import { describe, expect, mock, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { theme } from "../theme";

const FLUSH_DELAY_MS = 16;

mock.module("../util/files", () => ({
  listCwdFiles: () => new Promise<string[]>(() => {}),
}));

const { Prompt } = await import("./Prompt");

function topBorderColor(setup: Awaited<ReturnType<typeof testRender>>): string {
  const span = setup.captureSpans().lines[0]?.spans[0];
  if (!span) throw new Error("prompt top border was not rendered");
  return span.fg.toString();
}

function frameText(setup: Awaited<ReturnType<typeof testRender>>): string {
  return setup.captureSpans().lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

function lineText(
  setup: Awaited<ReturnType<typeof testRender>>,
  row: number,
): string {
  return setup.captureSpans().lines[row]?.spans.map((span) => span.text).join("") ?? "";
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

  test("keeps the idle prompt compact and avoids repeated mode copy", async () => {
    const setup = await testRender(
      <Prompt
        focused
        onSubmit={() => {}}
        runner="claude"
        claudeMode="acceptEdits"
        modelLabel="Sonnet 4.6"
        projectLabel="adverserial-code"
        branch={{ name: "main", dirty: true }}
        sessionPill={{ name: "Session 1", streaming: 0 }}
      />,
      { width: 120, height: 12, exitOnCtrlC: false },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      const screen = frameText(setup);
      expect(screen).toContain("Sonnet 4.6");
      expect(screen).toContain("adverserial-code");
      expect(screen).toContain("accept edits");
      expect(screen).toContain("↵ send");
      expect(screen).toContain("⇧tab mode");
      expect(screen).not.toContain("action");
      expect(screen).not.toContain("send to claude");
      expect(screen).not.toContain("auto-allows file edits");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("describes slash commands before they are submitted", async () => {
    const setup = await testRender(
      <Prompt
        focused
        onSubmit={() => {}}
        runner="claude"
        claudeMode="default"
      />,
      { width: 100, height: 14, exitOnCtrlC: false },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
        await setup.mockInput.typeText("/model ");
        await setup.renderOnce();
      });

      const screen = frameText(setup);
      expect(screen).toContain("model picker");
      expect(screen).toContain("↵ run");
      expect(screen).not.toContain("command");
      expect(screen).not.toContain("open model picker");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("plain enter submits, shift+enter inserts a newline", async () => {
    const submitted: string[] = [];
    const setup = await testRender(
      <Prompt
        focused
        onSubmit={(text) => submitted.push(text)}
        runner="claude"
        claudeMode="default"
      />,
      // kittyKeyboard so shift+return reaches the parser with its modifier
      // intact — legacy terminals drop shift on control keys.
      { width: 80, height: 12, exitOnCtrlC: false, kittyKeyboard: true },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
        await setup.mockInput.typeText("first");
        setup.mockInput.pressEnter({ shift: true });
        await setup.mockInput.typeText("second");
        await setup.renderOnce();
      });

      // Shift+enter should NOT have submitted; both lines are still in the buffer.
      expect(submitted).toEqual([]);
      const screen = setup.captureSpans().lines
        .map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n");
      expect(screen).toContain("first");
      expect(screen).toContain("second");

      await act(async () => {
        setup.mockInput.pressEnter();
        await setup.renderOnce();
      });

      expect(submitted).toEqual(["first\nsecond"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("collapses multi-line pastes to a placeholder and expands on submit", async () => {
    const submitted: string[] = [];
    const setup = await testRender(
      <Prompt
        focused
        onSubmit={(text) => submitted.push(text)}
        runner="claude"
        claudeMode="default"
      />,
      { width: 80, height: 12, exitOnCtrlC: false },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
        await setup.mockInput.typeText("look at ");
        await setup.mockInput.pasteBracketedText("line one\nline two\nline three");
        await setup.mockInput.typeText(" please");
        await setup.renderOnce();
      });

      const screen = setup.captureSpans().lines
        .map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n");
      // The placeholder is shown, not the raw multi-line content.
      expect(screen).toContain("[Pasted Text +3 lines, +6 words]");
      expect(screen).not.toContain("line one");

      await act(async () => {
        setup.mockInput.pressEnter();
        await new Promise((r) => setTimeout(r, FLUSH_DELAY_MS));
        await setup.renderOnce();
      });

      expect(submitted).toEqual([
        "look at line one\nline two\nline three please",
      ]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("does not echo slash command arguments in the rail", async () => {
    const setup = await testRender(
      <Prompt
        focused
        onSubmit={() => {}}
        runner="claude"
        claudeMode="default"
      />,
      { width: 100, height: 8, exitOnCtrlC: false },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
        await setup.mockInput.typeText("/consensus is adding pi a good idea ?");
        await setup.renderOnce();
      });

      const rail = lineText(setup, 2);
      expect(rail).toContain("consensus");
      expect(rail).toContain("↵ run");
      expect(rail).not.toContain("is adding pi");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
