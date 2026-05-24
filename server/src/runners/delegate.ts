// TS port of agent-orc/agent-runtime/runtime/toolkit/builtins/delegate.go.
// Exposes three tools as an in-process Claude SDK MCP server:
//   - delegate_run: spawn a peer agent (claude or codex) with a prompt
//   - get_run:     poll a previously spawned peer run
//   - cancel_run:  cancel a peer run
//
// There is no separate conductor service — peers are spawned in-process via
// runClaude / runCodex. Run state lives in a process-local Map; it does not
// survive a server restart, which is fine for a local-TUI use case.
//
// Two callers reach this module:
//
//   1. The Claude Agent SDK loads `buildDelegateMcpServer(ctx)` as an
//      in-process MCP server (the cheap path — same Node process).
//
//   2. Codex CLI is a separate process and only accepts stdio MCP servers.
//      We spawn `modules/mcp-codex-orchestrator.mjs` as that stdio child; it proxies
//      tool calls back to us via `POST /internal/delegate` on the Hono
//      server, which calls into `executeDelegate` / `executeGetRun` /
//      `executeCancelRun` below.
//
// Both transports share the same `runs` Map, `sessionStats` Map, and
// parent-callback registry so peer events and stats stay coherent regardless
// of which side originated the delegation.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { nanoid } from "nanoid";
import type {
  ClaudePermissionMode,
  DelegationStats,
  RunEvent,
  RunnerKind,
} from "../../../shared/events.js";
import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runVercel } from "./vercel.js";
import { executeValidate } from "./validate.js";
import {
  awaitTask,
  cancelTask,
  createTask,
  doneTask,
  observeTask,
  spawnSubtasks,
} from "../orchestrator/tasks.js";

