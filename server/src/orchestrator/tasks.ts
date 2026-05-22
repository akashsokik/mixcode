// server/src/orchestrator/tasks.ts
//
// Task / SubTask layer that sits on top of delegate.ts. A Task groups
// several SubTasks (each a peer delegate_run) under a single visible
// tool card in the TUI. State lives in server memory keyed by sessionId;
// cleared on session clear / delete, gone on server restart.
import { nanoid } from "nanoid";
import type { RunEvent, RunnerKind, ToolLog } from "../../../shared/events.js";
import { startSubtaskRun, executeCancelRun, type DelegateRunRecord } from "../runners/delegate.js";

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

const inflight = new Map<string, Set<Promise<void>>>();

function ensureInflight(taskId: string): Set<Promise<void>> {
  let set = inflight.get(taskId);
  if (!set) {
    set = new Set();
    inflight.set(taskId, set);
  }
  return set;
}

function buildSubtaskCallbacks(task: Task, sub: SubTask, _timeoutSec: number) {
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
  };
  return { onPeerEvent };
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
      sub.status = mapDelegateStatus(started.record.status);
      sub.result = started.record.result;
      if (started.record.error) sub.error = started.record.error;
      sub.lastDelta = undefined;
      sub.finishedAt = Date.now();
      pumpQueue(task, ctx);
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
  }
  return finalizeAwait(task, false);
}

function finalizeAwait(task: Task, timedOut: boolean): AwaitTaskResult {
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
  else if (!anyRunning) task.status = "running";
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
