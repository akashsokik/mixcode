# Orchestrator (Tasks / SubTasks) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add six MCP tools (`task_create`, `task_spawn`, `task_await`, `task_observe`, `task_done`, `task_cancel`) that let either runner (Claude or Codex) act as an Orchestrator agent driving an explicit Task -> SubTasks -> Async Execute -> Observe -> Done loop, with sub-tasks executing in parallel under a concurrency cap and the live tree rendering as a single in-place tool card in the TUI.

**Architecture:** Pure additive layer on top of the existing `delegate_run` infrastructure. Sub-task execution reuses `executeDelegate(..., wait:false)`. Task state lives in server memory keyed by sessionId. Tree updates ride on the existing `tool_log` event with a stable `id` so the TUI replaces the card in place. No `shared/events.ts` changes.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `nanoid`. Verification = `npm run typecheck` + WebSocket smoke scripts (no unit test framework in this repo).

**Reference docs:**
- `docs/plans/2026-05-22-orchestrator-design.md` — full design
- `server/src/runners/delegate.ts` — the lower layer this is built on
- `server/src/index.ts` — `/internal/delegate` and `runTurn`
- `server/src/mcp-codex-orchestrator.mjs` — stdio MCP child for Codex

**Conventions:**
- No emojis in code or commits (user CLAUDE.md rule).
- Commits per task. Match the existing terse style (`add task_spawn`, `wire orchestrator MCP into runTurn`, etc).
- Run `npm run typecheck` after every step that touches `.ts`/`.tsx`. It typechecks both workspaces.
- The repo is small; don't introduce a test framework. Use the existing `server/src/smoke-*.ts` pattern for end-to-end verification.

---

## Task 1: Scaffold `orchestrator/tasks.ts` with types and state

**Files:**
- Create: `server/src/orchestrator/tasks.ts`

**Step 1: Create the file with types and the in-memory state map**

```ts
// server/src/orchestrator/tasks.ts
//
// Task / SubTask layer that sits on top of delegate.ts. A Task groups
// several SubTasks (each a peer delegate_run) under a single visible
// tool card in the TUI. State lives in server memory keyed by sessionId;
// cleared on session clear / delete, gone on server restart.
import { nanoid } from "nanoid";
import type { RunEvent, RunnerKind } from "../../../shared/events.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "cancelled"
  | "error";

export type SubTaskStatus =
  | "queued"
  | "running"
  | "ok"
  | "error"
  | "cancelled"
  | "timeout";

export interface SubTask {
  id: string;
  taskId: string;
  runner: RunnerKind;
  prompt: string;
  sessionId?: string;
  status: SubTaskStatus;
  result?: string;
  error?: string;
  runId?: string;            // populated when execution starts
  lastDelta?: string;        // truncated, cleared on terminal status
  startedAt?: number;
  finishedAt?: number;
}

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  subtasks: SubTask[];
  summary?: string;
  startedAt: number;
  finishedAt?: number;
  toolLogId: string;
  maxConcurrent: number;
}

// sessionId -> taskId -> Task
const tasksBySession = new Map<string, Map<string, Task>>();

export function getTask(sessionId: string, taskId: string): Task | undefined {
  return tasksBySession.get(sessionId)?.get(taskId);
}

export function listTasks(sessionId: string): Task[] {
  return Array.from(tasksBySession.get(sessionId)?.values() ?? []);
}

export function registerTask(task: Task): void {
  let bySession = tasksBySession.get(task.sessionId);
  if (!bySession) {
    bySession = new Map();
    tasksBySession.set(task.sessionId, bySession);
  }
  bySession.set(task.id, task);
}

export function clearTasksForSession(sessionId: string): Task[] {
  const bySession = tasksBySession.get(sessionId);
  if (!bySession) return [];
  const tasks = Array.from(bySession.values());
  tasksBySession.delete(sessionId);
  return tasks;
}

export function newTaskId(): string {
  return nanoid();
}

export function newSubtaskId(): string {
  return nanoid();
}

// Truncate live delta previews so the snapshot stays small over the wire.
export const LAST_DELTA_MAX = 80;
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors; the file is referenced from nowhere yet).

**Step 3: Commit**

```bash
git add server/src/orchestrator/tasks.ts
git commit -m "scaffold orchestrator/tasks.ts types and state map"
```

---

## Task 2: Expose `startSubtaskRun` from delegate.ts

The existing `executeDelegate` reads peer callbacks from a session-scoped `parentCallbacks` map, which is set per-turn in `runTurn` to fold peer events into the parent's transcript. Sub-tasks need different callbacks (snapshot updates, not transcript folding). Rather than mutate the global map per sub-task, expose a private API that takes callbacks inline.

**Files:**
- Modify: `server/src/runners/delegate.ts:269-330` (add a new exported function near `executeDelegate`)

**Step 1: Add new export `startSubtaskRun`**

After the existing `executeDelegate` function, add:

```ts
// Subtask-aware run starter. Unlike executeDelegate, peer callbacks are
// passed inline (not looked up via parentCallbacks), so the Task layer can
// intercept events without disturbing the parent turn's transcript-folding
// forwardPeerEvent registered in runTurn. Always non-blocking — returns the
// record so the caller can wait on record.work itself.
//
// Skips the same-runner self-delegation check (Tasks intentionally allow
// Claude->Claude and Codex->Codex fan-out). Depth guard still applies.
export type StartSubtaskRunArgs = {
  runner: RunnerKind;
  prompt: string;
  sessionId?: string;
  parentRunner: RunnerKind;
  parentSessionId: string;
  parentCwd: string;
  depth: number;
  onPeerEvent?: (record: DelegateRunRecord, event: RunEvent) => void;
  onStatsChange?: (stats: DelegationStats) => void;
};

