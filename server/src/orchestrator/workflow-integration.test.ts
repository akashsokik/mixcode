import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunnerKind } from "../../../shared/events.js";
import {
  proposeFromDraft,
  runWorkflow,
  type DispatchHandle,
  type DispatchReq,
  type Dispatcher,
  type NodeResult,
} from "./workflow.js";
import { addDraftNode, clearDraft } from "./workflow-draft.js";

const RUNNERS: ReadonlySet<RunnerKind> = new Set<RunnerKind>([
  "claude",
  "codex",
  "vercel",
  "ollama",
]);

// A fake dispatcher that records the EXACT prompt each node was dispatched with,
// so we can assert what context (if any) crossed between nodes. Settles a node
// when complete()/cancel() is called.
function recordingDispatcher() {
  let seq = 0;
  const resolvers = new Map<string, (r: NodeResult) => void>();
  const nodeRun = new Map<string, string>();
  const promptByNode = new Map<string, string>();

  const dispatch = (req: DispatchReq): DispatchHandle => {
    const runId = `run-${++seq}`;
    promptByNode.set(req.nodeId, req.prompt);
    nodeRun.set(req.nodeId, runId);
    const done = new Promise<NodeResult>((res) => resolvers.set(runId, res));
    return { runId, done };
  };
  const disp: Dispatcher = {
    dispatch,
    cancel: (runId) => {
      const r = resolvers.get(runId);
      if (r) {
        resolvers.delete(runId);
        r({ status: "cancelled" });
      }
    },
  };
  return {
    disp,
    complete: (nodeId: string, output: string) => {
      const runId = nodeRun.get(nodeId);
      const r = runId ? resolvers.get(runId) : undefined;
      if (!runId || !r) throw new Error(`no in-flight run for "${nodeId}"`);
      resolvers.delete(runId);
      r({ status: "ok", output });
    },
    promptFor: (nodeId: string) => promptByNode.get(nodeId),
    dispatched: (nodeId: string) => promptByNode.has(nodeId),
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// The user's exact scenario, end to end through the real propose + execute path:
//   1. explore the project        (agent 1, root)
//   2. understand component A      (agent 2, depends on 1)
//   3. understand component B      (agent 3, depends on 1)
// Asserts: 2 and 3 each receive ONLY agent 1's final output, never each other's
// context, and run in parallel (both dispatched after 1 settles).
describe("workflow integration: draft -> propose -> execute (isolation)", () => {
  test("fan-out shares only the upstream final output, nothing between siblings", async () => {
    const s = "integ-fanout";
    clearDraft(s);
    addDraftNode(s, { id: "explore", title: "explore the project", runner: "claude", prompt: "Explore the repository and summarize its structure." });
    addDraftNode(s, { id: "compA", title: "understand component A", runner: "claude", prompt: "Explain component A in depth.", dependsOn: ["explore"] });
    addDraftNode(s, { id: "compB", title: "understand component B", runner: "codex", prompt: "Explain component B in depth.", dependsOn: ["explore"] });

    const proposed = proposeFromDraft({ sessionId: s, goal: "understand the project", planner: "claude", knownRunners: RUNNERS });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const run = proposed.run;
    assert.equal(run.status, "proposed");
    assert.equal(run.nodes.length, 3);

    const fake = recordingDispatcher();
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();

    // Only the root is dispatched at the start; its prompt is verbatim (no injection).
    assert.equal(fake.dispatched("explore"), true);
    assert.equal(fake.dispatched("compA"), false);
    assert.equal(fake.dispatched("compB"), false);
    assert.equal(fake.promptFor("explore"), "Explore the repository and summarize its structure.");

    // Agent 1 finishes with a distinctive final output.
    const EXPLORE_OUT = "ROOT-OUTPUT: the repo has a server and a tui package.";
    fake.complete("explore", EXPLORE_OUT);
    await tick();

    // Both dependents now dispatched (parallel fan-out).
    assert.equal(fake.dispatched("compA"), true);
    assert.equal(fake.dispatched("compB"), true);

    const aPrompt = fake.promptFor("compA") ?? "";
    const bPrompt = fake.promptFor("compB") ?? "";

    // Each dependent keeps its own authored prompt...
    assert.match(aPrompt, /^Explain component A in depth\./);
    assert.match(bPrompt, /^Explain component B in depth\./);
    // ...and receives agent 1's final output (the ONLY thing injected).
    assert.ok(aPrompt.includes(EXPLORE_OUT), "compA got the root's output");
    assert.ok(bPrompt.includes(EXPLORE_OUT), "compB got the root's output");

    // Isolation between siblings: compA must NOT see compB's prompt/output and
    // vice versa. They never share context - only the shared upstream does.
    assert.ok(!aPrompt.includes("component B"), "compA must not see compB");
    assert.ok(!bPrompt.includes("component A"), "compB must not see compA");

    fake.complete("compA", "A done");
    fake.complete("compB", "B done");
    await ctrl.done;
    assert.equal(run.status, "done");
    clearDraft(s);
  });

  test("propose surfaces a validation error (cycle) and does not produce a run", async () => {
    const s = "integ-cycle";
    clearDraft(s);
    addDraftNode(s, { id: "a", title: "a", runner: "claude", prompt: "x", dependsOn: ["b"] });
    addDraftNode(s, { id: "b", title: "b", runner: "claude", prompt: "y", dependsOn: ["a"] });
    const r = proposeFromDraft({ sessionId: s, goal: "g", planner: "claude", knownRunners: RUNNERS });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /cycle_detected/);
    clearDraft(s);
  });

  test("propose rejects an empty draft", () => {
    const s = "integ-empty";
    clearDraft(s);
    const r = proposeFromDraft({ sessionId: s, goal: "g", planner: "claude", knownRunners: RUNNERS });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no nodes in draft/);
  });
});
