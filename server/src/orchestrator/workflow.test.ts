import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkflowNode, WorkflowRun } from "../../../shared/events.js";
import * as workflowExports from "./workflow.js";
import {
  buildNodePrompt,
  NODE_CONTEXT_MAX,
  NODE_OUTPUT_MAX,
  isWorkflowActive,
  runWorkflow,
  truncateOutput,
  type DispatchHandle,
  type DispatchReq,
  type Dispatcher,
  type NodeResult,
} from "./workflow.js";

// ----- fake dispatcher -----
//
// Ports executor.go's fakeDispatcher. dispatch() hands back a runId + a `done`
// promise; the test driver settles it with complete()/completeByNode()/cancel.
// A run settles at most once (delete-then-resolve), like the Go buffered chan.

function newFakeDispatcher() {
  let seq = 0;
  const resolvers = new Map<string, (r: NodeResult) => void>();
  const nodeRun = new Map<string, string>(); // nodeId -> latest runId
  let maxInflight = 0;

  const dispatch = (req: DispatchReq): DispatchHandle => {
    const runId = `run-${(++seq).toString(16).padStart(4, "0")}`;
    const done = new Promise<NodeResult>((res) => resolvers.set(runId, res));
    nodeRun.set(req.nodeId, runId);
    if (resolvers.size > maxInflight) maxInflight = resolvers.size;
    return { runId, done };
  };

  const finish = (runId: string, res: NodeResult): void => {
    const r = resolvers.get(runId);
    if (!r) return;
    resolvers.delete(runId);
    r(res);
  };

  const disp: Dispatcher = {
    dispatch,
    cancel: (runId: string) => finish(runId, { status: "cancelled" }),
  };

  return {
    disp,
    complete: (runId: string, output: string, err?: string) =>
      finish(
        runId,
        err ? { status: "error", error: err } : { status: "ok", output },
      ),
    completeByNode: (nodeId: string, output: string, err?: string) => {
      const runId = nodeRun.get(nodeId);
      if (!runId || !resolvers.has(runId)) {
        throw new Error(`fakeDispatcher: no in-flight run for node "${nodeId}"`);
      }
      finish(
        runId,
        err ? { status: "error", error: err } : { status: "ok", output },
      );
    },
    lastRunForNode: (nodeId: string) => nodeRun.get(nodeId),
    inflight: () => resolvers.size,
    maxInflight: () => maxInflight,
  };
}

// ----- helpers -----

function node(partial: Partial<WorkflowNode> & { id: string }): WorkflowNode {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    runner: partial.runner ?? "claude",
    model: partial.model,
    prompt: partial.prompt ?? "work",
    dependsOn: partial.dependsOn,
    status: partial.status ?? "pending",
    attempt: 0,
    output: partial.output,
  };
}

