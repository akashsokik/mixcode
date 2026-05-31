import type { RunnerKind, WorkflowRun } from "../../../shared/events.js";
import { proposeFromDraft } from "./workflow.js";
import { addDraftNode, clearDraft } from "./workflow-draft.js";

export type WorkflowToolResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; payload: { error: string; hint?: string } };

export type WorkflowProposedHandler = (
  run: WorkflowRun,
) => { ok: true } | { ok: false; error: string };

type WorkflowToolContext = {
  parentSessionId: string;
  parentRunner?: RunnerKind;
  onWorkflowProposed?: WorkflowProposedHandler;
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
