import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunnerKind, WorkflowNode, WorkflowRun } from "../../../shared/events.js";
import { validate, findCycle, type ValidateResult } from "./workflow.js";

const RUNNERS: ReadonlySet<RunnerKind> = new Set<RunnerKind>([
  "claude",
  "codex",
  "vercel",
  "ollama",
]);

function node(partial: Partial<WorkflowNode> & { id: string }): WorkflowNode {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    runner: partial.runner ?? "claude",
    prompt: partial.prompt ?? "do work",
    dependsOn: partial.dependsOn,
    status: partial.status ?? "pending",
    attempt: partial.attempt ?? 0,
  };
}

function run(nodes: WorkflowNode[]): WorkflowRun {
  return {
    id: "wf-1",
    sessionId: "s-1",
    goal: "g",
    planner: "claude",
    status: "proposed",
    nodes,
    createdAt: 0,
  };
}

function expectErr(r: ValidateResult): { code: string; message: string } {
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected validation failure");
  return { code: r.code, message: r.message };
}

describe("workflow validate", () => {
  test("accepts a well-formed linear DAG", () => {
    const r = validate(
      run([
        node({ id: "a" }),
        node({ id: "b", dependsOn: ["a"], prompt: "use the recon" }),
      ]),
      RUNNERS,
      24,
    );
    assert.equal(r.ok, true);
  });

  test("too_many_nodes when node count exceeds the cap", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })];
    const e = expectErr(validate(run(nodes), RUNNERS, 2));
    assert.equal(e.code, "too_many_nodes");
    assert.match(e.message, /3 > 2/);
  });

  test("duplicate_node_id when two nodes share an id", () => {
    const e = expectErr(
      validate(run([node({ id: "x" }), node({ id: "x" })]), RUNNERS, 24),
    );
    assert.equal(e.code, "duplicate_node_id");
    assert.match(e.message, /x/);
  });

  test("unknown_runner when a node names a runner not in the known set", () => {
    const bad = node({ id: "a" });
    bad.runner = "gpt5" as RunnerKind;
    const e = expectErr(validate(run([bad]), RUNNERS, 24));
    assert.equal(e.code, "unknown_runner");
    assert.match(e.message, /gpt5/);
  });

  test("dependency_unresolved when dependsOn points at a missing node", () => {
    const e = expectErr(
      validate(run([node({ id: "a", dependsOn: ["ghost"] })]), RUNNERS, 24),
    );
    assert.equal(e.code, "dependency_unresolved");
    assert.match(e.message, /a -> ghost/);
  });

  test("cycle_detected on a two-node cycle", () => {
    const e = expectErr(
      validate(
        run([
          node({ id: "a", dependsOn: ["b"] }),
          node({ id: "b", dependsOn: ["a"] }),
        ]),
        RUNNERS,
        24,
      ),
    );
    assert.equal(e.code, "cycle_detected");
  });

  test("cycle_detected on a self-loop", () => {
    const e = expectErr(
      validate(run([node({ id: "a", dependsOn: ["a"] })]), RUNNERS, 24),
    );
    assert.equal(e.code, "cycle_detected");
  });

  test("cycle_detected on a longer cycle", () => {
    const e = expectErr(
      validate(
        run([
          node({ id: "a", dependsOn: ["c"] }),
          node({ id: "b", dependsOn: ["a"] }),
          node({ id: "c", dependsOn: ["b"] }),
        ]),
        RUNNERS,
        24,
      ),
    );
    assert.equal(e.code, "cycle_detected");
  });

  test("accepts a diamond DAG (shared upstream, parallel branches, join)", () => {
    // a -> {b, c} -> d. b and c are independent (parallel); d joins both.
    const r = validate(
      run([
        node({ id: "a" }),
        node({ id: "b", dependsOn: ["a"] }),
        node({ id: "c", dependsOn: ["a"] }),
        node({ id: "d", dependsOn: ["b", "c"] }),
      ]),
      RUNNERS,
      24,
    );
    assert.equal(r.ok, true);
  });
});

describe("findCycle", () => {
  test("returns null for an acyclic graph", () => {
    assert.equal(
      findCycle([node({ id: "a" }), node({ id: "b", dependsOn: ["a"] })]),
      null,
    );
  });

  test("returns the offending ids on a self-loop", () => {
    const cycle = findCycle([node({ id: "a", dependsOn: ["a"] })]);
    assert.notEqual(cycle, null);
    assert.deepEqual(cycle, ["a", "a"]);
  });
});