function makeRun(nodes: WorkflowNode[]): WorkflowRun {
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

function byId(run: WorkflowRun, id: string): WorkflowNode {
  const n = run.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

// Drain the microtask queue so handle.done.then(...) settle handlers run
// before assertions. A couple of awaits cover chained re-pumps.
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("workflow scheduler", () => {
  test("dispatches only ready nodes; a dependent waits for its parent", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([
      node({ id: "a" }),
      node({ id: "b", dependsOn: ["a"], prompt: "use the recon" }),
    ]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();

    // Only a is dispatchable at the start.
    assert.equal(byId(run, "a").status, "running");
    assert.equal(byId(run, "b").status, "pending");
    assert.equal(fake.inflight(), 1);

    fake.completeByNode("a", "A-OUT");
    await tick();

    // b now ready and dispatched once a settled ok.
    assert.equal(byId(run, "a").status, "ok");
    assert.equal(byId(run, "a").output, "A-OUT");
    assert.equal(byId(run, "b").status, "running");

    fake.completeByNode("b", "B-OUT");
    await ctrl.done;

    assert.equal(run.status, "done");
    assert.equal(byId(run, "b").status, "ok");
  });

  test("auto-injects ONLY the upstream final output into the dependent's prompt", async () => {
    // The sole inter-node channel: b's own prompt, plus a's final output text.
    // No template strings, no shared session - this is the isolation contract.
    const fake = newFakeDispatcher();
    let bPrompt = "";
    const wrapped: Dispatcher = {
      dispatch: (req) => {
        if (req.nodeId === "b") bPrompt = req.prompt;
        return fake.disp.dispatch(req);
      },
      cancel: fake.disp.cancel,
    };
    const run = makeRun([
      node({ id: "a", title: "recon" }),
      node({ id: "b", dependsOn: ["a"], prompt: "summarize the recon" }),
    ]);
    const ctrl = runWorkflow(run, wrapped, () => {});
    await tick();
    fake.completeByNode("a", "forty-two");
    await tick();
    // b's authored prompt is preserved, and a's output is injected after it.
    assert.match(bPrompt, /^summarize the recon/);
    assert.match(bPrompt, /forty-two/);
    assert.match(bPrompt, /upstream step "recon"/);
    fake.completeByNode("b", "done");
    await ctrl.done;
  });

  test("a root node's prompt is dispatched verbatim (no injection)", async () => {
    const fake = newFakeDispatcher();
    let aPrompt = "";
    const wrapped: Dispatcher = {
      dispatch: (req) => {
        if (req.nodeId === "a") aPrompt = req.prompt;
        return fake.disp.dispatch(req);
      },
      cancel: fake.disp.cancel,
    };
    const run = makeRun([node({ id: "a", prompt: "explore the project" })]);
    const ctrl = runWorkflow(run, wrapped, () => {});
    await tick();
    assert.equal(aPrompt, "explore the project");
    fake.completeByNode("a", "x");
    await ctrl.done;
  });

  test("enforces the parallel cap of 4 with more ready siblings than the cap", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([
      node({ id: "n1" }),
      node({ id: "n2" }),
      node({ id: "n3" }),
      node({ id: "n4" }),
      node({ id: "n5" }),
      node({ id: "n6" }),
    ]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();

    // 6 independent ready nodes, cap 4 -> only 4 in flight.
    assert.equal(fake.inflight(), 4);

    // Settling one frees a slot; the 5th gets dispatched, cap still holds.
    fake.completeByNode("n1", "x");
    await tick();
    assert.equal(fake.inflight(), 4);

    fake.completeByNode("n2", "x");
    fake.completeByNode("n3", "x");
    await tick();
    // 4 done, n4/n5/n6 in flight -> 3.
    assert.equal(fake.inflight(), 3);

    fake.completeByNode("n4", "x");
    fake.completeByNode("n5", "x");
    fake.completeByNode("n6", "x");
    await ctrl.done;

    assert.equal(run.status, "done");
    assert.ok(
      fake.maxInflight() <= 4,
      `maxInflight ${fake.maxInflight()} exceeded cap 4`,
    );
  });

  test("transitively skips dependents of a failed node", async () => {
    // a -> b -> c ; a fails -> b and c both skipped. A parallel branch d runs.
    const fake = newFakeDispatcher();
    const run = makeRun([
      node({ id: "a" }),
      node({ id: "b", dependsOn: ["a"], prompt: "use a" }),
      node({ id: "c", dependsOn: ["b"], prompt: "use b" }),
      node({ id: "d" }),
    ]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();

    fake.completeByNode("a", "", "boom");
    await tick();

    assert.equal(byId(run, "a").status, "error");
    assert.equal(byId(run, "b").status, "skipped");
    assert.equal(byId(run, "c").status, "skipped");

    // d is independent and still running.
    assert.equal(byId(run, "d").status, "running");
    fake.completeByNode("d", "ok");
    await ctrl.done;

    // any error -> failed
    assert.equal(run.status, "failed");
  });

  test("terminal status is done when every node succeeds", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([node({ id: "a" }), node({ id: "b" })]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();
    fake.completeByNode("a", "x");
    fake.completeByNode("b", "y");
    await ctrl.done;
    assert.equal(run.status, "done");
  });

  test("cancel cancels in-flight nodes and skips pending ones", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([
      node({ id: "a" }),
      node({ id: "b", dependsOn: ["a"], prompt: "use a" }),
    ]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();

    assert.equal(byId(run, "a").status, "running");
    assert.equal(byId(run, "b").status, "pending");

    ctrl.cancel();
    await ctrl.done;

    assert.equal(run.status, "cancelled");
    assert.equal(byId(run, "a").status, "cancelled"); // in-flight -> cancelled
    assert.equal(byId(run, "b").status, "skipped"); // pending -> skipped
    assert.equal(fake.inflight(), 0); // disp.cancel settled the run
  });

  test("cancel emits the cancelled snapshot immediately before in-flight runs drain", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([
      node({ id: "a" }),
      node({ id: "b", dependsOn: ["a"], prompt: "use a" }),
    ]);
    const statuses: string[] = [];
    const ctrl = runWorkflow(run, fake.disp, () => {
      statuses.push(run.status);
    });
    await tick();

    ctrl.cancel();

    assert.equal(run.status, "cancelled");
    assert.equal(byId(run, "a").status, "cancelled");
    assert.equal(byId(run, "b").status, "skipped");
    assert.equal(statuses.at(-1), "cancelled");
    await ctrl.done;
  });

  test("an empty graph settles done immediately", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await ctrl.done;
    assert.equal(run.status, "done");
  });

  test("emit is called on every transition", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([node({ id: "a" })]);
    let emits = 0;
    const ctrl = runWorkflow(run, fake.disp, () => {
      emits += 1;
    });
    await tick();
    const afterDispatch = emits;
    fake.completeByNode("a", "x");
    await ctrl.done;
    assert.ok(afterDispatch >= 1, "emit fired during dispatch");
    assert.ok(emits > afterDispatch, "emit fired again on settle/terminal");
  });

  test("retries a node once on a transient error, then succeeds", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([node({ id: "a" })]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();
    assert.equal(byId(run, "a").attempt, 1);

    // Transient drop -> re-queued and re-dispatched (attempt 2), NOT failed.
    fake.completeByNode(
      "a",
      "",
      "vercel sdk: stream ended after step 1 without a finish event",
    );
    await tick();
    assert.equal(byId(run, "a").status, "running");
    assert.equal(byId(run, "a").attempt, 2);

    fake.completeByNode("a", "RECOVERED");
    await ctrl.done;
    assert.equal(byId(run, "a").status, "ok");
    assert.equal(byId(run, "a").output, "RECOVERED");
    assert.equal(run.status, "done");
  });

  test("gives up after the attempt cap on repeated transient errors", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([node({ id: "a" })]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();
    fake.completeByNode("a", "", "ECONNRESET"); // attempt 1 -> retry
    await tick();
    assert.equal(byId(run, "a").attempt, 2);
    fake.completeByNode("a", "", "ECONNRESET"); // attempt 2 == cap -> fail
    await ctrl.done;
    assert.equal(byId(run, "a").status, "error");
    assert.equal(run.status, "failed");
  });

  test("does not retry a non-transient error", async () => {
    const fake = newFakeDispatcher();
    const run = makeRun([node({ id: "a" })]);
    const ctrl = runWorkflow(run, fake.disp, () => {});
    await tick();
    fake.completeByNode("a", "", "invalid output: schema mismatch");
    await ctrl.done;
    assert.equal(byId(run, "a").status, "error");
    assert.equal(byId(run, "a").attempt, 1); // never re-dispatched
    assert.equal(run.status, "failed");
  });
});

