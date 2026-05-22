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
