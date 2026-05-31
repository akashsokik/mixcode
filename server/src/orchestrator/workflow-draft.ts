// Per-session draft store for the tool-authored /workflow path.
//
// The workflow authoring model assembles a DAG by calling `workflow_add_node` one node at a
// time (delegate.ts); those nodes accumulate here until `workflow_run` snapshots
// them into a proposed WorkflowRun. This replaces the old planner that emitted
// one JSON blob - zod-validated tool args make a malformed node impossible to
// add, so there is no parse step. State is in-memory, keyed by sessionId (one
// draft per session), and is reset at the start of each /workflow authoring turn
// and on /clear / delete_session, mirroring the WorkflowRun store in workflow.ts.

import type { RunnerKind, WorkflowNode } from "../../../shared/events.js";

// A node as the model declares it: only the authored fields. The engine-owned
// fields (status, attempt, runId, output, timing) are filled by draftToNodes.
export type DraftNode = {
  id: string;
  title: string;
  runner: RunnerKind;
  model?: string;
  prompt: string;
  dependsOn?: string[];
};

const draftBySession = new Map<string, DraftNode[]>();

export function getDraft(sessionId: string): DraftNode[] {
  return draftBySession.get(sessionId) ?? [];
}

// Append a node. Rejects a duplicate id within the same draft so the model gets
// immediate feedback instead of a later validate failure. (Cross-node checks -
// cycles, unresolved deps - are deferred to validate() at workflow_run time,
// since deps may legitimately reference a not-yet-added node.)
export function addDraftNode(
  sessionId: string,
  node: DraftNode,
): { ok: true; count: number } | { ok: false; error: string } {
  const draft = draftBySession.get(sessionId) ?? [];
  if (draft.some((n) => n.id === node.id)) {
    return { ok: false, error: `duplicate node id "${node.id}" in this draft` };
  }
  draft.push(node);
  draftBySession.set(sessionId, draft);
  return { ok: true, count: draft.length };
}

export function clearDraft(sessionId: string): void {
  draftBySession.delete(sessionId);
}

// Promote draft nodes to full WorkflowNodes in the engine's initial state.
export function draftToNodes(draft: DraftNode[]): WorkflowNode[] {
  return draft.map((n) => ({
    id: n.id,
    title: n.title,
    runner: n.runner,
    model: n.model,
    prompt: n.prompt,
    dependsOn: n.dependsOn,
    status: "pending",
    attempt: 0,
  }));
}
