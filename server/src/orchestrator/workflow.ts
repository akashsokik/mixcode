// /workflow - model-authored DAG orchestration engine.
//
// In-memory model + validate (3-color-DFS cycle detection) + a ready-set
// scheduler (up to N concurrent, default 4, mirroring tasks.ts). On a node
// error the dependents are transitively skipped; the run finishes `done` if no
// node errored, else `failed`. Cancellation cancels in-flight node runs.
//
// Isolation contract: every node runs as a fresh, independent agent (the
// dispatcher never resumes a session or shares message history). The ONLY thing
// crossing a `dependsOn` edge is the upstream node's final output TEXT, which
// buildNodePrompt auto-injects into the dependent's prompt. No node ever sees
// another node's internal context. There is deliberately no template language
// ({{nodeX.output}} was removed) - dependencies are wired by structure, not by
// the model authoring fragile interpolation strings.
//
// The engine talks to nodes through an injectable `Dispatcher` boundary so the
// real implementation (which wraps `startSubtaskRun`/`executeCancelRun`) and
// the test fake share one shape.

import { nanoid } from "nanoid";
import type {
  RunEvent,
  RunnerKind,
  WorkflowNode,
  WorkflowRun,
} from "../../../shared/events.js";
import {
  startSubtaskRun,
  executeCancelRun,
  type DelegateRunRecord,
} from "../runners/delegate.js";
import { getDraft, draftToNodes } from "./workflow-draft.js";

// ----- per-session run store -----
//
// One active WorkflowRun per session, mirroring consensus.ts readyBySession.
// Cleared on /clear, delete_session, or process exit.

const runBySession = new Map<string, WorkflowRun>();

export function getWorkflowRun(sessionId: string): WorkflowRun | null {
  return runBySession.get(sessionId) ?? null;
}

export function setWorkflowRun(run: WorkflowRun): void {
  runBySession.set(run.sessionId, run);
}

export function clearWorkflowRun(sessionId: string): boolean {
  return runBySession.delete(sessionId);
}

// ----- validate -----

export type ValidateCode =
  | "too_many_nodes"
  | "duplicate_node_id"
  | "unknown_runner"
  | "dependency_unresolved"
  | "cycle_detected";

export type ValidateResult =
  | { ok: true }
  | { ok: false; code: ValidateCode; message: string };

export const DEFAULT_MAX_NODES = 24;

// Cap each node's captured output. Untruncated, a node that dumps file contents
// (an ollama "survey the repo" run produced a 22MB result) both bloats every
// workflow_state snapshot pushed over the WS and, once auto-injected into a
// downstream prompt, blows the model SDK's hard input limit (10485760 bytes) -
// failing the whole run. Downstream nodes need a digest, not a raw dump, so a
// generous-but-bounded cap is correct.
export const NODE_OUTPUT_MAX = 100_000;
export const NODE_CONTEXT_MAX = 200_000;
export const WORKFLOW_COMPLETION_CONTEXT_MAX = 80_000;

export function truncateOutput(s: string | undefined): string | undefined {
  if (s === undefined || s.length <= NODE_OUTPUT_MAX) return s;
  return `${s.slice(0, NODE_OUTPUT_MAX)}\n\n...[truncated ${s.length - NODE_OUTPUT_MAX} chars]...`;
}

export function isWorkflowActive(
  run: WorkflowRun | null | undefined,
): run is WorkflowRun & { status: "proposed" | "running" } {
  return run?.status === "proposed" || run?.status === "running";
}

// Total dispatch attempts per node before a TRANSIENT failure (dropped stream /
// connection reset, which ollama/vercel surface intermittently) is treated as a
// real error that skips dependents. 2 = one retry. Non-transient errors (bad
// output, timeouts) fail fast - retrying them just burns tokens.
export const NODE_MAX_ATTEMPTS = 2;

const TRANSIENT_ERROR_RE =
  /dropped upstream connection|stream ended|without a finish event|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network error|EAI_AGAIN|transport:/i;

function isTransientError(error: string | undefined): boolean {
  return error !== undefined && TRANSIENT_ERROR_RE.test(error);
}

