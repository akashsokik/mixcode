# Agent Collaboration Design

Date: 2026-05-26
Status: Approved for implementation
Author: Codex with akashswamy

## Goal

Add a bounded collaboration workflow where the active harness can lead Claude and Codex through shared planning and phased execution.

The workflow:

```text
plan() -> execute(planId) -> phase loop -> finish
```

The active runner creates a repo-local plan artifact, starts execution from that plan, and coordinates with the peer runner through explicit collaboration messages. This fills the gap between `delegate_run` one-shot delegation, `task_*` fan-out, and `/consensus` single-pass actor/critic.

## Non-Goals

- Fully autonomous infinite agent chat.
- Persistent collaboration state across server restarts.
- Multi-user real-time collaboration.
- Replacing `delegate_run`, `task_*`, or `/consensus`.
- Letting peer agents modify files without the lead explicitly requesting that work in a bounded turn.

## Existing Context

Current primitives are close but not sufficient:

- `delegate_run`: parent sends one prompt to a peer and receives final text or a `runId`; live peer events stream to the transcript for the human, not as a two-way model channel.
- `task_*`: groups multiple peer runs under one task card and returns consolidated results through `task_await`; it deliberately suppresses detailed peer transcript events.
- `/consensus`: runs a single producer/critic cycle and then lets the user pick one implementer; it is intentionally not an execution loop.

The new collaboration layer should reuse `startSubtaskRun` and the existing runner adapters, but maintain its own plan, phase, message, and decision state.

## Design

### Plan Artifacts

`plan()` writes one shared repo-local markdown file under `docs/plans/`.

Example path:

```text
docs/plans/2026-05-26-agent-collab-<slug>.md
```

The file starts with a compact metadata block:

```yaml
planId: plan_<id>
owner: codex
participants:
  - codex
  - claude
status: planned
createdAt: 2026-05-26T00:00:00.000Z
```

The body contains:

- Goal
- Scope
- Phases
- Risks
- Verification
- Open questions, if any

Both runners read the same plan file. There are no separate Claude/Codex plan directories in v1 because shared repo-local state is easier to inspect, commit, and hand off.

### Collaboration State

State lives in server memory, keyed by session id.

```ts
type CollabRunStatus = "running" | "done" | "cancelled" | "error";
type PhaseStatus = "pending" | "running" | "blocked" | "done" | "cancelled";
type CollabMessageKind = "note" | "request" | "response" | "decision" | "phase_summary";

interface CollabRun {
  id: string;
  sessionId: string;
  planId: string;
  planPath: string;
  leadRunner: RunnerKind;
  peerRunner: RunnerKind;
  status: CollabRunStatus;
  phases: CollabPhase[];
  messages: CollabMessage[];
  decisions: CollabDecision[];
  toolLogId: string;
  startedAt: number;
  finishedAt?: number;
}

interface CollabPhase {
  id: string;
  title: string;
  status: PhaseStatus;
  owner: RunnerKind;
  summary?: string;
  startedAt?: number;
  finishedAt?: number;
}
```

This mirrors the existing `Task` model: in-memory state plus stable `tool_log.id` snapshots so the TUI can replace the card in place.

### Tool Surface

Expose the tools on the existing `orchestrator` MCP server for Claude and Codex. Vercel remains out of scope for v1 because the requested workflow is specifically Claude <-> Codex collaboration.

Initial v1 tools:

```text
plan_create
plan_read
collab_start
collab_send
collab_ask_peer
collab_observe
phase_start
phase_done
phase_handoff
collab_finish
collab_cancel
```

`plan_create` writes the markdown plan and returns `{ planId, path }`.

`collab_start` reads the plan file, creates a `CollabRun`, infers initial phases from the plan headings, and makes the active runner the lead.

`collab_send` appends a lead-authored note, decision, or phase summary to the shared run.

`collab_ask_peer` makes one bounded peer call through `startSubtaskRun`. The prompt includes:

- plan path and plan body
- current phase
- recent collaboration messages
- requested role: review, propose, verify, or implement slice

The peer response is appended to `messages`. The lead can then decide whether to accept it, ask again, start another phase, or finish.

`phase_handoff` changes the phase owner and optionally the run lead. This allows "active harness leads" by default, while still supporting an explicit Claude-to-Codex or Codex-to-Claude handoff.

### Execution Flow

```text
User asks active runner to plan
  -> active runner calls plan_create

User asks active runner to execute
  -> active runner calls collab_start
  -> active runner calls phase_start
  -> active runner edits files through normal runner tools
  -> active runner calls collab_ask_peer for review/proposal/verification
  -> active runner records a decision with collab_send
  -> active runner calls phase_done
  -> repeat for remaining phases
  -> active runner calls collab_finish
```

The peer never drives an unbounded loop. Every peer turn is explicitly requested by the lead and bounded by timeout and runner turn caps.

### TUI Surface

Use one live `collab` tool card, updated through existing `tool_log` events.

The card should show:

```text
collab  plan_<id>  lead=codex  peer=claude  running
  phase 1  codex   done      parse plan and inspect files
  phase 2  codex   running   implement server tools
  phase 3  claude  pending   review and verify
  messages: 5   decisions: 2
```

No new WebSocket message type is required for v1. The TUI can render a generic tool card first; a dedicated `CollabCard` can be added for better presentation.

## Safety

- Peer calls use `startSubtaskRun` so cancellation, depth guard, and runner adapters stay consistent.
- `collab_ask_peer` defaults to read/review prompts. Implementation prompts must be explicit.
- Each peer call has a timeout.
- Each collaboration run has an optional max peer-turn count to avoid runaway back-and-forth.
- `/clear`, session delete, and interrupt cancel in-flight peer runs and drop in-memory collab state.

## Testing

Server tests should cover:

- `plan_create` writes a markdown plan under `docs/plans/`.
- `collab_start` loads a plan and creates phases.
- `collab_send` appends messages and emits snapshots.
- `collab_ask_peer` records a peer response using a mock starter.
- `phase_start`, `phase_done`, and `phase_handoff` update phase state correctly.
- `collab_cancel` cancels in-flight peer work.

TUI tests should cover:

- `collab` tool logs render without crashing as generic tool cards.
- If a dedicated `CollabCard` is added, it handles long phase titles and empty message lists.

## Rollout

Implement in layers:

1. Add pure server-side plan and collaboration state helpers.
2. Add MCP tools for Claude in-process and Codex stdio proxy.
3. Wire `/internal/delegate` actions for Codex.
4. Emit `collab` snapshots as `tool_log`.
5. Add focused tests.
6. Optionally add a dedicated TUI card after the server workflow works.

## Open Decisions

None blocking for v1. The design intentionally chooses a shared repo-local plan file over runner-local plan directories.
