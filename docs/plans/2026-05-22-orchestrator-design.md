# Orchestrator (Tasks / SubTasks) Design

**Date:** 2026-05-22
**Status:** Approved (brainstorm), pending implementation plan
**Author:** brainstorm with akashswamy

## Goal

Add a higher-order orchestration layer on top of the existing `delegate_run` MCP tool. Either runner (Claude or Codex) can act as an Orchestrator that creates explicit **Tasks**, breaks them into parallel **SubTasks** (each itself a delegated peer run), awaits them, observes results, and marks them done. Both sides of the loop are interchangeable — the orchestrator can be Claude or Codex, and so can any sub-task.

The loop the orchestrator agent drives:

```
Task() -> SubTasks() -> Async Execute() -> Observe() -> Done
```

## Non-goals

- Persistent task state across server restarts. Tasks live in server memory, cleared on `/clear` and process exit (same as `delegate_run` records today).
- Recursive sub-task trees. SubTasks cannot create their own Tasks. Two-level only.
- Cross-session task graphs. Each task belongs to one session.
- DAG dependencies between sub-tasks of the same task. All siblings fan out in parallel.
- Replacing `delegate_run`. The ad-hoc one-off path stays as-is for callers that don't want the structuring overhead.

## Decisions captured during brainstorm

1. **Control loop** — one long orchestrator turn, paused on `task_await`. SDK turn-pause-on-tool-call model, composes naturally with how `delegate_run wait=true` works today.
2. **Tree shape** — Task with parallel SubTask siblings; no nesting. Concurrency capped per-task (default 4).
3. **TUI surface** — single inline tool card per Task in the transcript, updated in place via the existing `tool_log.id` replace mechanism. No new WebSocket message types.

## Architecture

```
                     +-------------------------------+
                     |  Orchestrator agent (turn)    |
                     |  (Claude or Codex)            |
                     +---------------+---------------+
                                     |
        task_create / task_spawn / task_await / task_observe / task_done / task_cancel
                                     |
              +----------------------+-----------------------+
              |                                              |
   in-process MCP (Claude SDK)                stdio MCP child (Codex)
   buildOrchestratorMcpServer(ctx)            mcp-codex-orchestrator.mjs
              |                                              |
              |                                  POST /internal/delegate { action: "task_*" }
              |                                              |
              +----------------------+-----------------------+
                                     v
                    +---------------------------------+
                    |  orchestrator/tasks.ts          |
                    |  - Map<sessionId, Map<taskId>>  |
                    |  - executeDelegate() per SubTask |
                    |  - snapshot emitter (tool_log)   |
                    +---------------------------------+
                                     |
                                     v
                       runners/delegate.ts (unchanged)
                       runClaude / runCodex peer SDK calls
```

Tasks are a structuring layer; sub-task execution literally calls into the existing `executeDelegate(..., {wait:false})`. Same `MAX_DEPTH=3` guard, same `DelegationStats`, same peer event plumbing.

## Data model

```ts
// server/src/orchestrator/tasks.ts

type TaskStatus = "pending" | "running" | "done" | "cancelled" | "error";
type SubTaskStatus = "queued" | "running" | "ok" | "error" | "cancelled" | "timeout";

interface Task {
  id: string;                        // nanoid
  sessionId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  subtasks: SubTask[];               // ordered, append-only
  summary?: string;                  // populated by task_done
  startedAt: number;
  finishedAt?: number;
  toolLogId: string;                 // stable id for in-place card updates
  maxConcurrent: number;             // captured at first spawn; default 4
}

interface SubTask {
  id: string;
  taskId: string;
  runner: "claude" | "codex";
  prompt: string;
  sessionId?: string;                // resume an existing peer thread
  status: SubTaskStatus;
  result?: string;                   // peer's final text
  error?: string;
  runId: string;                     // underlying DelegateRunRecord.runId
  lastDelta?: string;                // truncated to ~80 chars, cleared on terminal
  startedAt?: number;
  finishedAt?: number;
}

// In-memory state, parallel to the existing `runs` map in delegate.ts.
const tasksBySession: Map<string, Map<string, Task>>;
```

Lifetime: tied to the parent session. Cleared by:
- `clear_session` -> drop all Tasks for that session, cancel running SubTasks.
- `delete_session` -> same.
- Server restart -> all gone (in-memory only).

## Tool surface

Six tools on the same `orchestrator` MCP server. `delegate_run` / `get_run` / `cancel_run` remain for ad-hoc one-offs.

### `task_create`

```
input:  { title: string, description?: string }
output: { taskId: string }
```

Registers an empty Task, emits an initial `tool_log` so the card appears in the transcript immediately.

### `task_spawn`

```
input: {
  taskId: string,
  subtasks: [{
    runner: "claude" | "codex",
    prompt: string,
    sessionId?: string,
  }],
  maxConcurrent?: number,           // default 4, ignored on subsequent calls
  timeoutSec?: number,              // per-subtask, default 600
}
output: { subtaskIds: string[] }
```

Appends SubTasks under the Task and starts them under the concurrency cap. Non-blocking. Same-runner SubTasks are allowed (the `delegate_run` self-delegation check is relaxed here).

Validation errors: unknown taskId; Task is terminal (`done`/`cancelled`); empty subtasks array; subtask prompt empty.

### `task_await`

```
input:  { taskId: string, timeoutSec?: number }   // default 1200
output: {
  taskId,
  status,
  subtasks: [{ id, runner, status, result?, error?, durationMs }]
}
```

Blocks the orchestrator's turn until every non-terminal SubTask of the Task settles. Returns aggregated results. Idempotent — calling on a settled task returns immediately. On timeout: still resolves with whatever has settled; running SubTasks keep going (use `task_cancel` to stop them).

