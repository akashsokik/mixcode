import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { markdownStyle, markdownTableOptions } from "./markdown-style";

// Box-drawing characters that show up in `style: "grid"` tables. We deliberately
// switched to `style: "columns"` (borderless) so the transcript renders denser
// tables that also survive copy-paste. If any of these characters appear in the
// captured frame, the table reverted to grid rendering.
const GRID_BORDER_CHARS = ["┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼", "│"];

// Plain-ASCII fixture; repo rule (referenced from docs/plans/2026-05-22-
// orchestrator-plan.md) is no emojis in code.
const TABLE_MD = [
  "| Tool | Call | Result |",
  "|---|---|---|",
  "| `delegate_run` (sync) | codex, `wait=true` (default) | ok |",
  "| `get_run` | runId | cached ok |",
].join("\n");

async function renderToFrame(content: string, streaming = false): Promise<string> {
  // Pair every test renderer with a try/finally destroy so native renderer
  // state doesn't leak between cases — matches the pattern in
  // Prompt.test.tsx / ChatItem.test.tsx.
  const harness = await createTestRenderer({ width: 100, height: 30 });
  try {
    const root = createRoot(harness.renderer);
    flushSync(() => {
      root.render(
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <markdown
            content={content}
            syntaxStyle={markdownStyle}
            fg="#cccccc"
            streaming={streaming}
            tableOptions={markdownTableOptions}
          />
        </box>,
      );
    });
    // Two frames: the first commits layout, the second locks the buffer.
    await harness.renderOnce();
    await harness.renderOnce();
    return harness.captureCharFrame();
  } finally {
    harness.renderer.destroy();
  }
}

describe("markdownTableOptions", () => {
  test("renders tables without grid border characters", async () => {
    const frame = await renderToFrame(TABLE_MD);
    for (const ch of GRID_BORDER_CHARS) {
      expect(frame).not.toContain(ch);
    }
  });

  test("preserves every cell's text content", async () => {
    const frame = await renderToFrame(TABLE_MD);
    // Header
    expect(frame).toContain("Tool");
    expect(frame).toContain("Call");
    expect(frame).toContain("Result");
    // Body cells — backticks are concealed (rendered as inline code, no
    // surrounding backticks), so we assert on the inner identifier text.
    expect(frame).toContain("delegate_run");
    expect(frame).toContain("wait=true");
    expect(frame).toContain("(default)");
    expect(frame).toContain("get_run");
    expect(frame).toContain("runId");
    expect(frame).toContain("cached ok");
  });

  test("streaming and non-streaming render the same final frame", async () => {
    // The recent WIP added streaming={messageStreaming} to <markdown>. Once a
    // message stops streaming, the rendered table should be identical to one
    // rendered fresh with streaming=false. Catches finalization regressions.
    const settled = await renderToFrame(TABLE_MD, false);
    const streamed = await renderToFrame(TABLE_MD, true);
    expect(streamed).toBe(settled);
  });
});