// Order matters: each later check assumes the earlier ones passed (e.g.
// findCycle requires all dependsOn targets to resolve, which the
// dependency_unresolved check guarantees).
export function validate(
  run: WorkflowRun,
  knownRunners: ReadonlySet<RunnerKind>,
  maxNodes: number,
): ValidateResult {
  if (run.nodes.length > maxNodes) {
    return {
      ok: false,
      code: "too_many_nodes",
      message: `too_many_nodes: ${run.nodes.length} > ${maxNodes}`,
    };
  }

  const ids = new Map<string, number>();
  for (const n of run.nodes) {
    if (ids.has(n.id)) {
      return {
        ok: false,
        code: "duplicate_node_id",
        message: `duplicate_node_id: ${n.id}`,
      };
    }
    ids.set(n.id, 1);
    if (!knownRunners.has(n.runner)) {
      return {
        ok: false,
        code: "unknown_runner",
        message: `unknown_runner: ${n.runner}`,
      };
    }
  }

  for (const n of run.nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) {
        return {
          ok: false,
          code: "dependency_unresolved",
          message: `dependency_unresolved: ${n.id} -> ${dep}`,
        };
      }
    }
  }

  const cycle = findCycle(run.nodes);
  if (cycle) {
    return {
      ok: false,
      code: "cycle_detected",
      message: `cycle_detected: ${cycle.join(",")}`,
    };
  }

  return { ok: true };
}

// 3-color DFS. Returns the cycle node ids, or null. Missing color keys default
// to WHITE, missing parent keys to "" (no parent) - the Go original leaned on
// map zero-values; TS must default explicitly.
export function findCycle(nodes: WorkflowNode[]): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, [...(n.dependsOn ?? [])]);

  let cycle: string[] | null = null;
  const dfs = (start: string): boolean => {
    color.set(start, GREY);
    for (const v of adj.get(start) ?? []) {
      if ((color.get(v) ?? WHITE) === GREY) {
        // reconstruct [v, u, parent(u), ... up to v]
        let u = start;
        cycle = [v, u];
        while ((parent.get(u) ?? "") !== "" && parent.get(u) !== v) {
          u = parent.get(u) as string;
          cycle.push(u);
        }
        return true;
      }
      if ((color.get(v) ?? WHITE) === WHITE) {
        parent.set(v, start);
        if (dfs(v)) return true;
      }
    }
    color.set(start, BLACK);
    return false;
  };

  for (const n of nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) {
      if (dfs(n.id)) return cycle;
    }
  }
  return null;
}

// ----- upstream output injection -----

// Build the effective prompt for a node about to dispatch. The node's authored
// `prompt` is self-contained; we append a "Context from upstream steps" section
// carrying each direct dependency's final output text. This is the SOLE channel
// between nodes - no session, thread, or message history is ever shared, so each
// node still runs as a fully isolated agent that simply received some text. The
// static graph guarantees a dependency has already settled `ok` (readyNodes only
// dispatches a node once every dep is ok), so its `output` is populated.
export function buildNodePrompt(
  node: WorkflowNode,
  byId: Map<string, WorkflowNode>,
): string {
  const deps = (node.dependsOn ?? [])
    .map((d) => byId.get(d))
    .filter((p): p is WorkflowNode => p !== undefined && p.output !== undefined);
  if (deps.length === 0) return node.prompt;

  const rawBlocks = deps
    .map((p) => `## Output from upstream step "${p.title}" (id: ${p.id})\n\n${p.output}`)
    .join("\n\n");
  const blocks = capContext(rawBlocks, NODE_CONTEXT_MAX);
  return (
    `${node.prompt}\n\n` +
    `---\n` +
    `Context from upstream steps below. These are the FINAL outputs of steps you ` +
    `depend on - you did not share their context, so treat this as all you know ` +
    `from them.\n\n` +
    blocks
  );
}

function capContext(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const marker = `\n\n...[workflow context truncated ${s.length - maxChars} chars]...`;
  const keep = Math.max(0, maxChars - marker.length);
  return `${s.slice(0, keep)}${marker}`;
}