export function startSubtaskRun(
  args: StartSubtaskRunArgs,
): { ok: true; record: DelegateRunRecord } | { ok: false; error: string } {
  if (args.depth >= MAX_DEPTH) {
    return { ok: false, error: `delegation depth exceeded (max ${MAX_DEPTH})` };
  }
  const record = startRun(
    {
      runner: args.runner,
      prompt: args.prompt,
      sessionId: args.sessionId,
    },
    {
      parentRunner: args.parentRunner,
      parentSessionId: args.parentSessionId,
      parentCwd: args.parentCwd,
      depth: args.depth,
      onPeerEvent: args.onPeerEvent,
      onStatsChange: args.onStatsChange,
    },
  );
  return { ok: true, record };
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/runners/delegate.ts
git commit -m "expose startSubtaskRun for Task layer"
```

---

## Task 3: Implement `task_create` and the snapshot emitter

**Files:**
- Modify: `server/src/orchestrator/tasks.ts`

**Step 1: Add the snapshot emitter and `createTask`**

Append to `server/src/orchestrator/tasks.ts`:

```ts
// Single ToolLog snapshot for a Task. The TUI replaces the card in place
// whenever the server emits a tool_log with the same `id`, so we keep the
// id stable from the moment the task is created. The `name: "task"`
// sentinel lets TaskCard.tsx branch on output shape.
import type { ToolLog } from "../../../shared/events.js";

export type SubTaskSnapshot = {
  id: string;
  runner: RunnerKind;
  status: SubTaskStatus;
  prompt: string;
  durationMs?: number;
  result?: string;
  error?: string;
  lastDelta?: string;
};

export type TaskSnapshot = {
  taskId: string;
  status: TaskStatus;
  title: string;
  description?: string;
  summary?: string;
  counts: {
    running: number;
    ok: number;
    error: number;
    cancelled: number;
    queued: number;
    total: number;
  };
  subtasks: SubTaskSnapshot[];
};

export type EmitTaskFn = (event: RunEvent) => void;

const emitters = new Map<string, EmitTaskFn>();

export function registerTaskEmitter(sessionId: string, fn: EmitTaskFn): void {
  emitters.set(sessionId, fn);
}
export function unregisterTaskEmitter(sessionId: string): void {
  emitters.delete(sessionId);
}

function buildSnapshot(task: Task): TaskSnapshot {
  const counts = {
    running: 0,
    ok: 0,
    error: 0,
    cancelled: 0,
    queued: 0,
    total: task.subtasks.length,
  };
  const subtasks: SubTaskSnapshot[] = task.subtasks.map((s) => {
    switch (s.status) {
      case "queued":
        counts.queued += 1;
        break;
      case "running":
        counts.running += 1;
        break;
      case "ok":
        counts.ok += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      case "error":
      case "timeout":
        counts.error += 1;
        break;
    }
    const durationMs =
      s.startedAt != null
        ? (s.finishedAt ?? Date.now()) - s.startedAt
        : undefined;
    return {
      id: s.id,
      runner: s.runner,
      status: s.status,
      prompt: s.prompt,
      durationMs,
      ...(s.result ? { result: s.result } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.lastDelta ? { lastDelta: s.lastDelta } : {}),
    };
  });
  return {
    taskId: task.id,
    status: task.status,
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    counts,
    subtasks,
  };
}

export function emitTaskSnapshot(task: Task): void {
  const fn = emitters.get(task.sessionId);
  if (!fn) return;
  const log: ToolLog = {
    id: task.toolLogId,
    name: "task",
    input: {
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
    },
    output: buildSnapshot(task),
    isError: task.status === "error",
  };
  fn({ type: "tool_log", log });
}

export type CreateTaskArgs = {
  sessionId: string;
  title: string;
  description?: string;
};

export function createTask(args: CreateTaskArgs): Task {
  const task: Task = {
    id: newTaskId(),
    sessionId: args.sessionId,
    title: args.title,
    description: args.description,
    status: "pending",
    subtasks: [],
    startedAt: Date.now(),
    toolLogId: `task:${newTaskId()}`,
    maxConcurrent: 4,
  };
  registerTask(task);
  emitTaskSnapshot(task);
  return task;
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/orchestrator/tasks.ts
git commit -m "add task_create and snapshot emitter"
```

---

## Task 4: Implement `task_spawn` with concurrency cap

**Files:**
- Modify: `server/src/orchestrator/tasks.ts`

**Step 1: Add spawn + executor**

Append to `server/src/orchestrator/tasks.ts`:

```ts
import { startSubtaskRun } from "../runners/delegate.js";
import type { DelegateRunRecord } from "../runners/delegate.js";

export type SpawnSubtaskInput = {
  runner: RunnerKind;
  prompt: string;
  sessionId?: string;
};

export type SpawnContext = {
  parentRunner: RunnerKind;
  parentCwd: string;
  depth: number;
  timeoutSec: number;
};

export type SpawnResult =
  | { ok: true; subtaskIds: string[] }
  | { ok: false; error: string };

// Outstanding promise for the "currently in flight" set per Task. Awaiting it
// gives the caller a single point at which all current subtasks have settled.
const inflight = new Map<string, Set<Promise<void>>>();

function ensureInflight(taskId: string): Set<Promise<void>> {
  let set = inflight.get(taskId);
  if (!set) {
    set = new Set();
    inflight.set(taskId, set);
  }
  return set;
}

function buildSubtaskCallbacks(task: Task, sub: SubTask, timeoutSec: number) {
  // We wrap delegate's onPeerEvent to update the SubTask record and re-emit
  // a fresh task snapshot, but DO NOT forward peer events to the parent
  // turn's transcript. The orchestrator agent receives the consolidated
  // result via task_await's return JSON; the user sees the live tree via
  // the in-place tool card.
  const onPeerEvent = (_record: DelegateRunRecord, ev: RunEvent): void => {
    if (ev.type === "text_delta") {
      const next = (sub.lastDelta ?? "") + ev.delta;
      sub.lastDelta =
        next.length > LAST_DELTA_MAX
          ? "..." + next.slice(next.length - LAST_DELTA_MAX + 3)
          : next;
      scheduleSnapshot(task);
    } else if (ev.type === "error") {
      if (!sub.error) sub.error = ev.message;
      scheduleSnapshot(task);
    }
    // peer tool_log and thinking events: no card update, no transcript echo
  };
  return { onPeerEvent, timeoutSec };
}

export function spawnSubtasks(
  taskId: string,
  inputs: SpawnSubtaskInput[],
  ctx: SpawnContext,
  opts?: { maxConcurrent?: number },
): SpawnResult {
  const task = lookupTask(taskId);
  if (!task) return { ok: false, error: `unknown taskId: ${taskId}` };
  if (task.status === "done" || task.status === "cancelled") {
    return { ok: false, error: `task is ${task.status}` };
  }
  if (inputs.length === 0) {
    return { ok: false, error: "subtasks array is empty" };
  }
  if (opts?.maxConcurrent != null) task.maxConcurrent = opts.maxConcurrent;

  const fresh: SubTask[] = inputs.map((i) => ({
    id: newSubtaskId(),
    taskId,
    runner: i.runner,
    prompt: i.prompt,
    sessionId: i.sessionId,
    status: "queued",
  }));
  task.subtasks.push(...fresh);
  task.status = "running";

  // Pump the queue. Each settle of a running subtask re-pumps to fill up to
  // maxConcurrent.
  pumpQueue(task, ctx);
  emitTaskSnapshot(task);

  return { ok: true, subtaskIds: fresh.map((s) => s.id) };
}

function lookupTask(taskId: string): Task | undefined {
  for (const m of tasksBySession.values()) {
    const t = m.get(taskId);
    if (t) return t;
  }
  return undefined;
}

function runningCount(task: Task): number {
  let n = 0;
  for (const s of task.subtasks) if (s.status === "running") n += 1;
  return n;
}

function pumpQueue(task: Task, ctx: SpawnContext): void {
  while (runningCount(task) < task.maxConcurrent) {
    const next = task.subtasks.find((s) => s.status === "queued");
    if (!next) break;
    startOne(task, next, ctx);
  }
}

function startOne(task: Task, sub: SubTask, ctx: SpawnContext): void {
  const cb = buildSubtaskCallbacks(task, sub, ctx.timeoutSec);
  const started = startSubtaskRun({
    runner: sub.runner,
    prompt: sub.prompt,
    sessionId: sub.sessionId,
    parentRunner: ctx.parentRunner,
    parentSessionId: task.sessionId,
    parentCwd: ctx.parentCwd,
    depth: ctx.depth,
    onPeerEvent: cb.onPeerEvent,
  });
  if (!started.ok) {
    sub.status = "error";
    sub.error = started.error;
    sub.finishedAt = Date.now();
    emitTaskSnapshot(task);
    return;
  }
  sub.runId = started.record.runId;
  sub.startedAt = Date.now();
  sub.status = "running";
  emitTaskSnapshot(task);

  // Per-subtask timeout. Aborts the underlying delegate run; the work()
  // promise resolves shortly after with status "cancelled".
  const timeoutHandle = setTimeout(() => {
    if (started.record.status === "running") {
      started.record.abort.abort();
      started.record.status = "timeout";
    }
  }, ctx.timeoutSec * 1000);
  timeoutHandle.unref();

  const settled = started.record.work
    .then(() => {
      clearTimeout(timeoutHandle);
      // Mirror delegate's terminal status onto the SubTask.
      sub.status = mapDelegateStatus(started.record.status);
      sub.result = started.record.result;
      if (started.record.error) sub.error = started.record.error;
      sub.lastDelta = undefined;
      sub.finishedAt = Date.now();
      // Pump more queued subtasks now that a slot freed up.
      pumpQueue(task, ctx);
      // If everything settled and we never spawned more, mark task running
      // -> running (await transitions it) — handled in task_await.
      emitTaskSnapshot(task);
    })
    .catch((err) => {
      clearTimeout(timeoutHandle);
      sub.status = "error";
      sub.error = err instanceof Error ? err.message : String(err);
      sub.finishedAt = Date.now();
      pumpQueue(task, ctx);
      emitTaskSnapshot(task);
    });

  ensureInflight(task.id).add(settled);
  settled.finally(() => ensureInflight(task.id).delete(settled));
}

function mapDelegateStatus(
  s: DelegateRunRecord["status"],
): SubTaskStatus {
  if (s === "ok") return "ok";
  if (s === "cancelled") return "cancelled";
  if (s === "timeout") return "timeout";
  return "error";
}

// Snapshot throttler — coalesces ~10 emits/sec per task so 4 concurrently
// streaming peers don't flood the WebSocket.
const PENDING_SNAPSHOT_MS = 100;
const snapshotPending = new Map<string, NodeJS.Timeout>();

export function scheduleSnapshot(task: Task): void {
  if (snapshotPending.has(task.id)) return;
  const handle = setTimeout(() => {
    snapshotPending.delete(task.id);
    emitTaskSnapshot(task);
  }, PENDING_SNAPSHOT_MS);
  handle.unref();
  snapshotPending.set(task.id, handle);
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/orchestrator/tasks.ts
git commit -m "add task_spawn with concurrency cap and snapshot throttle"
```

---

## Task 5: Implement `task_await`

**Files:**
- Modify: `server/src/orchestrator/tasks.ts`

**Step 1: Add `awaitTask`**

Append:

```ts
export type AwaitTaskResult =
  | {
      ok: true;
      taskId: string;
      status: TaskStatus;
      subtasks: Array<{
        id: string;
        runner: RunnerKind;
        status: SubTaskStatus;
        result?: string;
        error?: string;
        durationMs?: number;
      }>;
      timedOut?: boolean;
    }
  | { ok: false; error: string };

export async function awaitTask(
  taskId: string,
  opts?: { timeoutSec?: number },
): Promise<AwaitTaskResult> {
  const task = lookupTask(taskId);
  if (!task) return { ok: false, error: `unknown taskId: ${taskId}` };

  const timeoutMs = (opts?.timeoutSec ?? 1200) * 1000;
  const TIMEOUT = Symbol("timeout");
  const deadline = new Promise<typeof TIMEOUT>((res) => {
    const h = setTimeout(() => res(TIMEOUT), timeoutMs);
    h.unref();
  });

  while (true) {
    const pending = ensureInflight(task.id);
    if (pending.size === 0) break;
    const snapshot = Array.from(pending);
    const next = await Promise.race([Promise.race(snapshot), deadline]);
    if (next === TIMEOUT) {
      return finalizeAwait(task, true);
    }
    // Loop — more subtasks may have been added by another concurrent
    // task_spawn while we were awaiting (rare, but legal).
  }
  return finalizeAwait(task, false);
}

function finalizeAwait(task: Task, timedOut: boolean): AwaitTaskResult {
  // The task's overall status mirrors its subtasks:
  // - all ok -> running (task_done is the only path to "done")
  // - any error/timeout -> error
  // - all cancelled -> cancelled
  let anyError = false;
  let anyRunning = false;
  let allCancelled = task.subtasks.length > 0;
  for (const s of task.subtasks) {
    if (s.status === "error" || s.status === "timeout") anyError = true;
    if (s.status === "running" || s.status === "queued") anyRunning = true;
    if (s.status !== "cancelled") allCancelled = false;
  }
  if (anyError) task.status = "error";
  else if (allCancelled) task.status = "cancelled";
  else if (!anyRunning) task.status = "running"; // ready for task_done
  emitTaskSnapshot(task);

  return {
    ok: true,
    taskId: task.id,
    status: task.status,
    timedOut: timedOut || undefined,
    subtasks: task.subtasks.map((s) => ({
      id: s.id,
      runner: s.runner,
      status: s.status,
      ...(s.result ? { result: s.result } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.startedAt != null
        ? { durationMs: (s.finishedAt ?? Date.now()) - s.startedAt }
        : {}),
    })),
  };
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/orchestrator/tasks.ts
git commit -m "add task_await with timeout"
```

---

## Task 6: Implement `task_observe`, `task_done`, `task_cancel`

**Files:**
- Modify: `server/src/orchestrator/tasks.ts`

**Step 1: Add the three terminal/inspection ops**

Append:

```ts
export type ObserveTaskResult =
  | { ok: true; snapshot: TaskSnapshot }
  | { ok: false; error: string };

export function observeTask(taskId: string): ObserveTaskResult {
  const task = lookupTask(taskId);
  if (!task) return { ok: false, error: `unknown taskId: ${taskId}` };
  return { ok: true, snapshot: buildSnapshot(task) };
}

export type DoneTaskResult =
  | { ok: true; taskId: string; status: "done" }
  | { ok: false; error: string };

export function doneTask(
  taskId: string,
  summary?: string,
): DoneTaskResult {
  const task = lookupTask(taskId);
  if (!task) return { ok: false, error: `unknown taskId: ${taskId}` };
  const stillRunning = task.subtasks.some(
    (s) => s.status === "running" || s.status === "queued",
  );
  if (stillRunning) {
    return {
      ok: false,
      error: "subtasks still running; await or cancel first",
    };
  }
  task.status = "done";
  task.summary = summary;
  task.finishedAt = Date.now();
  emitTaskSnapshot(task);
  return { ok: true, taskId: task.id, status: "done" };
}

export type CancelTaskResult =
  | { ok: true; taskId: string; cancelled: number }
  | { ok: false; error: string };

export function cancelTask(taskId: string): CancelTaskResult {
  const task = lookupTask(taskId);
  if (!task) return { ok: false, error: `unknown taskId: ${taskId}` };
  let cancelled = 0;
  for (const s of task.subtasks) {
    if (s.status === "queued") {
      s.status = "cancelled";
      cancelled += 1;
    } else if (s.status === "running" && s.runId) {
      // Reach into delegate's cancel path via the runId.
      executeCancelRun(s.runId);
      s.status = "cancelled";
      cancelled += 1;
    }
  }
  task.status = "cancelled";
  task.finishedAt = Date.now();
  emitTaskSnapshot(task);
  return { ok: true, taskId: task.id, cancelled };
}
```

**Step 2: Add the import for `executeCancelRun`**

At the top of `tasks.ts` change the delegate import to include it:

```ts
import {
  startSubtaskRun,
  executeCancelRun,
  type DelegateRunRecord,
} from "../runners/delegate.js";
```

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add server/src/orchestrator/tasks.ts
git commit -m "add task_observe, task_done, task_cancel"
```

---

## Task 7: Add cascade-cancel hook for session clear/delete

**Files:**
- Modify: `server/src/orchestrator/tasks.ts` (add a helper)
- Modify: `server/src/index.ts:217-229` (clear_session) and `server/src/index.ts:205-210` (delete_session)

**Step 1: Add `cancelTasksForSession` helper**

Append to `tasks.ts`:

```ts
// Bulk-cancel every running subtask of every task in a session. Called from
// clear_session and delete_session in index.ts so stale subtasks can't keep
// emitting snapshots into a cleared transcript.
export function cancelTasksForSession(sessionId: string): number {
  const bySession = tasksBySession.get(sessionId);
  if (!bySession) return 0;
  let n = 0;
  for (const task of bySession.values()) {
    if (task.status === "done" || task.status === "cancelled") continue;
    for (const s of task.subtasks) {
      if (s.status === "queued") {
        s.status = "cancelled";
        n += 1;
      } else if (s.status === "running" && s.runId) {
        executeCancelRun(s.runId);
        s.status = "cancelled";
        n += 1;
      }
    }
    task.status = "cancelled";
    task.finishedAt = Date.now();
  }
  // Note: snapshot emits skipped here — clearSession blows away the
  // transcript next anyway, and delete_session removes the session entirely.
  return n;
}
```

**Step 2: Wire into `index.ts`**

In `server/src/index.ts`, add to the imports near `cancelRunsForSession`:

```ts
import { cancelTasksForSession, clearTasksForSession } from "./orchestrator/tasks.js";
```

Update the `clear_session` handler (around line 217-229):

```ts
case "clear_session": {
  turnAborts.get(msg.sessionId)?.abort();
  turnAborts.delete(msg.sessionId);
  cancelRunsForSession(msg.sessionId);
  cancelTasksForSession(msg.sessionId);
  clearTasksForSession(msg.sessionId);
  clearDelegationStats(msg.sessionId);
  sessions.setDelegations(msg.sessionId, null);
  sessions.clearSession(msg.sessionId);
  return;
}
```

Update the `delete_session` handler (around line 205-210):

```ts
case "delete_session": {
  turnAborts.get(msg.sessionId)?.abort();
  turnAborts.delete(msg.sessionId);
  cancelTasksForSession(msg.sessionId);
  clearTasksForSession(msg.sessionId);
  sessions.delete(msg.sessionId);
  return;
}
```

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add server/src/orchestrator/tasks.ts server/src/index.ts
git commit -m "cascade-cancel tasks on session clear/delete"
```

---

## Task 8: Build the in-process MCP server (`orchestrator/mcp.ts`)

**Files:**
- Create: `server/src/orchestrator/mcp.ts`

**Step 1: Build the wrapper that adds task tools to the existing delegate tool set**

```ts
// server/src/orchestrator/mcp.ts
//
// In-process MCP server for Claude. Wraps the existing delegate tools
// (delegate_run / get_run / cancel_run) and adds the six task_* tools.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { RunnerKind } from "../../../shared/events.js";
import {
  registerParentCallbacks,
  unregisterParentCallbacks,
  executeDelegate,
  executeGetRun,
  executeCancelRun,
  type DelegateContext,
} from "../runners/delegate.js";
import {
  createTask,
  spawnSubtasks,
  awaitTask,
  observeTask,
  doneTask,
  cancelTask,
  registerTaskEmitter,
  unregisterTaskEmitter,
  type EmitTaskFn,
} from "./tasks.js";

function jsonContent(obj: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    isError,
  };
}

export type OrchestratorMcpContext = DelegateContext & {
  emitTask: EmitTaskFn;
};

export function buildOrchestratorMcpServer(ctx: OrchestratorMcpContext) {
  registerParentCallbacks(ctx.parentSessionId, {
    onPeerEvent: ctx.onPeerEvent,
    onStatsChange: ctx.onStatsChange,
  });
  registerTaskEmitter(ctx.parentSessionId, ctx.emitTask);

  const execCtx = {
    parentRunner: ctx.parentRunner,
    parentSessionId: ctx.parentSessionId,
    parentCwd: ctx.parentCwd,
    depth: ctx.depth,
  };

  return createSdkMcpServer({
    name: "orchestrator",
    version: "0.2.0",
    instructions:
      "Two ways to drive peer agents.\n" +
      "1) Ad-hoc one-offs: delegate_run / get_run / cancel_run.\n" +
      "2) Structured plan: task_create (one Task) -> task_spawn (parallel SubTasks) " +
      "-> task_await (block) or task_observe (peek) -> task_done. " +
      "Use the Task path when you want fan-out or want the user to see a live task tree.\n" +
      "Refer to tools by bare names (e.g. delegate_run, task_spawn).",
    tools: [
      tool(
        "delegate_run",
        "Spawn a peer agent (claude or codex) with a natural-language prompt.",
        {
          profileName: z.enum(["claude", "codex"]),
          prompt: z.string().min(1),
          sessionId: z.string().optional(),
          wait: z.boolean().default(true),
          timeoutSec: z.number().int().min(1).max(600).default(120),
        },
        async (input) => {
          const r = await executeDelegate(
            {
              profileName: input.profileName,
              prompt: input.prompt,
              sessionId: input.sessionId,
              wait: input.wait,
              timeoutSec: input.timeoutSec,
            },
            execCtx,
          );
          return jsonContent(r.payload, !r.ok);
        },
      ),
      tool(
        "get_run",
        "Fetch the current status (and result, if finished) of a peer run.",
        { runId: z.string() },
        async ({ runId }) => {
          const r = executeGetRun(runId);
          return jsonContent(r.payload, !r.ok);
        },
      ),
      tool(
        "cancel_run",
        "Cancel a peer run. No-op if it has already finished.",
        { runId: z.string() },
        async ({ runId }) => {
          const r = executeCancelRun(runId);
          return jsonContent(r.payload, !r.ok);
        },
      ),

      tool(
        "task_create",
        "Create a new Task. Returns a taskId you pass to task_spawn / task_await / task_done. " +
          "A Task is a named goal that groups parallel SubTasks under one live tool card.",
        {
          title: z.string().min(1),
          description: z.string().optional(),
        },
        async ({ title, description }) => {
          const task = createTask({
            sessionId: ctx.parentSessionId,
            title,
            description,
          });
          return jsonContent({ taskId: task.id });
        },
      ),

      tool(
        "task_spawn",
        "Append SubTasks to a Task and start them in parallel under maxConcurrent. " +
          "Non-blocking. Each SubTask is a peer run via the same machinery as delegate_run.",
        {
          taskId: z.string(),
          subtasks: z
            .array(
              z.object({
                runner: z.enum(["claude", "codex"]),
                prompt: z.string().min(1),
                sessionId: z.string().optional(),
              }),
            )
            .min(1),
          maxConcurrent: z.number().int().min(1).max(16).default(4),
          timeoutSec: z.number().int().min(1).max(3600).default(600),
        },
        async (input) => {
          const r = spawnSubtasks(
            input.taskId,
            input.subtasks as { runner: RunnerKind; prompt: string; sessionId?: string }[],
            {
              parentRunner: ctx.parentRunner,
              parentCwd: ctx.parentCwd,
              depth: ctx.depth + 1,
              timeoutSec: input.timeoutSec,
            },
            { maxConcurrent: input.maxConcurrent },
          );
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent({ subtaskIds: r.subtaskIds });
        },
      ),

      tool(
        "task_await",
        "Block this turn until every non-terminal SubTask of the Task settles. " +
          "Returns aggregated results.",
        {
          taskId: z.string(),
          timeoutSec: z.number().int().min(1).max(3600).default(1200),
        },
        async ({ taskId, timeoutSec }) => {
          const r = await awaitTask(taskId, { timeoutSec });
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent(r);
        },
      ),

      tool(
        "task_observe",
        "Non-blocking peek at a Task's current state and partial results.",
        { taskId: z.string() },
        async ({ taskId }) => {
          const r = observeTask(taskId);
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent({ snapshot: r.snapshot });
        },
      ),

      tool(
        "task_done",
        "Mark a Task done with an optional summary. Errors if any SubTask is still running.",
        {
          taskId: z.string(),
          summary: z.string().optional(),
        },
        async ({ taskId, summary }) => {
          const r = doneTask(taskId, summary);
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent({ taskId: r.taskId, status: r.status });
        },
      ),

      tool(
        "task_cancel",
        "Cancel a Task and abort all its running SubTasks.",
        { taskId: z.string() },
        async ({ taskId }) => {
          const r = cancelTask(taskId);
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent({ taskId: r.taskId, cancelled: r.cancelled });
        },
      ),
    ],
  });
}

export function teardownOrchestratorMcp(sessionId: string): void {
  unregisterParentCallbacks(sessionId);
  unregisterTaskEmitter(sessionId);
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/orchestrator/mcp.ts
git commit -m "add in-process orchestrator MCP with task_* tools"
```

---

## Task 9: Wire orchestrator MCP into the Claude `runTurn` branch

**Files:**
- Modify: `server/src/index.ts:380-410` (Claude branch)

**Step 1: Swap `buildDelegateMcpServer` for `buildOrchestratorMcpServer`**

Replace the import line:

```ts
import {
  buildDelegateMcpServer,
  cancelRunsForSession,
  // ...rest unchanged
} from "./runners/delegate.js";
```

with:

```ts
import {
  cancelRunsForSession,
  clearDelegationStats,
  executeCancelRun,
  executeDelegate,
  executeGetRun,
  registerParentCallbacks,
  unregisterParentCallbacks,
} from "./runners/delegate.js";
import {
  buildOrchestratorMcpServer,
  teardownOrchestratorMcp,
} from "./orchestrator/mcp.js";
```

In `runTurn`'s Claude branch (around line 393), replace:

```ts
const orchestrator = buildDelegateMcpServer({
  parentRunner: "claude",
  parentSessionId: sessionId,
  parentCwd: session.cwd,
  depth: 0,
  onPeerEvent: forwardPeerEvent,
  onStatsChange,
});
```

with:

```ts
const orchestrator = buildOrchestratorMcpServer({
  parentRunner: "claude",
  parentSessionId: sessionId,
  parentCwd: session.cwd,
  depth: 0,
  onPeerEvent: forwardPeerEvent,
  onStatsChange,
  emitTask: onEvent,   // task snapshot tool_logs land in the parent's assistant message
});
```

In the `finally` block (around line 494-496), replace `unregisterParentCallbacks(sessionId)` with:

```ts
teardownOrchestratorMcp(sessionId);
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "wire orchestrator MCP into Claude runTurn"
```

---

## Task 10: Extend `/internal/delegate` with `task_*` actions

**Files:**
- Modify: `server/src/index.ts:87-141` (the `/internal/delegate` handler)

**Step 1: Add task_* cases**

Inside the handler, after the existing `cancel_run` case and before the unknown-action fallthrough:

```ts
if (action === "task_create") {
  if (!body.parentSessionId) {
    return c.json({ ok: false, payload: { error: "missing parent context" } }, 400);
  }
  const task = createTask({
    sessionId: body.parentSessionId,
    title: String(args.title ?? ""),
    description:
      typeof args.description === "string" ? args.description : undefined,
  });
  return c.json({ ok: true, payload: { taskId: task.id } });
}
if (action === "task_spawn") {
  if (!body.parentRunner || !body.parentSessionId || !body.parentCwd) {
    return c.json({ ok: false, payload: { error: "missing parent context" } }, 400);
  }
  const subtasksIn = Array.isArray(args.subtasks) ? args.subtasks : [];
  const subtasks = subtasksIn.map((s: Record<string, unknown>) => ({
    runner: s.runner as RunnerKind,
    prompt: String(s.prompt ?? ""),
    sessionId: typeof s.sessionId === "string" ? s.sessionId : undefined,
  }));
  const r = spawnSubtasks(
    String(args.taskId ?? ""),
    subtasks,
    {
      parentRunner: body.parentRunner,
      parentCwd: body.parentCwd,
      depth: (typeof body.depth === "number" ? body.depth : 0) + 1,
      timeoutSec:
        typeof args.timeoutSec === "number" ? args.timeoutSec : 600,
    },
    {
      maxConcurrent:
        typeof args.maxConcurrent === "number" ? args.maxConcurrent : 4,
    },
  );
  if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
  return c.json({ ok: true, payload: { subtaskIds: r.subtaskIds } });
}
if (action === "task_await") {
  const r = await awaitTask(String(args.taskId ?? ""), {
    timeoutSec: typeof args.timeoutSec === "number" ? args.timeoutSec : 1200,
  });
  if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
  return c.json({ ok: true, payload: r });
}
if (action === "task_observe") {
  const r = observeTask(String(args.taskId ?? ""));
  if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
  return c.json({ ok: true, payload: { snapshot: r.snapshot } });
}
if (action === "task_done") {
  const r = doneTask(
    String(args.taskId ?? ""),
    typeof args.summary === "string" ? args.summary : undefined,
  );
  if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
  return c.json({ ok: true, payload: { taskId: r.taskId, status: r.status } });
}
if (action === "task_cancel") {
  const r = cancelTask(String(args.taskId ?? ""));
  if (!r.ok) return c.json({ ok: false, payload: { error: r.error } });
  return c.json({
    ok: true,
    payload: { taskId: r.taskId, cancelled: r.cancelled },
  });
}
```

**Step 2: Add the imports**

At the top of `index.ts` add:

```ts
import {
  awaitTask,
  cancelTask,
  createTask,
  doneTask,
  observeTask,
  spawnSubtasks,
} from "./orchestrator/tasks.js";
```

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "extend /internal/delegate with task_* actions"
```

---

## Task 11: Add `task_*` tools to the Codex stdio MCP child

**Files:**
- Modify: `server/src/mcp-codex-orchestrator.mjs`

**Step 1: Register 6 new tools**

At the bottom of the file, after `cancel_run` registration and before `await server.connect(transport)`:

```js
server.registerTool(
  "task_create",
  {
    description:
      "Create a new Task. Returns a taskId for task_spawn / task_await / task_done.",
    inputSchema: {
      title: z.string().min(1),
      description: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("task_create", input)),
);

server.registerTool(
  "task_spawn",
  {
    description:
      "Append SubTasks to a Task and start them in parallel under maxConcurrent. Non-blocking.",
    inputSchema: {
      taskId: z.string(),
      subtasks: z
        .array(
          z.object({
            runner: z.enum(["claude", "codex"]),
            prompt: z.string().min(1),
            sessionId: z.string().optional(),
          }),
        )
        .min(1),
      maxConcurrent: z.number().int().min(1).max(16).default(4),
      timeoutSec: z.number().int().min(1).max(3600).default(600),
    },
  },
  async (input) => jsonContent(await callServer("task_spawn", input)),
);

server.registerTool(
  "task_await",
  {
    description:
      "Block this turn until every non-terminal SubTask of the Task settles.",
    inputSchema: {
      taskId: z.string(),
      timeoutSec: z.number().int().min(1).max(3600).default(1200),
    },
  },
  async (input) => jsonContent(await callServer("task_await", input)),
);

server.registerTool(
  "task_observe",
  {
    description: "Non-blocking peek at a Task's current state.",
    inputSchema: { taskId: z.string() },
  },
  async (input) => jsonContent(await callServer("task_observe", input)),
);

server.registerTool(
  "task_done",
  {
    description: "Mark a Task done with an optional summary.",
    inputSchema: {
      taskId: z.string(),
      summary: z.string().optional(),
    },
  },
  async (input) => jsonContent(await callServer("task_done", input)),
);

server.registerTool(
  "task_cancel",
  {
    description: "Cancel a Task and abort its running SubTasks.",
    inputSchema: { taskId: z.string() },
  },
  async (input) => jsonContent(await callServer("task_cancel", input)),
);
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the .mjs file isn't typechecked, but server still picks it up at runtime — confirm by inspection).

**Step 3: Commit**

```bash
git add server/src/mcp-codex-orchestrator.mjs
git commit -m "add task_* tools to Codex stdio MCP child"
```

---

## Task 12: Wire orchestrator MCP into the Codex `runTurn` branch

The Codex stdio child needs to know its session's emitTask callback maps to the parent's `onEvent`. The HTTP path in Task 10 already calls `createTask({ sessionId: body.parentSessionId })`, which reads from `emitters.get(sessionId)`. We need to register that emitter at the start of every Codex turn.

**Files:**
- Modify: `server/src/index.ts` (Codex branch, around line 458-487)

**Step 1: Register the task emitter for Codex turns too**

Just before the `await runCodex({...})` call, add:

```ts
// Task tools for the Codex runner hit /internal/delegate which calls
// emitTaskSnapshot -> emitters.get(sessionId). Register onEvent under the
// same sessionId so snapshots land in the parent assistant message, same as
// the in-process Claude path.
registerTaskEmitter(sessionId, onEvent);
```

In the `finally` block (around line 494-496), also call:

```ts
unregisterTaskEmitter(sessionId);
```

(adjacent to the existing `teardownOrchestratorMcp` for the Claude path — note `teardownOrchestratorMcp` already calls `unregisterTaskEmitter`, so on the Claude path we do not double-unregister; only the Codex branch needs the explicit pair.)

**Step 2: Add the imports at the top of `index.ts`**

```ts
import {
  registerTaskEmitter,
  unregisterTaskEmitter,
} from "./orchestrator/tasks.js";
```

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "register task emitter on Codex turn entry"
```

---

## Task 13: Create `TaskCard.tsx` for the TUI

**Files:**
- Create: `tui/src/components/TaskCard.tsx`

**Step 1: Read the existing ToolCard to match its rendering primitives**

```bash
cat tui/src/components/ToolCard.tsx | head -80
```

Use the same `<box>`, `<text>` primitives and the same `theme` palette. Look at how `ToolCard` styles status colors — match that.

**Step 2: Write the card**

```tsx
// tui/src/components/TaskCard.tsx
import type { ToolLog } from "../../../shared/events.js";
import { theme } from "../theme.js";

type SubtaskSnap = {
  id: string;
  runner: "claude" | "codex";
  status:
    | "queued"
    | "running"
    | "ok"
    | "error"
    | "cancelled"
    | "timeout";
  prompt: string;
  durationMs?: number;
  result?: string;
  error?: string;
  lastDelta?: string;
};

type TaskSnap = {
  taskId: string;
  status: "pending" | "running" | "done" | "cancelled" | "error";
  title: string;
  description?: string;
  summary?: string;
  counts: {
    running: number;
    ok: number;
    error: number;
    cancelled: number;
    queued: number;
    total: number;
  };
  subtasks: SubtaskSnap[];
};

function statusColor(s: SubtaskSnap["status"]): string {
  if (s === "ok") return theme.success;
  if (s === "running") return theme.accent;
  if (s === "queued") return theme.dim;
  if (s === "cancelled") return theme.dim;
  return theme.error;
}

function dur(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "...";
}

export function TaskCard({ log }: { log: ToolLog }): JSX.Element {
  const snap = log.output as TaskSnap;
  const header =
    `[task] ${snap.title}  ` +
    `${snap.counts.ok}/${snap.counts.total} done  ` +
    `${snap.counts.running > 0 ? `${snap.counts.running} running  ` : ""}` +
    `${snap.counts.error > 0 ? `${snap.counts.error} err  ` : ""}`;
  return (
    <box flexDirection="column" border={true} borderColor={theme.dim}>
      <text bold>{header}</text>
      {snap.description ? (
        <text fg={theme.dim}>{snap.description}</text>
      ) : null}
      {snap.subtasks.map((s, idx) => {
        const last = idx === snap.subtasks.length - 1;
        const branch = last ? "`" : "|";
        const line =
          `${branch} [${s.runner}] ${truncate(s.prompt, 40)}  ` +
          `${s.status}` +
          `${s.durationMs != null ? `  ${dur(s.durationMs)}` : ""}`;
        return (
          <box key={s.id} flexDirection="column">
            <text fg={statusColor(s.status)}>{line}</text>
            {s.lastDelta && s.status === "running" ? (
              <text fg={theme.dim}>{`    "${truncate(s.lastDelta, 60)}"`}</text>
            ) : null}
            {s.error ? (
              <text fg={theme.error}>{`    ! ${truncate(s.error, 80)}`}</text>
            ) : null}
          </box>
        );
      })}
      {snap.summary && (snap.status === "done" || snap.status === "error") ? (
        <text fg={snap.status === "error" ? theme.error : theme.success}>
          {snap.summary}
        </text>
      ) : null}
    </box>
  );
}
```

**Step 3: Typecheck the TUI workspace**

Run: `cd tui && bun run typecheck`
Expected: PASS. If theme color keys differ from `success` / `accent` / `dim` / `error`, adjust to match the actual `theme` object exported from `tui/src/theme.ts`.

**Step 4: Commit**

```bash
git add tui/src/components/TaskCard.tsx
git commit -m "add TaskCard component"
```

---

## Task 14: Branch `ToolCard.tsx` on `name === "task"`

**Files:**
- Modify: `tui/src/components/ToolCard.tsx`

**Step 1: Add the branch**

Near the top of the existing `ToolCard` render, add a special case:

```tsx
import { TaskCard } from "./TaskCard.js";

