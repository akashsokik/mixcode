import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkflowRun } from "../../../shared/events.js";
import { clearWorkflowRun, setWorkflowRun } from "./workflow.js";
import {
  executeWorkflowAddNode,
  executeWorkflowCancel,
  executeWorkflowObserve,
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

function makeRun(sessionId: string): WorkflowRun {
  return {
    id: "wf-test",
    sessionId,
    goal: "do the thing",
    planner: "claude",
    status: "running",
    nodes: [
      {
        id: "a",
        title: "recon",
        runner: "claude",
        prompt: "look around",
        status: "ok",
        output: "found three files",
        attempt: 1,
      },
      {
        id: "b",
        title: "fix",
        runner: "codex",
        prompt: "fix it",
        dependsOn: ["a"],
        status: "running",
        runId: "run-b",
        attempt: 1,
      },
    ],
    createdAt: 1,
  };
}

describe("workflow_observe", () => {
  test("errors when the session has no active workflow", () => {
    const r = executeWorkflowObserve({ parentSessionId: "s-observe-none" });
    assert.equal(r.ok, false);
  });

  test("returns a per-node snapshot of the active workflow", () => {
    const sessionId = "s-observe";
    setWorkflowRun(makeRun(sessionId));

    const r = executeWorkflowObserve({ parentSessionId: sessionId });
    assert.equal(r.ok, true);
    const snap = r.payload.snapshot as {
      workflowId: string;
      status: string;
      nodes: { id: string; status: string; hasOutput: boolean; outputPreview?: string }[];
      counts: Record<string, number>;
    };
    assert.equal(snap.workflowId, "wf-test");
    assert.equal(snap.status, "running");
    assert.equal(snap.nodes.length, 2);
    const a = snap.nodes.find((n) => n.id === "a");
    assert.equal(a?.status, "ok");
    assert.equal(a?.hasOutput, true);
    assert.equal(a?.outputPreview, "found three files");
    assert.equal(snap.counts.ok, 1);
    assert.equal(snap.counts.running, 1);

    clearWorkflowRun(sessionId);
  });
});

describe("workflow_cancel", () => {
  test("errors when the session has no active workflow", () => {
    const r = executeWorkflowCancel({ parentSessionId: "s-cancel-none" });
    assert.equal(r.ok, false);
  });

  test("errors when the runner does not surface workflows", () => {
    const sessionId = "s-cancel-norunner";
    setWorkflowRun(makeRun(sessionId));
    const r = executeWorkflowCancel({ parentSessionId: sessionId });
    assert.equal(r.ok, false);
    clearWorkflowRun(sessionId);
  });

  test("invokes the cancel handler and reports the result", () => {
    const sessionId = "s-cancel";
    setWorkflowRun(makeRun(sessionId));
    let cancelledSession: string | null = null;

    const r = executeWorkflowCancel({
      parentSessionId: sessionId,
      onWorkflowCancel: (sid) => {
        cancelledSession = sid;
        return { ok: true, cancelled: true };
      },
    });

    assert.equal(r.ok, true);
    assert.equal(cancelledSession, sessionId);
    assert.equal(r.payload.workflowId, "wf-test");
    assert.equal(r.payload.cancelled, true);

    clearWorkflowRun(sessionId);
  });
});
