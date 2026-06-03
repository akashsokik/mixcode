import type { RunnerKind, WorkflowNode, WorkflowRun } from "../../../shared/events.js";
import { getWorkflowRun, isWorkflowActive, proposeFromDraft } from "./workflow.js";
import { addDraftNode, clearDraft } from "./workflow-draft.js";

export type WorkflowToolResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; payload: { error: string; hint?: string } };

export type WorkflowProposedHandler = (
  run: WorkflowRun,
) => { ok: true } | { ok: false; error: string };

// Cancels the session's active workflow. index.ts owns the live-controller
// registry, so the cancel itself happens there; this callback is the bridge.
export type WorkflowCancelHandler = (
  sessionId: string,
) => { ok: true; cancelled: boolean } | { ok: false; error: string };

type WorkflowToolContext = {
  parentSessionId: string;
  parentRunner?: RunnerKind;
  onWorkflowProposed?: WorkflowProposedHandler;
  onWorkflowCancel?: WorkflowCancelHandler;
};

export type WorkflowAddNodeInput = {
  id: string;
  title: string;
  runner: RunnerKind;
  model?: string;
  prompt: string;
  dependsOn?: string[];
};

export type WorkflowRunInput = {
  goal: string;
};

const KNOWN_WORKFLOW_RUNNERS: ReadonlySet<RunnerKind> = new Set([
  "claude",
  "codex",
  "vercel",
  "ollama",
]);

export function executeWorkflowAddNode(
  input: WorkflowAddNodeInput,
  ctx: WorkflowToolContext,
): WorkflowToolResult {
  const r = addDraftNode(ctx.parentSessionId, {
    id: input.id,
    title: input.title,
    runner: input.runner,
    model: input.model,
    prompt: input.prompt,
    dependsOn: input.dependsOn,
  });
  if (!r.ok) return { ok: false, payload: { error: r.error } };
  return {
    ok: true,
    payload: {
      added: input.id,
      nodesInDraft: r.count,
      next: "Add remaining nodes, then call workflow_run to propose the DAG for approval.",
    },
  };
}

export function executeWorkflowRun(
  input: WorkflowRunInput,
  ctx: WorkflowToolContext,
): WorkflowToolResult {
  if (!ctx.parentRunner) {
    return { ok: false, payload: { error: "missing parent context" } };
  }
  const r = proposeFromDraft({
    sessionId: ctx.parentSessionId,
    goal: input.goal,
    planner: ctx.parentRunner,
    knownRunners: KNOWN_WORKFLOW_RUNNERS,
  });
  if (!r.ok) {
    return {
      ok: false,
      payload: { error: r.error, hint: "fix the draft and call workflow_run again" },
    };
  }
  if (!ctx.onWorkflowProposed) {
    return {
      ok: false,
      payload: { error: "workflows are not available on this runner" },
    };
  }
  const accepted = ctx.onWorkflowProposed(r.run);
  if (!accepted.ok) {
    return { ok: false, payload: { error: accepted.error } };
  }
  clearDraft(ctx.parentSessionId);
  return {
    ok: true,
    payload: {
      proposed: r.run.id,
      nodes: r.run.nodes.length,
      status: "awaiting the user's approval - stop here; do not run the nodes yourself.",
    },
  };
}

export function executeWorkflowReset(
  ctx: Pick<WorkflowToolContext, "parentSessionId">,
): WorkflowToolResult {
  clearDraft(ctx.parentSessionId);
  return { ok: true, payload: { reset: true } };
}

// Per-node output preview length for workflow_observe. The full output (up to
// NODE_OUTPUT_MAX) can be 100 KB; observe is a status poll, not an output dump,
// so each node contributes at most this many chars to keep the snapshot small.
const OBSERVE_PREVIEW_MAX = 2_000;

type NodeSnapshot = {
  id: string;
  title: string;
  runner: RunnerKind;
  status: WorkflowNode["status"];
  hasOutput: boolean;
  outputPreview?: string;
  error?: string;
};

function previewOutput(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= OBSERVE_PREVIEW_MAX) return s;
  return `${s.slice(0, OBSERVE_PREVIEW_MAX)}...[+${s.length - OBSERVE_PREVIEW_MAX} chars]`;
}

function summarizeWorkflow(run: WorkflowRun): {
  workflowId: string;
  goal: string;
  status: WorkflowRun["status"];
  nodes: NodeSnapshot[];
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const nodes = run.nodes.map((n): NodeSnapshot => {
    counts[n.status] = (counts[n.status] ?? 0) + 1;
    const hasOutput = n.output !== undefined && n.output.trim().length > 0;
    const snap: NodeSnapshot = {
      id: n.id,
      title: n.title,
      runner: n.runner,
      status: n.status,
      hasOutput,
    };
    if (hasOutput) snap.outputPreview = previewOutput(n.output);
    if (n.error) snap.error = n.error;
    return snap;
  });
  return { workflowId: run.id, goal: run.goal, status: run.status, nodes, counts };
}

// Non-blocking peek at the session's active workflow: per-node status, a bounded
// output preview, and aggregate counts. Mirrors task_observe / collab_observe so
// the model that proposed the DAG can poll the engine instead of running blind
// until the completion context is injected.
export function executeWorkflowObserve(
  ctx: Pick<WorkflowToolContext, "parentSessionId">,
): WorkflowToolResult {
  const run = getWorkflowRun(ctx.parentSessionId);
  if (!run) {
    return { ok: false, payload: { error: "no active workflow for this session" } };
  }
  return { ok: true, payload: { snapshot: summarizeWorkflow(run) } };
}

// Cancel the session's active workflow. Aborts in-flight node runs, marks
// pending nodes skipped, and settles the run cancelled (the actual teardown
// lives in index.ts behind onWorkflowCancel, which owns the live controller).
export function executeWorkflowCancel(
  ctx: Pick<WorkflowToolContext, "parentSessionId" | "onWorkflowCancel">,
): WorkflowToolResult {
  const run = getWorkflowRun(ctx.parentSessionId);
  if (!run) {
    return { ok: false, payload: { error: "no active workflow to cancel" } };
  }
  if (!isWorkflowActive(run)) {
    return {
      ok: true,
      payload: { workflowId: run.id, cancelled: false, status: run.status },
    };
  }
  if (!ctx.onWorkflowCancel) {
    return {
      ok: false,
      payload: { error: "workflows are not available on this runner" },
    };
  }
  const r = ctx.onWorkflowCancel(ctx.parentSessionId);
  if (!r.ok) return { ok: false, payload: { error: r.error } };
  return { ok: true, payload: { workflowId: run.id, cancelled: r.cancelled } };
}