// ...inside ToolCard component, before the generic render:
if (log.name === "task") {
  return <TaskCard log={log} />;
}
```

**Step 2: Typecheck**

Run: `cd tui && bun run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/components/ToolCard.tsx
git commit -m "branch ToolCard to TaskCard for name=task logs"
```

---

## Task 15: Write the end-to-end smoke script

**Files:**
- Create: `server/src/smoke-tasks.ts`

**Step 1: Copy the smoke-delegate.ts structure and adapt**

```ts
// End-to-end smoke for the Task orchestrator tools.
//   1. Connect to ws://127.0.0.1:4567/ws
//   2. Create a Claude session
//   3. Ask Claude to: task_create, task_spawn (two trivial Codex subtasks
//      in parallel), task_await, task_done
//   4. Verify a tool_log with name="task" arrives, transitions to done.
//
// Run with: npm --workspace server run dev   (in another terminal first)
//          npx tsx server/src/smoke-tasks.ts
import { WebSocket } from "ws";

const URL = "ws://127.0.0.1:4567/ws";
const CWD = process.env.SMOKE_CWD ?? process.cwd();
const TIMEOUT_MS = 180_000;

const PROMPT = [
  "Use the new task tools now. Steps in order:",
  "1) Call task_create with title='smoke fan-out'.",
  "2) Call task_spawn with the taskId and 2 subtasks:",
  "   - {runner:'codex', prompt:'Respond with only the word PING.'}",
  "   - {runner:'codex', prompt:'Respond with only the word PONG.'}",
  "   Use maxConcurrent=2, timeoutSec=60.",
  "3) Call task_await with the taskId, timeoutSec=120.",
  "4) Call task_done with the taskId and summary='ok'.",
  "5) Reply with just the two subtask results concatenated with a space.",
].join("\n");