describe("truncateOutput", () => {
  test("passes through undefined and short output unchanged", () => {
    assert.equal(truncateOutput(undefined), undefined);
    assert.equal(truncateOutput("short"), "short");
  });

  test("caps oversized output and notes how much was dropped", () => {
    const big = "x".repeat(NODE_OUTPUT_MAX + 5000);
    const out = truncateOutput(big);
    assert.ok(out !== undefined);
    assert.ok(out.length < big.length, "output was shortened");
    assert.ok(out.length <= NODE_OUTPUT_MAX + 64, "stays near the cap");
    assert.match(out, /truncated 5000 chars/);
  });
});

describe("buildNodePrompt context budgeting", () => {
  test("caps the total injected upstream context across many dependencies", () => {
    const deps = Array.from({ length: 6 }, (_, i) =>
      node({
        id: `dep${i}`,
        title: `Dependency ${i}`,
        prompt: "root",
        status: "ok",
        output: "x".repeat(NODE_CONTEXT_MAX),
      }),
    );
    const join = node({
      id: "join",
      prompt: "synthesize",
      dependsOn: deps.map((d) => d.id),
    });
    const byId = new Map([...deps, join].map((n) => [n.id, n]));

    const prompt = buildNodePrompt(join, byId);

    assert.ok(prompt.startsWith("synthesize"));
    assert.ok(prompt.length < NODE_CONTEXT_MAX + 2000);
    assert.match(prompt, /workflow context truncated/);
  });
});

