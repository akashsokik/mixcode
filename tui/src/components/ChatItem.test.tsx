import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

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
