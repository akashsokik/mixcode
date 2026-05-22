// server/src/orchestrator/tasks.ts
//
// Task / SubTask layer that sits on top of delegate.ts. A Task groups
// several SubTasks (each a peer delegate_run) under a single visible
// tool card in the TUI. State lives in server memory keyed by sessionId;
// cleared on session clear / delete, gone on server restart.
import { nanoid } from "nanoid";
import type { RunEvent, RunnerKind, ToolLog } from "../../../shared/events.js";

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
