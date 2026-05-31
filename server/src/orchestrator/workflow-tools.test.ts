import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkflowRun } from "../../../shared/events.js";
import {
  executeWorkflowAddNode,
  executeWorkflowReset,
  executeWorkflowRun,
} from "./workflow-tools.js";

describe("workflow authoring tools", () => {
  test("a non-Claude planner can propose an Ollama workflow", () => {
    const sessionId = "s-workflow-tools";
    let proposed: WorkflowRun | null = null;

    const add = executeWorkflowAddNode(
      {
        id: "build",
        title: "build throwaway project",
        runner: "ollama",
        prompt: "Create a small Python project in a temporary folder.",
      },
      { parentSessionId: sessionId },
    );
    assert.equal(add.ok, true);

    const run = executeWorkflowRun(
      { goal: "build and review a throwaway project" },
      {
        parentSessionId: sessionId,
        parentRunner: "ollama",
        onWorkflowProposed: (workflow) => {
          proposed = workflow;
          return { ok: true };
        },
      },
    );

    assert.equal(run.ok, true);
    assert.ok(proposed);
    const workflow = proposed as WorkflowRun;
    assert.equal(workflow.planner, "ollama");
    assert.equal(workflow.nodes[0]?.runner, "ollama");
    assert.equal(workflow.status, "proposed");

    executeWorkflowReset({ parentSessionId: sessionId });
  });
});