describe("isWorkflowActive", () => {
  test("treats only proposed and running workflows as active", () => {
    for (const status of ["proposed", "running"] as const) {
      assert.equal(isWorkflowActive({ ...makeRun([]), status }), true);
    }
    for (const status of ["done", "failed", "cancelled"] as const) {
      assert.equal(isWorkflowActive({ ...makeRun([]), status }), false);
    }
  });
});

describe("workflow completion handoff", () => {
  function handoffBuilder(): (run: WorkflowRun) => string | null {
    const fn = (workflowExports as Record<string, unknown>).buildWorkflowCompletionContext;
    assert.equal(typeof fn, "function");
    return fn as (run: WorkflowRun) => string | null;
  }

  function promptBuilder(): (userText: string, context: string | null | undefined) => string {
    const fn = (workflowExports as Record<string, unknown>).withWorkflowCompletionContext;
    assert.equal(typeof fn, "function");
    return fn as (userText: string, context: string | null | undefined) => string;
  }

  test("hands Agent 1 only terminal synthesis output, not every fan-out output", () => {
    const build = handoffBuilder();
    const run = makeRun([
      node({ id: "define_problem", status: "ok", output: "ROOT_RAW_PROBLEM" }),
      node({
        id: "analyze_engineering",
        status: "ok",
        output: "ENGINEERING_RAW_ANALYSIS",
        dependsOn: ["define_problem"],
      }),
      node({
        id: "analyze_business",
        status: "ok",
        output: "BUSINESS_RAW_ANALYSIS",
        dependsOn: ["define_problem"],
      }),
      node({
        id: "analyze_operational",
        status: "ok",
        output: "OPERATIONS_RAW_ANALYSIS",
        dependsOn: ["define_problem"],
      }),
      node({
        id: "synthesize",
        title: "Synthesize Multi-Perspective Insights",
        status: "ok",
        output: "FINAL_SYNTHESIS_FOR_PARENT_AGENT",
        dependsOn: ["analyze_engineering", "analyze_business", "analyze_operational"],
      }),
    ]);
    run.status = "done";

    const context = build(run);

    assert.ok(context);
    assert.match(context, /Workflow completed/);
    assert.match(context, /Synthesize Multi-Perspective Insights/);
    assert.match(context, /FINAL_SYNTHESIS_FOR_PARENT_AGENT/);
    assert.doesNotMatch(context, /ENGINEERING_RAW_ANALYSIS/);
    assert.doesNotMatch(context, /BUSINESS_RAW_ANALYSIS/);
    assert.doesNotMatch(context, /OPERATIONS_RAW_ANALYSIS/);
    assert.doesNotMatch(context, /ROOT_RAW_PROBLEM/);
  });

  test("wraps the next user prompt with workflow context for the runner only", () => {
    const wrap = promptBuilder();
    const prompt = wrap("what's the result?", "Workflow completed.\nFINAL_SYNTHESIS");

    assert.match(prompt, /^Context from the most recent completed workflow:/);
    assert.match(prompt, /FINAL_SYNTHESIS/);
    assert.match(prompt, /User message:\nwhat's the result\?$/);
  });
});