type AnyMsg = Record<string, any>;
const ts = () => new Date().toISOString().slice(11, 23);
const log = (l: string, p?: unknown) =>
  p === undefined ? console.log(`[${ts()}] ${l}`) : console.log(`[${ts()}] ${l}`, p);

const ws = new WebSocket(URL);
let sessionId: string | null = null;
let sawTaskCard = false;
let sawDone = false;
let messageDone = false;

const hardTimeout = setTimeout(() => {
  log("HARD TIMEOUT", { sessionId, sawTaskCard, sawDone });
  ws.close();
  process.exit(2);
}, TIMEOUT_MS);

ws.on("open", () => log("ws open"));
ws.on("close", () => {
  clearTimeout(hardTimeout);
  process.exit(messageDone && sawTaskCard && sawDone ? 0 : 1);
});
ws.on("error", (e) => log("ws error", { msg: (e as Error).message }));

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as AnyMsg;
  switch (msg.type) {
    case "hello":
      ws.send(
        JSON.stringify({
          type: "create_session",
          title: "task smoke",
          runner: "claude",
          cwd: CWD,
        }),
      );
      break;
    case "session_updated":
      if (!sessionId && msg.session?.title === "task smoke") {
        sessionId = msg.session.id;
        log("session created", { sessionId });
        ws.send(JSON.stringify({ type: "send", sessionId, text: PROMPT }));
      }
      break;
    case "event":
      if (msg.event?.type === "tool_log" && msg.event.log?.name === "task") {
        sawTaskCard = true;
        const out = msg.event.log.output as { status: string; counts: any };
        log("task snapshot", {
          status: out.status,
          counts: out.counts,
        });
        if (out.status === "done") sawDone = true;
      }
      break;
    case "permission_request":
      ws.send(
        JSON.stringify({
          type: "permission_response",
          requestId: msg.request.requestId,
          decision: "allow_once",
        }),
      );
      break;
    case "message_done":
      if (msg.sessionId === sessionId) {
        messageDone = true;
        log("MESSAGE DONE", { sawTaskCard, sawDone });
        ws.send(JSON.stringify({ type: "delete_session", sessionId }));
        setTimeout(() => ws.close(), 500);
      }
      break;
  }
});
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add server/src/smoke-tasks.ts
git commit -m "add end-to-end task smoke script"
```

---

## Task 16: Run the smoke script end-to-end

This is the verification gate. Requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env`.