// Build the compact handoff Agent 1 receives after a detached workflow
// completes. This deliberately uses only terminal DAG nodes (nodes with no
// dependents), so a fan-out/fan-in graph hands back the synthesis node instead
// of bulk-loading every intermediate branch into the parent agent's context.
export function buildWorkflowCompletionContext(run: WorkflowRun): string | null {
  if (!isTerminalWorkflowStatus(run.status)) return null;

  const dependents = new Set<string>();
  for (const n of run.nodes) {
    for (const dep of n.dependsOn ?? []) dependents.add(dep);
  }

  const terminalOutputs = run.nodes.filter(
    (n) => !dependents.has(n.id) && n.status === "ok" && hasText(n.output),
  );

  const lines: string[] = [
    `Workflow ${workflowStatusLabel(run.status)}.`,
    `Goal: ${run.goal}`,
    `Workflow id: ${run.id}`,
  ];

  if (terminalOutputs.length > 0) {
    lines.push("", terminalOutputs.length === 1 ? "Terminal result:" : "Terminal results:");
    for (const n of terminalOutputs) {
      lines.push("", `## ${n.title} (${n.id})`, n.output!.trim());
    }
  } else {
    const completed = run.nodes.filter((n) => n.status === "ok");
    const failed = run.nodes.filter((n) => n.status === "error");
    const skipped = run.nodes.filter(
      (n) => n.status === "skipped" || n.status === "cancelled",
    );
    if (completed.length > 0) {
      lines.push("", "Completed steps:");
      for (const n of completed) lines.push(`- ${n.title} (${n.id})`);
    }
    if (failed.length > 0) {
      lines.push("", "Failed steps:");
      for (const n of failed) {
        lines.push(`- ${n.title} (${n.id})${n.error ? `: ${n.error}` : ""}`);
      }
    }
    if (skipped.length > 0) {
      lines.push("", "Skipped or cancelled steps:");
      for (const n of skipped) lines.push(`- ${n.title} (${n.id})`);
    }
  }

  return capContext(lines.join("\n"), WORKFLOW_COMPLETION_CONTEXT_MAX);
}

export function withWorkflowCompletionContext(
  userText: string,
  context: string | null | undefined,
): string {
  const trimmed = context?.trim();
  if (!trimmed) return userText;
  return (
    `Context from the most recent completed workflow:\n\n` +
    `${trimmed}\n\n` +
    `---\n` +
    `User message:\n${userText}`
  );
}

function hasText(s: string | undefined): boolean {
  return s !== undefined && s.trim().length > 0;
}

