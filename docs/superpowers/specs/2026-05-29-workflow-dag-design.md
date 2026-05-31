# /workflow — Model-Authored DAG Orchestration

**Date:** 2026-05-29
**Status:** Design (brainstorm complete, pending user review -> implementation plan)
**Author:** brainstorm with akashswamy

## Revision 2026-05-30 — tool-authored, not JSON-authored (IMPLEMENTED)

Status: implemented. Server + TUI typecheck clean; engine, validate, and draft
tests pass. The per-node isolation guarantee below was verified by reading the
actual node-dispatch paths in all four runners (claude `resumeId: undefined`,
codex `threadId: undefined`, ollama/vercel `priorMessages: []` with `sessionId`
used only for permission gating) - no node shares context with any other; the
sole inter-node channel is buildNodePrompt injecting an upstream node's final
output text.


The v1 above shipped but had the planner emit one static JSON DAG, parsed by
`workflow-planner.ts`. That parsing was fragile by construction (weak models add
trailing prose, drop the ```json tag, etc. — a stream of `no_fence`/`bad_json`
bugs) and `{{nodeX.output}}` template interpolation was a second fragile string
subsystem. The project already exposes a 21-tool orchestrator MCP server
(`buildDelegateMcpServer`, delegate.ts) to the model; `/workflow` ignored it.

The reshape (this revision supersedes the JSON-authoring parts below):

- **Authoring moves to MCP tools** on the existing `orchestrator` server, in the
  model's own session turn (which has conversation context the cold planner
  lacked). New tools: `workflow_add_node({id, title, runner, prompt, dependsOn})`
  accumulates a per-session draft; `workflow_run()` validates the draft, builds a
  `proposed` `WorkflowRun`, and broadcasts `workflow_state` so the approval modal
  mounts. `workflow_reset()` clears a half-built draft.
- **Delete `workflow-planner.ts`** + `workflow-planner.test.ts` +
  `workflow-template.test.ts`. Keep the `workflow_start` ClientMsg as the TUI
  entrypoint, but delete the `runWorkflowTurn`/`createPlannerTurn` planner
  lifecycle and `WORKFLOW_PLANNER_TIMEOUT_SEC`. Zod-validated tool args replace
  JSON extraction.
- **Delete `{{nodeX.output}}` templates** (`resolveTemplate`). The engine
  auto-injects upstream outputs: when a node becomes ready, its effective prompt
  is `node.prompt` followed by a "Context from upstream steps" section built from
  each `dependsOn` node's captured output. `WorkflowNode.promptTemplate` ->
  `prompt`.
- **Keep, unchanged:** the engine (`workflow.ts` scheduler, ready-set topo,
  retries, output truncation), the `proposed -> approve -> runWorkflow` lifecycle
  (`workflow_approve`/`workflow_cancel`/`workflow_state`/`workflow_cleared`), the
  inline `WorkflowCard`, the emergent DAG `WorkflowPanel`, and the approval modal.
- **`/workflow <goal>`** in the TUI still sends `workflow_start`; the server
  handles that by opening a normal Claude turn whose prompt instructs the model
  to assemble a DAG via the `workflow_*` tools for `<goal>`, then call
  `workflow_run`.

**Boundary vs `task_spawn`** (both fan out peers, so the line goes in the tool
descriptions): `task_spawn` = fire-and-forget parallel siblings with no data flow,
the model awaits and synthesizes itself (model in loop). `workflow` =
dependency-ordered multi-stage graph the engine runs autonomously after one
approval, auto-feeding each node's output to its dependents.

## Goal

Add a fourth orchestration primitive, `/workflow`, that runs a DAG of agent
nodes. A user types a goal; a chosen planner runner emits a dependency graph
of nodes (each bound to a runner + prompt); the user approves it; an in-process
engine executes the graph respecting `dependsOn` edges, passing each node's
output into downstream prompts. The TUI shows progress as an inline card that
expands into a full DAG panel on demand.

The DAG model and engine semantics are ported from the `agent-orc` (orca)
project's `runtime/planner` package. We reuse the **design**, not the
deployment: orca's Go conductor/runner/sidecar control plane is NOT adopted.

## Why port, not call

orca exposes a workflows HTTP API and a generated TypeScript client. We could
run orca's conductor and call it. We do not, because:

- It puts **two copies of the agent loop** in one tool: adversarial-code's
  in-process runners (`claude`/`codex`/`vercel`/`ollama`) AND orca's Node
  sidecars doing the same SDK work.
- It bolts a Go + Docker control plane onto a tool whose identity is local,
  in-process, single-WebSocket.

The reusable core is small. Port it to TypeScript and drive the existing
`startSubtaskRun` execution layer.

Caveat: if durable/scheduled/cloud workflows are ever wanted (orca has
`WorkflowSchedule`/cron, `WorkflowDefinition` templates), the calculus flips
toward calling the service. Nothing in the current scope needs that.

## Non-goals (v1 YAGNI cuts)

- **No repair/amend loop.** orca's engine can pause a failed run and ask the
  orchestrator to amend the plan (`repairCount`). v1 marks the node `error`,
  skips its dependents, and finishes `failed`.
- **No schedules/cron** (`WorkflowSchedule`).
- **No reusable definitions/templates** (`WorkflowDefinition`). Each
  `/workflow` invocation is a one-shot run.
- **No nested workflows.** A node cannot itself spawn a workflow. The existing
  `MAX_DEPTH` delegation guard still applies to node runs.
- **No persistence across server restart.** Workflow state lives in server
  memory, cleared on `/clear`, `delete_session`, and process exit — same as
  `tasks`/`consensus` today.

## Relationship to existing primitives

`/workflow` is added **beside** `tasks`, `collab`, and `consensus`, sharing the
`delegate.ts` execution layer but with its own module and TUI surface.

Note for the future: `tasks.ts` (parallel siblings, no dependency edges) is the
degenerate case of a workflow with no `dependsOn`. A later cleanup could
reimplement `tasks` on top of the workflow engine and retire the separate
module. Out of scope for v1 by explicit decision.

## Data model

New file `server/src/orchestrator/workflow.ts`. Ported from orca's
`WorkflowNode`/`WorkflowRun`, dropping the deprecated `PlanNode` bridge name
and all cloud fields.

```ts
type NodeStatus =
  | "pending"   // unmet dependencies
  | "ready"     // all deps satisfied, dispatchable
  | "running"
  | "ok"
  | "error"
  | "skipped"   // bypassed due to upstream failure
  | "cancelled";

type WorkflowStatus =
  | "proposed"  // planner emitted it, awaiting user approval
  | "running"
  | "done"
  | "failed"
  | "cancelled";

type WorkflowNode = {
  id: string;
  title: string;
  runner: RunnerKind;        // orca "profile" -> existing runner
  model?: string;            // optional per-node model override
  promptTemplate: string;    // {{node<id>.output}} and {{node<id>.fields.path}}
  dependsOn?: string[];
  outputSchema?: object;     // optional JSON Schema -> parsed into `fields`
  status: NodeStatus;
  runId?: string;
  output?: string;
  fields?: unknown;          // structured output parsed via outputSchema
  error?: string;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
};

type WorkflowRun = {
  id: string;
  sessionId: string;
  goal: string;
  planner: RunnerKind;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
};
```

## Engine (the port)

Ported near-verbatim from `agent-orc/agent-runtime/runtime/planner/`:

1. **`validate(run, knownRunners, maxNodes)`** — from `validate.go` +
   `template.go`'s static checks:
   - node count cap, unique IDs, known runner per node, every `dependsOn`
     target resolves;
   - **3-color-DFS cycle detection** (`findCycle`);
   - static template check: every `{{nodeX.*}}` reference points to a
     transitive ancestor (`transitiveAncestors` + `staticCheckTemplate`).
   - Returns structured error codes (`cycle_detected`, `duplicate_node_id`,
     `dependency_unresolved`, `too_many_nodes`, `unknown_runner`,
     `bad_template`) for surfacing in the approval UI.

2. **`resolveTemplate(s, parents)`** — from `template.go`. Substitutes
   `{{node<id>.output}}` (raw text) and `{{node<id>.fields.path}}` (walks the
   parent's parsed `fields` object). Unresolvable reference -> `bad_template`.

3. **`scheduler`** — extracted from `engine.go` minus OTel, Postgres store,
   pause/resume, and repair:
   - A node becomes `ready` when every `dependsOn` is `ok`.
   - Dispatch up to N concurrent (default 4, like `tasks`).
   - On node `error`: mark `error`, transitively mark dependents `skipped`,
     keep running independent branches.
   - On all-settled: `done` if no errors, else `failed`.
   - Cancellation cancels in-flight node runs via `executeCancelRun`.

### Node execution = existing layer

Each ready node calls `startSubtaskRun({ runner, model, prompt: resolved,
parentSessionId, parentCwd, depth: depth+1, onPeerEvent, ... })` from
`delegate.ts`. The returned `DelegateRunRecord` already yields `{status,
result}`.

For `fields`: when a node has an `outputSchema`, parse its result with the
**same JSON-fence + zod + `parseError` pattern as `consensus.ts`**
(`parseVerdict`). No `outputSchema` -> `fields` stays undefined and only
`{{nodeX.output}}` works for downstream nodes.

The orca `Dispatcher` interface maps onto `startSubtaskRun`; orca's
`pool_dispatcher.go` (distill event stream -> `NodeResult{status, output,
fields}`) is exactly what the delegate record already provides.

## Authoring + approval flow

1. `/workflow <goal>` — no planner flag in the current tool-authored flow.
2. Server runs **one authoring turn** on Claude with the workflow tools; the
   model assembles the DAG with `workflow_add_node` and proposes it with
   `workflow_run`.
   - Planner prompt instructs: decompose the goal into nodes, assign a runner
     per node, declare `dependsOn`, use `{{node<id>.output}}` to thread
     context, optionally declare `outputSchema` for nodes whose output feeds a
     structured field reference.
3. Result is pushed to the TUI as a `proposed` `WorkflowRun`. The user
   **approves** (transition to `running`, scheduler starts) or **rejects**
   (discard). Lifecycle and replay-on-reconnect mirror `consensus_ready`
   (`getConsensusReady`/`setConsensusReady`/`clearConsensusReady`).
4. While running, every state transition pushes a fresh snapshot to the TUI.

If the planner emits an invalid DAG, the validation error is surfaced in the
approval UI; the user can cancel (re-planning/repair is out of scope for v1).

## Node permissions

Nodes **inherit the session's current `claudeMode`** (`default` /
`acceptEdits` / `plan` / `bypassPermissions`). A workflow run in `acceptEdits`
auto-applies node edits; in `default` each editing node prompts. Consistent
with how the rest of the TUI gates tools.

**Open risk:** subtask/delegate runs today execute non-interactively
(`consensus` peers run `dontAsk` + read-only). If the delegate path does not
yet route `canUseTool` back to the client, then `default` mode with parallel
write-nodes cannot prompt cleanly. Mitigation for v1: write-workflows rely on
`acceptEdits`/`bypassPermissions`; interactive per-node permission prompting
(serialized through `PermissionPanel`) is a fast-follow. Confirm the delegate
permission routing during planning.

## Wire protocol

Unlike the `tasks` design (which avoided new message types and rode the
`tool_log.id` replace mechanism), a 2D DAG needs structured state, so we add
message types.

- `ClientMsg`:
  - `workflow_start { sessionId, goal, planner? }`
  - `workflow_approve { workflowId }`
  - `workflow_cancel { workflowId }`
- `ServerMsg`:
  - `workflow_state { run: WorkflowRun }` — full snapshot pushed on every
    transition; replayed on reconnect (like `consensus_ready`). A DAG is small;
    full-snapshot is simpler than per-node deltas and avoids ordering bugs.

Per-node streaming token output continues to flow through the existing peer
event plumbing (`onPeerEvent` -> `tool_log`) so the expanded panel can show a
node's live text; `workflow_state` carries only structural/status changes.

## TUI

- **Inline card** — `tui/src/components/tuicards/WorkflowCard.tsx`. Node list
  with `StatusDot` per node, updated in place. Follows existing `tuicards`
  conventions. Default surface.
- **Expand** — pressing `Tab` on the focused card opens
  `tui/src/components/WorkflowPanel.tsx`, an emergent panel rendering the DAG
  (dependency arrows + live per-node status), collapsing to a pill on
  completion. Ephemeral and command-scoped — explicitly NOT a persistent rail
  (the session rail was removed in 209ba3f for palette+pill; this departs
  deliberately because a DAG is 2D and does not fit a linear transcript).
- **Approval** — reuses the modal/notice pattern (`ConsensusModal` as model):
  shows the proposed nodes + edges, approve/reject.
- Client state added to `tui/src/state/sessions.ts` (current `WorkflowRun` per
  session, panel-expanded flag).

## File layout

New:
- `server/src/orchestrator/workflow.ts` — data model + validate + resolveTemplate + scheduler.
- `server/src/orchestrator/workflow-planner.ts` — planner turn + DAG parse.
- `tui/src/components/tuicards/WorkflowCard.tsx`
- `tui/src/components/WorkflowPanel.tsx`

Modified:
- `shared/events.ts` — `WorkflowNode`/`WorkflowRun`/status types + the three
  client msgs + `workflow_state` server msg.
- `server/src/index.ts` — dispatch `workflow_start`/`workflow_approve`/
  `workflow_cancel`; replay `workflow_state` on reconnect; clear on
  `/clear`/`delete_session`.
- `tui/src/state/sessions.ts` — workflow client state.
- `tui/src/util/slash.ts` (+ test) — `/workflow` grammar.
- `tui/src/app.tsx` — wire card/panel/approval into layout + `Tab` expand.

## Testing

Port orca's planner tests (thorough — `engine_test.go` alone is 771 lines)
against a **fake dispatcher** (port `fakeDispatcher` from `executor.go`):
- `workflow-validate.test.ts` — cycles, duplicate IDs, unknown runner,
  unresolved deps, bad templates (non-ancestor reference).
- `workflow-template.test.ts` — `{{output}}` and `{{fields.path}}`
  interpolation, missing-reference errors, nested field paths.
- `workflow.test.ts` — ready-set dispatch order, parallel cap enforced,
  skip-on-upstream-failure propagation, cancel cancels in-flight nodes,
  terminal status (`done` vs `failed`).
- `workflow-planner.test.ts` — DAG JSON parse + validation error surfacing.

This also closes a standing gap: the orchestrator is currently the
least-tested subsystem (only `collab.test.ts`), and the rest is manual smoke
scripts.

## Open questions to confirm during planning

1. Delegate permission routing (see Node permissions risk) — does
   `startSubtaskRun` support `canUseTool` callback to the client today?
2. Per-node session strategy: one fresh subtask session per node (default,
   matches `consensus`/`tasks`) vs. one shared session per (workflow, runner)
   to reduce session churn (orca's `CreateSession`-per-profile). v1 default:
   fresh per node; nodes communicate via field-passing, not session continuity.
3. Default `maxNodes` cap and per-workflow concurrency cap (proposed: 4
   concurrent, mirroring `tasks`).