**Step 1: Start the server in one terminal**

Run: `npm --workspace server run dev`
Expected: `adverserial backend listening on http://127.0.0.1:4567`

**Step 2: Run the smoke in another terminal**

Run: `npx tsx server/src/smoke-tasks.ts`
Expected output: a sequence of `task snapshot` lines showing status transitions `pending` -> `running` -> `running` (subtasks ok one by one) -> `done`, followed by `MESSAGE DONE { sawTaskCard: true, sawDone: true }`, exit code 0.

If the smoke times out or exits non-zero: read the server's stderr, check the failing tool_log entries, and iterate on the relevant Task above. Do not mark this Task done unless exit code is 0.

**Step 3: Visual check in the TUI**

Run: `npm start`
Then in the prompt, ask: `"create a task with two parallel codex subtasks that each echo a different word, await them, then mark done"`.
Verify the task card appears and updates in place — does not duplicate, does not flood the transcript with peer events.

**Step 4: Commit any tweaks**

If any small fixes were needed during the run (color name mismatches, prompt phrasing for the LLM, etc.), commit them:

```bash
git add -A
git commit -m "smoke fixes for task orchestrator"
```

---

## Task 17: Update the README

**Files:**
- Modify: `README.md`

**Step 1: Add a short section under `How it works`**