const MAX_DEPTH = (() => {
  const v = process.env.AGENT_ORC_MAX_DELEGATION_DEPTH;
  if (!v) return 3;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

export type DelegateRunStatus = "running" | "ok" | "error" | "cancelled" | "timeout";

export type DelegateRunRecord = {
  runId: string;
  runner: RunnerKind;
  status: DelegateRunStatus;
  result: string;
  error?: string;
  sessionId?: string;
  // Parent session that spawned this run. Used to bulk-cancel peers when the
  // parent session is cleared.
  parentSessionId: string;
  abort: AbortController;
  startedAt: number;
  finishedAt?: number;
  work: Promise<void>;
};

const runs = new Map<string, DelegateRunRecord>();

// Per-parent-session aggregate stats. Survives across turns within the same
// session so the TUI can show "3 peers delegated this session" even when the
// parent isn't currently streaming.
const sessionStats = new Map<string, DelegationStats>();

const ZERO_STATS: DelegationStats = {
  total: 0,
  running: 0,
  ok: 0,
  error: 0,
  cancelled: 0,
};

// Callbacks supplied by the parent's runTurn. The HTTP path (Codex's stdio
// MCP child) looks these up by parentSessionId so peer events and stats land
// on the same assistant message / session as the in-process Claude path.
export type ParentCallbacks = {
  onPeerEvent?: (record: DelegateRunRecord, event: RunEvent) => void;
  onStatsChange?: (stats: DelegationStats) => void;
};
const parentCallbacks = new Map<string, ParentCallbacks>();

export function registerParentCallbacks(sessionId: string, cb: ParentCallbacks): void {
  parentCallbacks.set(sessionId, cb);
}
export function unregisterParentCallbacks(sessionId: string): void {
  parentCallbacks.delete(sessionId);
}

export function getRun(runId: string): DelegateRunRecord | undefined {
  return runs.get(runId);
}

export function getDelegationStats(sessionId: string): DelegationStats | null {
  return sessionStats.get(sessionId) ?? null;
}

export function clearDelegationStats(sessionId: string): void {
  sessionStats.delete(sessionId);
}

function bumpOnStart(sessionId: string, runner: RunnerKind): DelegationStats {
  const cur = sessionStats.get(sessionId) ?? ZERO_STATS;
  const next: DelegationStats = {
    ...cur,
    total: cur.total + 1,
    running: cur.running + 1,
    activePeer: runner,
  };
  sessionStats.set(sessionId, next);
  return next;
}

function bumpOnFinish(
  sessionId: string,
  status: DelegateRunStatus,
): DelegationStats | null {
  // If the parent session was cleared (or never tracked), don't resurrect a
  // stats entry from a late-arriving finish — return null so the caller's
  // optional onStatsChange callback gets a no-op signal.
  const cur = sessionStats.get(sessionId);
  if (!cur) return null;
  const next: DelegationStats = {
    ...cur,
    running: Math.max(0, cur.running - 1),
  };
  if (status === "ok") next.ok = cur.ok + 1;
  else if (status === "cancelled") next.cancelled = cur.cancelled + 1;
  else next.error = cur.error + 1; // includes "error" and "timeout"
  if (next.running === 0) delete next.activePeer;
  sessionStats.set(sessionId, next);
  return next;
}

export type DelegateContext = {
  parentRunner: RunnerKind;
  parentSessionId: string;
  parentCwd: string;
  depth: number;
  onPeerEvent?: (record: DelegateRunRecord, event: RunEvent) => void;
  onStatsChange?: (stats: DelegationStats) => void;
};

function startRun(
  args: {
    runner: RunnerKind;
    prompt: string;
    sessionId?: string;
    claudePermissionMode?: ClaudePermissionMode | "dontAsk";
    // Per-call turn budgets. Forwarded to the underlying runner when set.
    // Used by /consensus rounds to cap exploration; ignored for free-form
    // peer runs from delegate_run / validate_run.
    claudeMaxTurns?: number;
    claudeAllowedTools?: string[];
    vercelMaxSteps?: number;
  },
  ctx: DelegateContext,
): DelegateRunRecord {
  const abort = new AbortController();
  const record: DelegateRunRecord = {
    runId: nanoid(),
    runner: args.runner,
    status: "running",
    result: "",
    sessionId: args.sessionId,
    parentSessionId: ctx.parentSessionId,
    abort,
    startedAt: Date.now(),
    // assigned below
    work: Promise.resolve(),
  };

  const onEvent = (ev: RunEvent): void => {
    if (ev.type === "text_delta") record.result += ev.delta;
    if (ev.type === "error" && !record.error) record.error = ev.message;
    ctx.onPeerEvent?.(record, ev);
  };

  ctx.onStatsChange?.(bumpOnStart(ctx.parentSessionId, args.runner));

  record.work = (async () => {
    try {
      if (args.runner === "claude") {
        await runClaude({
          prompt: args.prompt,
          cwd: ctx.parentCwd,
          resumeId: args.sessionId,
          abortController: abort,
          permissionMode: args.claudePermissionMode,
          maxTurns: args.claudeMaxTurns,
          allowedTools: args.claudeAllowedTools,
          onEvent,
          onResumeId: (id) => {
            if (id) record.sessionId = id;
          },
        });
      } else if (args.runner === "codex") {
        await runCodex({
          prompt: args.prompt,
          cwd: ctx.parentCwd,
          threadId: args.sessionId,
          signal: abort.signal,
          onEvent,
          onThreadId: (id) => {
            if (id) record.sessionId = id;
          },
        });
      } else {
        // Vercel peers: no session resume (streamText is stateless and we
        // don't carry per-peer message state across delegate_run boundaries),
        // no PermissionStore (peer parent already gated). The peer runs in
        // its own ephemeral conversation.
        await runVercel({
          prompt: args.prompt,
          cwd: ctx.parentCwd,
          priorMessages: [],
          signal: abort.signal,
          sessionId: ctx.parentSessionId,
          permissionMode: "bypassPermissions",
          maxSteps: args.vercelMaxSteps,
          // Mark as peer-spawned so the runner skips orchestrator tools +
          // user MCP — peers can't fan out further or talk to user MCP
          // servers, matches the gate Claude uses for its peer runs.
          depth: Math.max(1, ctx.depth + 1),
          onEvent,
          onMessages: () => {
            // Discarded — peer messages don't outlive the run.
          },
        });
      }
      // Only transition out of "running" — the timeout / cancel_run paths set
      // status externally before record.work resolves, and we must not stomp
      // their terminal value.
      if (record.status === "running") {
        if (abort.signal.aborted) record.status = "cancelled";
        else record.status = record.error ? "error" : "ok";
      }
    } catch (err) {
      if (record.status === "running") record.status = "error";
      record.error = record.error ?? (err instanceof Error ? err.message : String(err));
    } finally {
      record.finishedAt = Date.now();
      const next = bumpOnFinish(ctx.parentSessionId, record.status);
      if (next) ctx.onStatsChange?.(next);
    }
  })();

  runs.set(record.runId, record);
  return record;
}

function summarize(r: DelegateRunRecord): Record<string, unknown> {
  return {
    runId: r.runId,
    runner: r.runner,
    sessionId: r.sessionId,
    status: r.status,
    // Only surface the final text when terminal — partial text is misleading
    // before the peer is done. Callers can poll get_run to see progress.
    ...(r.status === "ok" ? { result: r.result } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

// Pure-function result shape shared by both transports (in-process MCP and
// the HTTP endpoint). The MCP wrapper turns this into a CallToolResult; the
// HTTP wrapper turns it into a JSON response.
export type DelegateExecResult = {
  ok: boolean;
  payload: Record<string, unknown>;
};

export type DelegateExecArgs = {
  profileName: RunnerKind;
  prompt: string;
  sessionId?: string;
  wait: boolean;
  timeoutSec: number;
};

export type DelegateExecCtx = {
  parentRunner: RunnerKind;
  parentSessionId: string;
  parentCwd: string;
  depth: number;
};

// Look up the parent's callbacks (registered by runTurn for the duration of
// its turn) and merge them onto the exec context so peer events / stats fan
// out the same way regardless of which transport invoked us.
function contextFromExec(ctx: DelegateExecCtx): DelegateContext {
  const cb = parentCallbacks.get(ctx.parentSessionId);
  return {
    parentRunner: ctx.parentRunner,
    parentSessionId: ctx.parentSessionId,
    parentCwd: ctx.parentCwd,
    depth: ctx.depth,
    onPeerEvent: cb?.onPeerEvent,
    onStatsChange: cb?.onStatsChange,
  };
}

export async function executeDelegate(
  args: DelegateExecArgs,
  ctx: DelegateExecCtx,
): Promise<DelegateExecResult> {
  if (args.profileName === ctx.parentRunner) {
    return {
      ok: false,
      payload: { error: `cannot delegate to self (${ctx.parentRunner})` },
    };
  }
  if (ctx.depth >= MAX_DEPTH) {
    return {
      ok: false,
      payload: { error: `delegation depth exceeded (max ${MAX_DEPTH})` },
    };
  }

  const record = startRun(
    {
      runner: args.profileName,
      prompt: args.prompt,
      sessionId: args.sessionId,
    },
    contextFromExec(ctx),
  );

  if (!args.wait) {
    return {
      ok: true,
      payload: {
        runId: record.runId,
        runner: record.runner,
        sessionId: record.sessionId,
        status: "pending",
      },
    };
  }

  const TIMEOUT = Symbol("timeout");
  const deadline = new Promise<typeof TIMEOUT>((resolve) =>
    setTimeout(() => resolve(TIMEOUT), args.timeoutSec * 1000).unref(),
  );
  const outcome = await Promise.race([
    record.work.then(() => "done" as const),
    deadline,
  ]);
  if (outcome === TIMEOUT) {
    record.abort.abort();
    record.status = "timeout";
    return {
      ok: false,
      payload: {
        runId: record.runId,
        runner: record.runner,
        sessionId: record.sessionId,
        status: "timeout",
        error: "delegate_run wait timed out",
      },
    };
  }
  return { ok: record.status === "ok", payload: summarize(record) };
}

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
  // Forwarded to runClaude. Ignored when runner !== "claude". /consensus
  // uses "dontAsk" together with claudeAllowedTools to lock peers down to
  // read-only exploration; free-form delegations leave it unset.
  claudePermissionMode?: ClaudePermissionMode | "dontAsk";
  // Per-call turn budget for claude peers. /consensus sets a tight cap
  // (e.g. 5) so a peer can't burn 80 tool calls on one round.
  claudeMaxTurns?: number;
  // Whitelist of tool names the claude peer is allowed to invoke. Combined
  // with claudePermissionMode="dontAsk", anything else is silently denied.
  claudeAllowedTools?: string[];
  // Per-call step budget for vercel peers. Overrides the runtime's
  // VERCEL_MAX_STEPS default when set.
  vercelMaxSteps?: number;
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
      claudePermissionMode: args.claudePermissionMode,
      claudeMaxTurns: args.claudeMaxTurns,
      claudeAllowedTools: args.claudeAllowedTools,
      vercelMaxSteps: args.vercelMaxSteps,
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

export function executeGetRun(runId: string): DelegateExecResult {
  const r = runs.get(runId);
  if (!r) return { ok: false, payload: { error: "unknown runId" } };
  return { ok: true, payload: summarize(r) };
}

export function executeCancelRun(runId: string): DelegateExecResult {
  const r = runs.get(runId);
  if (!r) return { ok: false, payload: { error: "unknown runId" } };
  if (r.status === "running") {
    r.abort.abort();
    r.status = "cancelled";
  }
  return { ok: true, payload: { runId: r.runId, status: r.status } };
}

// Bulk-cancel every in-flight peer run spawned by the given parent session.
// Called from the /clear path so stale peers can't keep streaming events into
// a session whose conversation has been reset. Returns the number of runs we
// actively aborted (running -> cancelled); ignores already-terminal runs.
export function cancelRunsForSession(parentSessionId: string): number {
  let cancelled = 0;
  for (const r of runs.values()) {
    if (r.parentSessionId !== parentSessionId) continue;
    if (r.status !== "running") continue;
    r.status = "cancelled";
    r.abort.abort();
    cancelled += 1;
  }
  return cancelled;
}

function jsonContent(obj: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    isError,
  };
}

// In-process MCP server for the Claude SDK. Thin wrapper around the pure
// execute* functions above — zod-validates inputs, looks up parent callbacks
// via the closure's parentSessionId, and rewraps results into the SDK's
// CallToolResult shape.
export function buildDelegateMcpServer(ctx: DelegateContext) {
  // Register callbacks for the duration of the turn. We unregister in
  // runTurn's finally so the entry doesn't outlive the parent.
  registerParentCallbacks(ctx.parentSessionId, {
    onPeerEvent: ctx.onPeerEvent,
    onStatsChange: ctx.onStatsChange,
  });

  const execCtx: DelegateExecCtx = {
    parentRunner: ctx.parentRunner,
    parentSessionId: ctx.parentSessionId,
    parentCwd: ctx.parentCwd,
    depth: ctx.depth,
  };

  return createSdkMcpServer({
    name: "orchestrator",
    version: "0.1.0",
    instructions:
      "Delegate subtasks to a peer agent. Use `delegate_run` to spawn the peer (claude or codex) " +
      "with a natural-language prompt. By default it waits for completion and returns the peer's " +
      "final text. Use `get_run` to poll a previously-spawned run, and `cancel_run` to stop one. " +
      "Use `validate_run` as your FINAL step before declaring a task complete — it asks a peer " +
      "agent to adversarially review your work and returns a structured verdict (pass / fail / " +
      "needs_changes) you can act on. " +
      "For structured fan-out: `task_create` opens a Task, `task_spawn` starts parallel SubTasks " +
      "(each a peer run via the same machinery as delegate_run), `task_await` blocks until they " +
      "settle, `task_observe` peeks without blocking, `task_done` marks the Task complete, and " +
      "`task_cancel` aborts running SubTasks. Use the Task path when you want fan-out under a " +
      "single live tool card. When referring to these tools in your responses, use the " +
      "bare names (e.g. `delegate_run`, `validate_run`, `task_spawn`) — not the SDK's namespaced wire form.",
    tools: [
      tool(
        "delegate_run",
        "Spawn a peer agent (claude or codex) with a natural-language prompt. " +
          "By default waits for completion and returns the peer's final text. " +
          "Set wait=false to return immediately with a runId you can poll via get_run.",
        {
          profileName: z
            .enum(["claude", "codex", "vercel"])
            .describe("Which peer agent to spawn (the other one — cannot delegate to self)"),
          prompt: z.string().min(1).describe("Natural-language task for the peer agent"),
          sessionId: z
            .string()
            .optional()
            .describe("Resume a prior peer session/thread id; omit for a fresh one"),
          wait: z
            .boolean()
            .default(true)
            .describe("Wait for the peer to finish and return its result"),
          timeoutSec: z
            .number()
            .int()
            .min(1)
            .max(600)
            .default(120)
            .describe("If wait=true, max seconds to wait before returning a timeout error"),
        },
        async (input) => {
          const result = await executeDelegate(
            {
              profileName: input.profileName,
              prompt: input.prompt,
              sessionId: input.sessionId,
              wait: input.wait,
              timeoutSec: input.timeoutSec,
            },
            execCtx,
          );
          return jsonContent(result.payload, !result.ok);
        },
      ),
      tool(
        "get_run",
        "Fetch the current status (and result, if finished) of a peer run started with delegate_run.",
        { runId: z.string() },
        async ({ runId }) => {
          const r = executeGetRun(runId);
          return jsonContent(r.payload, !r.ok);
        },
      ),
      tool(
        "cancel_run",
        "Cancel a peer run started with delegate_run. No-op if it has already finished.",
        { runId: z.string() },
        async ({ runId }) => {
          const r = executeCancelRun(runId);
          return jsonContent(r.payload, !r.ok);
        },
      ),
      tool(
        "validate_run",
        "Adversarial peer review of your just-completed work. Call this as the FINAL step " +
          "before declaring a task done. A peer agent (default: the other runner) reads the " +
          "actual repo state, tries to find flaws in your claim, and returns a structured " +
          "verdict (pass / fail / needs_changes) plus an issues list. Treat fail and " +
          "needs_changes as work to do.",
        {
          peer: z
            .enum(["claude", "codex", "vercel"])
            .optional()
            .describe(
              "Which peer to use as the reviewer. Defaults to the other runner (the cross-pair). " +
                "Must differ from the active runner — self-validation is rejected.",
            ),
          claim: z
            .string()
            .min(1)
            .describe(
              "What you say you did. Be specific: what files you touched, what behavior should " +
                "now work, what edge cases you handled. The reviewer reads this and verifies it.",
            ),
          context: z
            .string()
            .optional()
            .describe(
              "Optional background the reviewer should know (constraints, prior decisions). " +
                "Capped at 4 KB server-side.",
            ),
          files: z
            .array(z.string())
            .max(20)
            .optional()
            .describe("Optional list of file paths the reviewer should focus on. Max 20."),
          focus: z
            .string()
            .optional()
            .describe(
              "Optional hint about what to scrutinize hardest (e.g. \"the error path in step 3\").",
            ),
          timeoutSec: z
            .number()
            .int()
            .min(1)
            .max(600)
            .default(180)
            .describe(
              "Max seconds to wait for the reviewer. Default 180 (higher than delegate_run; " +
                "reviewers read files).",
            ),
        },
        async (input) => {
          const result = await executeValidate(
            {
              peer: input.peer,
              claim: input.claim,
              context: input.context,
              files: input.files,
              focus: input.focus,
              timeoutSec: input.timeoutSec,
            },
            execCtx,
          );
          return jsonContent(result.payload, !result.ok);
        },
      ),
      tool(
        "task_create",
        "Open a new Task. Returns a taskId you pass to task_spawn / task_await / task_done. " +
          "A Task is a named goal that groups parallel SubTasks under a single live tool card.",
        {
          title: z.string().min(1).describe("Short human-readable goal, shown on the card"),
          description: z
            .string()
            .optional()
            .describe("Optional free-form notes about the Task"),
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
          "Non-blocking. Each SubTask is a peer agent run, same machinery as delegate_run. " +
          "Use task_await to block until they finish.",
        {
          taskId: z.string().describe("Task id returned by task_create"),
          subtasks: z
            .array(
              z.object({
                runner: z
                  .enum(["claude", "codex", "vercel"])
                  .describe("Which peer agent runs this SubTask"),
                prompt: z.string().min(1).describe("Natural-language task for the peer"),
                sessionId: z
                  .string()
                  .optional()
                  .describe("Resume an existing peer session/thread id; omit for fresh"),
              }),
            )
            .min(1)
            .describe("One or more SubTasks to fan out under this Task"),
          maxConcurrent: z
            .number()
            .int()
            .min(1)
            .max(16)
            .default(4)
            .describe("Max SubTasks of this Task running at once; the rest queue"),
          timeoutSec: z
            .number()
            .int()
            .min(1)
            .max(3600)
            .default(600)
            .describe("Per-SubTask timeout before its peer is aborted"),
        },
        async (input) => {
          const r = spawnSubtasks(
            input.taskId,
            input.subtasks as {
              runner: RunnerKind;
              prompt: string;
              sessionId?: string;
            }[],
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
        "Block until every non-terminal SubTask of the Task settles. Returns aggregated " +
          "results (each SubTask's final text + status).",
        {
          taskId: z.string(),
          timeoutSec: z
            .number()
            .int()
            .min(1)
            .max(3600)
            .default(1200)
            .describe("Max seconds to block before returning whatever has settled"),
        },
        async ({ taskId, timeoutSec }) => {
          const r = await awaitTask(taskId, { timeoutSec });
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent(r);
        },
      ),
      tool(
        "task_observe",
        "Non-blocking peek at a Task's current state and partial SubTask results.",
        { taskId: z.string() },
        async ({ taskId }) => {
          const r = observeTask(taskId);
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent({ snapshot: r.snapshot });
        },
      ),
      tool(
        "task_done",
        "Mark a Task complete with an optional summary. Errors if any SubTask is still " +
          "running — call task_await or task_cancel first.",
        {
          taskId: z.string(),
          summary: z
            .string()
            .optional()
            .describe("Optional summary shown on the final card"),
        },
        async ({ taskId, summary }) => {
          const r = doneTask(taskId, summary);
          if (!r.ok) return jsonContent({ error: r.error }, true);
          return jsonContent({ taskId: r.taskId, status: r.status });
        },
      ),
      tool(
        "task_cancel",
        "Cancel a Task and abort every running SubTask under it.",
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
