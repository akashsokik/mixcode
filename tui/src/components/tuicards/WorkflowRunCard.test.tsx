import { describe, expect, test } from "bun:test";
import { buildNodeSections } from "./WorkflowRunCard";
import { blocksFromEvents } from "../../util/blocks";
import type { RunEvent, WorkflowRun } from "../../../../shared/events.ts";

// Two parallel nodes (A, B) whose peer events interleave in the host message,
// exactly as the detached scheduler appends them.
const interleaved: RunEvent[] = [
  { type: "tool_log", log: { name: "[ollama][nodeAAAA…] reply", output: "A result" } },
  { type: "tool_log", log: { name: "[ollama][nodeBBBB…] reply", output: "B result" } },
  { type: "tool_log", log: { name: "[ollama][nodeAAAA…] Bash", input: {}, output: "ranA" } },
];

function run(): WorkflowRun {
  return {
    id: "wf_run_123",
    sessionId: "s1",
    goal: "demo",
    planner: "ollama",
    status: "done",
    createdAt: 0,
    nodes: [
      {
        id: "B",
        title: "Transform B",
        runner: "ollama",
        prompt: "b",
        status: "ok",
        attempt: 1,
        runId: "nodeBBBB1234567",
      },
      {
        id: "A",
        title: "Transform A",
        runner: "ollama",
        prompt: "a",
        status: "ok",
        attempt: 1,
        runId: "nodeAAAA1234567",
      },
    ],
  };
}

describe("buildNodeSections", () => {
  test("de-interleaves blocks into per-node sections, ordered by run.nodes", () => {
    const sections = buildNodeSections(run(), blocksFromEvents(interleaved));
    // Section order follows run.nodes (B before A), not stream arrival.
    expect(sections.map((s) => s.title)).toEqual(["Transform B", "Transform A"]);
    const a = sections.find((s) => s.title === "Transform A")!;
    const b = sections.find((s) => s.title === "Transform B")!;
    expect(a.blocks).toHaveLength(2); // reply + Bash
    expect(b.blocks).toHaveLength(1); // reply only
    expect(a.status).toBe("ok");
    expect(a.runner).toBe("ollama");
  });

  test("falls back to runId grouping when the run is unknown", () => {
    const sections = buildNodeSections(null, blocksFromEvents(interleaved));
    expect(sections.map((s) => s.key).sort()).toEqual([
      "nodeAAAA…",
      "nodeBBBB…",
    ]);
    // Runner is inferred from the blocks themselves.
    expect(sections.every((s) => s.runner === "ollama")).toBe(true);
  });

  test("appends captured work whose runId matches no node (nothing dropped)", () => {
    const r = run();
    r.nodes = [r.nodes[1]]; // keep only node A
    const sections = buildNodeSections(r, blocksFromEvents(interleaved));
    // Node A from the run, plus B's orphaned blocks appended by runId.
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Transform A");
    expect(sections[1].key).toBe("nodeBBBB…");
  });
});