After the existing "Per-session SDK continuity" line, add:

```markdown
6. Either runner can drive an explicit Task / SubTask loop via the
   orchestrator MCP tools: `task_create`, `task_spawn` (parallel fan-out),
   `task_await`, `task_observe`, `task_done`, `task_cancel`. SubTask
   execution reuses the same peer-run machinery as `delegate_run`. The
   live tree renders as a single inline `[task]` card that updates in
   place. Capped at 4 concurrent SubTasks per Task (configurable per call).
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "document task orchestrator tools in README"
```

---

## Verification matrix

| What | How |
|---|---|
| Types stay sound | `npm run typecheck` (after every code task) |
| Tools register correctly | smoke-tasks.ts sees `tool_log name=task` |
| Parallel fan-out works | two subtasks both reach `ok` status within timeout |
| Card updates in place | inspect TUI manually; no duplicate `[task]` cards |
| Cancel cascade | manually `/clear` mid-run; server log shows cancels, no orphan emits |
| Depth guard still active | spawn a task whose subtasks try to delegate further; depth>=3 returns the error |
| Same-runner allowed | smoke can be tweaked to use `runner:'claude'` from a Claude orchestrator and still pass |

## Out of scope (followups)

- `/tasks` TUI slash command listing outstanding tasks across sessions
- Persisted task history (transcript.ts integration)
- Task DAG dependencies
- Per-task token usage rollup in `DelegationStats`
- Re-running a single failed SubTask without recreating its parent Task