function isTerminalWorkflowStatus(status: WorkflowRun["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function workflowStatusLabel(status: WorkflowRun["status"]): string {
  if (status === "done") return "completed";
  return status;
}

// ----- dispatcher boundary -----

export type DispatchReq = {
  nodeId: string;
  runner: RunnerKind;
  model?: string;
  prompt: string;
};

export type NodeResult = {
  status: "ok" | "error" | "cancelled";
  output?: string;
  error?: string;
};

export type DispatchHandle = {
  runId: string;
  // resolves exactly once: ok | error | cancelled
  done: Promise<NodeResult>;
};

export type Dispatcher = {
  dispatch(req: DispatchReq): DispatchHandle;
  cancel(runId: string): void;
};

// ----- real dispatcher -----

export type RealDispatcherContext = {
  parentRunner: RunnerKind;
  parentSessionId: string;
  parentCwd: string;
  depth: number;
  timeoutSec: number;
  onPeerEvent?: (record: DelegateRunRecord, event: RunEvent) => void;
};

// Wraps startSubtaskRun/executeCancelRun. Not exercised by the unit tests (the
// fake dispatcher stands in); typecheck is the only gate here.
export function createRealDispatcher(ctx: RealDispatcherContext): Dispatcher {
  return {
    dispatch(req: DispatchReq): DispatchHandle {
      const started = startSubtaskRun({
        runner: req.runner,
        model: req.model,
        prompt: req.prompt,
        parentRunner: ctx.parentRunner,
        parentSessionId: ctx.parentSessionId,
        parentCwd: ctx.parentCwd,
        depth: ctx.depth + 1,
        onPeerEvent: ctx.onPeerEvent,
      });
      if (!started.ok) {
        return {
          runId: "",
          done: Promise.resolve({ status: "error", error: started.error }),
        };
      }
      const record = started.record;

      const timeoutHandle = setTimeout(() => {
        if (record.status === "running") {
          record.abort.abort();
          record.status = "timeout";
        }
      }, ctx.timeoutSec * 1000);
      timeoutHandle.unref();

      const done = record.work
        .then((): NodeResult => {
          clearTimeout(timeoutHandle);
          const status = mapDelegateStatus(record.status);
          // Read record.result directly (not summarize, which suppresses
          // result unless status === "ok") so error/timeout nodes still expose
          // partial text. Bound the free-text output (see NODE_OUTPUT_MAX).
          const output = truncateOutput(record.result);
          const base: NodeResult = { status, output };
          if (record.error) base.error = record.error;
          return base;
        })
        .catch((err): NodeResult => {
          clearTimeout(timeoutHandle);
          return {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        });

      return { runId: record.runId, done };
    },
    cancel(runId: string): void {
      if (runId) executeCancelRun(runId);
    },
  };
}

// DelegateRunStatus -> NodeResult.status. The workflow NodeStatus enum has no
// "timeout", so timeout collapses into "error".
function mapDelegateStatus(
  s: DelegateRunRecord["status"],
): NodeResult["status"] {
  if (s === "ok") return "ok";
  if (s === "cancelled") return "cancelled";
  return "error"; // error | timeout | running(should not happen post-settle)
}

// ----- run factory -----

export function newWorkflowRun(args: {
  sessionId: string;
  goal: string;
  planner: RunnerKind;
  nodes: WorkflowNode[];
}): WorkflowRun {
  return {
    id: nanoid(),
    sessionId: args.sessionId,
    goal: args.goal,
    planner: args.planner,
    status: "proposed",
    nodes: args.nodes,
    createdAt: Date.now(),
  };
}

// Snapshot the session's accumulated draft (workflow_add_node nodes) into a
// validated `proposed` WorkflowRun. This is the whole body of the workflow_run
// tool minus the side effects (clearing the draft + broadcasting), pulled out so
// it can be exercised without the SDK tool harness. Does NOT mutate the draft.
export function proposeFromDraft(args: {
  sessionId: string;
  goal: string;
  planner: RunnerKind;
  knownRunners: ReadonlySet<RunnerKind>;
  maxNodes?: number;
}): { ok: true; run: WorkflowRun } | { ok: false; error: string } {
  const draft = getDraft(args.sessionId);
  if (draft.length === 0) {
    return { ok: false, error: "no nodes in draft - call workflow_add_node first" };
  }
  const run = newWorkflowRun({
    sessionId: args.sessionId,
    goal: args.goal,
    planner: args.planner,
    nodes: draftToNodes(draft),
  });
  const v = validate(run, args.knownRunners, args.maxNodes ?? DEFAULT_MAX_NODES);
  if (!v.ok) return { ok: false, error: `${v.code}: ${v.message}` };
  return { ok: true, run };
}

// ----- scheduler -----
//
// Synthesized from the spec ready-set semantics (NOT a faithful port of
// engine.go's repair-pausing run loop). Keeps only the ready predicate (all
// deps ok) and the terminal-status rule (any error -> failed, else done).

export const MAX_CONCURRENT = 4;

export type WorkflowController = {
  // resolves when the run reaches a terminal status
  done: Promise<void>;
  // flips running/pending/ready nodes to cancelled/skipped and cancels
  // in-flight runs; the run settles cancelled
  cancel(): void;
};

export function runWorkflow(
  run: WorkflowRun,
  disp: Dispatcher,
  emit: (run: WorkflowRun) => void,
  opts?: { maxConcurrent?: number },
): WorkflowController {
  const cap = opts?.maxConcurrent ?? MAX_CONCURRENT;
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const inflight = new Map<string, Promise<void>>();
  let cancelled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  run.status = "running";
  run.startedAt = Date.now();
  for (const n of run.nodes) {
    if (n.status !== "pending" && n.status !== "ready") n.status = "pending";
  }

  const readyNodes = (): WorkflowNode[] =>
    run.nodes.filter(
      (n) =>
        (n.status === "pending" || n.status === "ready") &&
        (n.dependsOn ?? []).every((d) => byId.get(d)?.status === "ok"),
    );

  // Transitively mark any pending node whose dependency errored/was
  // skipped/cancelled as skipped. Run to a fixpoint so a chain A -> B -> C all
  // skips when A fails.
  const propagateSkips = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of run.nodes) {
        if (n.status !== "pending" && n.status !== "ready") continue;
        const blocked = (n.dependsOn ?? []).some((d) => {
          const s = byId.get(d)?.status;
          return s === "error" || s === "skipped" || s === "cancelled";
        });
        if (blocked) {
          n.status = "skipped";
          n.finishedAt = Date.now();
          changed = true;
        }
      }
    }
  };

  const settleRun = (): void => {
    if (run.status === "cancelled") {
      run.finishedAt = Date.now();
      emit(run);
      resolveDone();
      return;
    }
    const anyError = run.nodes.some((n) => n.status === "error");
    run.status = anyError ? "failed" : "done";
    run.finishedAt = Date.now();
    emit(run);
    resolveDone();
  };

  const startNode = (n: WorkflowNode): void => {
    // The only inter-node channel: prepend each dependency's final output text
    // to this node's self-contained prompt. No shared session/context (see
    // buildNodePrompt). readyNodes guarantees every dep settled `ok` first.
    const prompt = buildNodePrompt(n, byId);

    n.status = "running";
    n.startedAt = Date.now();
    n.attempt += 1;
    const handle = disp.dispatch({
      nodeId: n.id,
      runner: n.runner,
      model: n.model,
      prompt,
    });
    n.runId = handle.runId;
    emit(run);

    const settle = handle.done.then((res) => {
      // A cancel may have already flipped this node; don't stomp it.
      if (n.status === "running") {
        // Retry transient transport failures instead of failing the node and
        // skipping its dependents. attempt was already bumped in startNode, so
        // the cap bounds total tries; re-queue by flipping back to "ready" for
        // the next pump (deps stayed "ok", so readyNodes picks it up).
        if (
          !cancelled &&
          res.status === "error" &&
          isTransientError(res.error) &&
          n.attempt < NODE_MAX_ATTEMPTS
        ) {
          n.status = "ready";
          n.runId = undefined;
          inflight.delete(n.id);
          emit(run);
          pump();
          return;
        }
        n.status = res.status;
        if (res.output !== undefined) n.output = res.output;
        if (res.error !== undefined) n.error = res.error;
        n.finishedAt = Date.now();
      }
      inflight.delete(n.id);
      if (!cancelled) {
        propagateSkips();
        pump();
      }
      emit(run);
      if (!cancelled && inflight.size === 0 && readyNodes().length === 0) {
        settleRun();
      }
    });
    inflight.set(n.id, settle);
  };

  const pump = (): void => {
    while (inflight.size < cap) {
      const next = readyNodes()[0];
      if (!next) break;
      startNode(next);
    }
  };

  const cancel = (): void => {
    if (cancelled || run.status === "done" || run.status === "failed") return;
    cancelled = true;
    for (const n of run.nodes) {
      if (n.status === "running" && n.runId) {
        disp.cancel(n.runId);
        n.status = "cancelled";
        n.finishedAt = Date.now();
      } else if (n.status === "pending" || n.status === "ready") {
        n.status = "skipped";
        n.finishedAt = Date.now();
      }
    }
    run.status = "cancelled";
    emit(run);
    // If nothing is in flight, settle immediately; otherwise the in-flight
    // `done` promises will resolve (the dispatcher delivers cancelled results)
    // and the last settle handler waits for inflight to drain.
    if (inflight.size === 0) {
      settleRun();
    } else {
      void Promise.allSettled([...inflight.values()]).then(() => {
        if (run.status === "cancelled" && run.finishedAt === undefined) {
          settleRun();
        }
      });
    }
  };

  // Kick off. If the graph is empty or nothing is dispatchable, settle now.
  emit(run);
  propagateSkips();
  pump();
  if (inflight.size === 0 && readyNodes().length === 0) {
    settleRun();
  }

  return { done, cancel };
}

// ----- cancel by session -----

// Cancels in-flight node runs for the active workflow of a session by aborting
// each running node's delegate run. Mirrors tasks.ts cancelTask; the engine's
// own `cancel()` closure is preferred when a controller is in hand, but this
// covers the /clear / delete_session bulk path where only the run snapshot is
// available.
export function cancelWorkflowRuns(sessionId: string): void {
  const run = runBySession.get(sessionId);
  if (!run) return;
  for (const n of run.nodes) {
    if (n.status === "running" && n.runId) {
      executeCancelRun(n.runId);
      n.status = "cancelled";
      n.finishedAt = Date.now();
    } else if (n.status === "pending" || n.status === "ready") {
      n.status = "skipped";
      n.finishedAt = Date.now();
    }
  }
  if (run.status === "running" || run.status === "proposed") {
    run.status = "cancelled";
    run.finishedAt = Date.now();
  }
}
