import { describe, expect, test } from "bun:test";
import { approvalNodePromptPreview } from "./WorkflowPanel";
import type { WorkflowNode } from "../../../shared/events.ts";

function node(partial: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: partial.id ?? "n1",
    title: partial.title ?? "Node",
    runner: partial.runner ?? "claude",
    prompt: partial.prompt ?? "Inspect the repo and identify the risky files.",
    dependsOn: partial.dependsOn,
    status: partial.status ?? "pending",
    attempt: partial.attempt ?? 0,
  };
}

describe("approvalNodePromptPreview", () => {
  test("shows the authored node prompt in the approval surface", () => {
    expect(approvalNodePromptPreview(node())).toContain(
      "Inspect the repo and identify the risky files.",
    );
  });

  test("normalizes whitespace and truncates long prompts", () => {
    const preview = approvalNodePromptPreview(
      node({ prompt: `First line\n\n${"x".repeat(300)}` }),
    );

    expect(preview).toContain("First line");
    expect(preview).not.toContain("\n");
    expect(preview.endsWith("...")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(123);
  });
});