### `task_observe`

```
input:  { taskId: string }
output: same shape as task_await, but with partial state
        (running subtasks have empty result, may include lastDelta)
```

Non-blocking peek. Useful when the orchestrator has multiple Tasks in flight and wants to check one without committing to wait.

### `task_done`

```
input:  { taskId: string, summary?: string }
output: { taskId, status: "done" }
```

Marks the Task terminal with optional summary. Rejects if any SubTask is still running (orchestrator must await or cancel first). Card renders with the summary and final counts.

### `task_cancel`

```
input:  { taskId: string }
output: { taskId, cancelled: number }
```

Aborts every running SubTask, marks the Task `cancelled`. Idempotent.

## Wire protocol

**No changes to `shared/events.ts`.** Tasks ride on existing `tool_log` events:

```
tool_log: {
  id: <task.toolLogId>,             // same id every emit -> TUI replaces in place
  name: "task",                     // sentinel
  input: { title, description? },
  output: {
    taskId,
    status,
    summary?,
    counts: { running, ok, error, cancelled, queued, total },
    subtasks: [{
      id, runner, status, prompt,
      durationMs?, result?, error?,
      lastDelta?,
    }],
  },
  isError: status === "error",
}
```

Snapshot is re-emitted whenever the tree changes (create, spawn, subtask status change, subtask delta, await complete, done, cancel). **Throttled to ~10 emits/sec per task** so a fan-out of 4 streaming peers doesn't flood the WebSocket.

### Sub-task event interception

Today `delegate_run`'s `onPeerEvent` callback fans peer events (`text_delta`, peer `tool_log`, etc.) into the parent's transcript. For SubTasks we wrap that callback:

- `text_delta` -> update `subtask.lastDelta` (truncate ~80 chars), trigger snapshot re-emit.
- peer `tool_log` -> bump activity counter (optional), no separate card.
- terminal status -> set `subtask.status` + `result`/`error`, trigger snapshot.

Suppressed: individual peer events are not echoed as their own transcript entries. The orchestrator agent still receives the consolidated result via `task_await`'s return JSON. Clean structured data for the model, clean card for the human.

## TUI rendering

Two files change:

```
tui/src/components/TaskCard.tsx   (new)
tui/src/components/ToolCard.tsx   (one-line branch: if log.name === "task",
                                    render <TaskCard log={log} />)
```

`TaskCard` reads `tool_log.output` and renders:

```
[task] Refactor auth  3/4 done  21s
  | [codex]  audit middleware             ok  8s
  | [claude] rewrite session store        ok  12s
  | [claude] migrate token storage        running 21s  "writing migration..."
  ` [codex]  update unit tests             queued
```

Status colors reuse the existing theme: running = accent, ok = green, error = red, queued = dim, cancelled = strikethrough. On terminal status `lastDelta` is cleared; `summary` (if any) shows below the rows.

No new TUI state hooks. The TUI derives visible task state from the inline tool_log cards in the transcript, same way it derives every other tool call today.

## Server file layout

```
server/src/
  orchestrator/
    tasks.ts                  // Task/SubTask records, executor, snapshot emitter
    mcp.ts                    // 6 task_* tools (in-process Claude MCP)
  runners/
    delegate.ts               // unchanged for delegate_run; tasks.ts imports executeDelegate
  mcp-codex-orchestrator.mjs  // add 6 task_* tools, proxy to /internal/delegate
  index.ts                    // extend /internal/delegate switch to handle action: "task_*"
```

`buildOrchestratorMcpServer(ctx)` wraps the existing `buildDelegateMcpServer(ctx)` outputs and adds the 6 task tools, so callers register one MCP server for the whole orchestrator surface.

## Concurrency and safety

- **Per-Task cap:** `maxConcurrent` (default 4) gates how many SubTasks of one Task run at once; the rest queue. When one settles, the next dequeues.
- **Cross-Task / cross-session:** unbounded. Each SubTask is just a peer SDK invocation.
- **Depth guard:** existing `MAX_DEPTH=3` from `delegate.ts` still applies — a sub-task agent that spawned more delegates inside its own turn would hit it.
- **Self-delegation:** allowed inside Tasks (Claude orchestrator -> Claude SubTask). The depth guard is the only constraint.
- **Cancellation:** `task_cancel` aborts each SubTask's `AbortController` (reusing the existing `executeCancelRun` path). Session `/clear` and `delete_session` cascade-cancel running SubTasks via the existing `cancelRunsForSession` mechanism.

## Migration / rollout

- Pure additive. `delegate_run` semantics unchanged.
- No protocol change -> old TUI builds still work, just won't render Task cards specially (they'll show the JSON output as a generic tool card).
- No env flag gating — the new tools are always available; the orchestrator agent uses them when prompted to.

## Out of scope (followups)

- Persisted task history (would need transcript.ts integration).
- Task dependencies / DAGs.
- A `/tasks` slash command in the TUI to list outstanding tasks.
- Re-running a single failed SubTask without recreating the Task.
- Surfacing per-Task token usage in `DelegationStats` (we'd want a `taskStats` field on Session).

## Open questions

None blocking implementation. Resolved during brainstorm:

- Q: Where do task records live? **A:** Server memory, per-session map, cleared on `/clear`.
- Q: Can a SubTask spawn its own Task? **A:** No, two-level only.
- Q: Does `task_spawn` block? **A:** No, it returns immediately. Use `task_await` to block.
- Q: Are peer events streamed to the orchestrator's transcript? **A:** No, only the consolidated Task card snapshot is.
- Q: Same-runner sub-tasks allowed? **A:** Yes, depth guard still applies.

## Next step

Hand off to the `superpowers:writing-plans` skill to produce a step-by-step implementation plan.
