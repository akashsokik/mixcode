import { Codex, type ModelReasoningEffort } from "@openai/codex-sdk";
import type {
  ContextUsage,
  RunEvent,
  RunnerKind,
  TurnUsage,
} from "../../../shared/events.js";
import { startTurnPerf } from "./perf.js";

// Codex SDK does not expose a per-model context window. Static reference
// table sourced from each model's published documentation — used only as the
// denominator for the rail's "Ctx %" display. Add entries as new models ship.
const CODEX_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5-codex": 400_000,
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
};

function codexWindowFor(model: string | undefined): number | null {
  if (!model) return null;
  if (CODEX_CONTEXT_WINDOWS[model] != null) return CODEX_CONTEXT_WINDOWS[model];
  if (model.startsWith("gpt-5")) return 400_000;
  if (model.startsWith("gpt-4o")) return 128_000;
  return null;
}

// Configuration for the per-session orchestrator MCP child. When provided,
// codex.ts wires an `mcp_servers.orchestrator` stdio entry into the Codex
// CLI config so the spawned codex process gets the same `delegate_run` /
// `get_run` / `cancel_run` tools that Claude has in-process. The MCP child
// (modules/mcp-codex-orchestrator.mjs) proxies tool calls back to the Hono server's
// `/internal/delegate` endpoint using these env values.
export type OrchestratorConfig = {
  url: string;
  token: string;
  scriptPath: string;
  parentSessionId: string;
  parentRunner: RunnerKind;
  parentCwd: string;
  depth: number;
};

type CodexRunArgs = {
  prompt: string;
  cwd?: string;
  threadId?: string;
  model?: string;
  // Per-turn reasoning effort. Unset uses the Codex CLI default. The /effort
  // command (see docs/plans/2026-05-28-unified-effort.md) feeds the session
  // override through this same field.
  reasoningEffort?: ModelReasoningEffort;
  signal?: AbortSignal;
  onEvent: (ev: RunEvent) => void;
  // Fires once on `turn.completed`. Sourced verbatim from the SDK's Usage
  // record — see TurnCompletedEvent in @openai/codex-sdk.
  onTurnUsage?: (usage: TurnUsage) => void;
  onContextUsage?: (ctx: ContextUsage | null) => void;
  onThreadId: (id: string | null) => void;
  // Audit hook — fires for every raw SDK stream event before translation.
  // See claude.ts for rationale.
  onRaw?: (msg: unknown) => void;
  orchestrator?: OrchestratorConfig;
};

// Codex CLI receives MCP server config + spawn env at process construction
// time. A previous singleton meant every turn shared the same env, which
// broke per-session orchestrator scoping. We now construct the client per
// call so each spawned codex CLI sees the parent session's identity.
function buildCodexClient(orchestrator?: OrchestratorConfig): Codex {
  const clientOptions: Record<string, unknown> = {};
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) clientOptions.apiKey = apiKey;

  if (orchestrator) {
    // Dotted-path keys per codex-sdk README; nested object also works because
    // the SDK flattens it into `-c key=value` overrides with TOML literals.
    clientOptions.config = {
      mcp_servers: {
        orchestrator: {
          command: process.execPath,
          args: [orchestrator.scriptPath],
          env: {
            ORCHESTRATOR_URL: orchestrator.url,
            ORCHESTRATOR_TOKEN: orchestrator.token,
            PARENT_SESSION_ID: orchestrator.parentSessionId,
            PARENT_RUNNER: orchestrator.parentRunner,
            PARENT_CWD: orchestrator.parentCwd,
            DELEGATION_DEPTH: String(orchestrator.depth),
          },
        },
      },
    };
  }

  return new Codex(clientOptions as any);
}

export async function runCodex(args: CodexRunArgs): Promise<void> {
  const {
    prompt,
    cwd,
    threadId,
    model,
    reasoningEffort,
    signal,
    onEvent,
    onTurnUsage,
    onContextUsage,
    onThreadId,
    onRaw,
    orchestrator,
  } = args;

  if (!process.env.OPENAI_API_KEY) {
    onEvent({
      type: "error",
      message: "OPENAI_API_KEY is not set. Add it to server/.env and restart.",
    });
    return;
  }

  const perf = startTurnPerf("codex");
  try {
    const threadOptions: any = { skipGitRepoCheck: true };
    if (cwd) threadOptions.workingDirectory = cwd;
    if (model) threadOptions.model = model;
    if (reasoningEffort) threadOptions.modelReasoningEffort = reasoningEffort;
    // Headless mode hits a known Codex CLI regression (openai/codex#16685):
    // custom MCP servers get routed through the approval pipeline, and exec
    // mode has no way to prompt, so the call auto-cancels with
    // "user cancelled MCP tool call". The community thread confirms the
    // only working workaround until PR #16632 lands is sandboxMode
    // "danger-full-access" — that path bypasses approval routing for MCP
    // tools. Scoped to delegating sessions only so non-orchestrator codex
    // runs keep their default sandbox.
    if (orchestrator) {
      threadOptions.approvalPolicy = "never";
      threadOptions.sandboxMode = "danger-full-access";
    }

    const client = buildCodexClient(orchestrator);
    const thread = threadId
      ? client.resumeThread(threadId, threadOptions)
      : client.startThread(threadOptions);

    const streamed = await thread.runStreamed(prompt);
    const finalized = new Set<string>();
    const streamedPrefix = new Map<string, string>();
    const itemStartMs = new Map<string, number>();
    // The last agent_message that finished without yet seeing a follow-up
    // item. If anything else (tool, reasoning, another agent_message) lands
    // before turn.completed, the previous agent_message was a preamble and
    // collapses into "> Thought (Ns)". turn.completed clears this without
    // promoting, leaving the final answer as plain text.
    let pendingAgentMsg: { id: string; startedAt: number } | null = null;

    const elapsedSeconds = (startedAt: number): number =>
      Math.max(0, Math.round((Date.now() - startedAt) / 1000));

    const promotePendingAgentMsg = (): void => {
      if (!pendingAgentMsg) return;
      onEvent({ type: "thinking", seconds: elapsedSeconds(pendingAgentMsg.startedAt) });
      pendingAgentMsg = null;
    };

    const emitAgentDelta = (item: any): void => {
      const id: string | undefined = item?.id;
      const full: string = typeof item?.text === "string" ? item.text : "";
      if (!id || !full) return;
      const prev = streamedPrefix.get(id) ?? "";
      const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
      if (delta.length === 0) return;
      streamedPrefix.set(id, full);
      perf.mark("firstText");
      onEvent({ type: "text_delta", delta });
    };

    // The Codex SDK doesn't accept an AbortSignal on runStreamed, so race the
    // iterator's next() against the abort. Checking signal.aborted between
    // iterations isn't enough — the SDK may block awaiting the model for
    // seconds between user-visible events.
    const events = streamed.events as AsyncIterable<any>;
    const iter = events[Symbol.asyncIterator]();
    const aborted = signal
      ? new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        })
      : null;
    const SENTINEL = Symbol("aborted");

    while (true) {
      if (signal?.aborted) break;
      const next = aborted
        ? await Promise.race<IteratorResult<any> | typeof SENTINEL>([
            iter.next(),
            aborted.then(() => SENTINEL),
          ])
        : await iter.next();
      if (next === SENTINEL || signal?.aborted) break;
      if (next.done) break;
      const ev = next.value;
      perf.mark("init");
      onRaw?.(ev);
      switch (ev.type) {
        case "thread.started":
          if (!threadId && ev.thread_id) onThreadId(ev.thread_id);
          break;

        case "item.started": {
          const id: string | undefined = ev.item?.id;
          const type: string | undefined = ev.item?.type;
          if (id && !itemStartMs.has(id)) itemStartMs.set(id, Date.now());
          // A new non-agent_message item — or a different agent_message —
          // means the previous agent_message was a preamble. Promote it.
          if (pendingAgentMsg && id !== pendingAgentMsg.id) {
            promotePendingAgentMsg();
          }
          if (type === "agent_message") emitAgentDelta(ev.item);
          break;
        }

        case "item.updated":
          if (ev.item?.type === "agent_message") emitAgentDelta(ev.item);
          break;

        case "item.completed": {
          const id: string | undefined = ev.item?.id;
          const type: string | undefined = ev.item?.type;
          if (id && finalized.has(id)) break;
          if (id) finalized.add(id);
          if (type === "agent_message") {
            emitAgentDelta(ev.item);
            // Defer the preamble-vs-final decision until we see what comes
            // next. turn.completed clears this without promoting.
            pendingAgentMsg = {
              id: id ?? "",
              startedAt: itemStartMs.get(id ?? "") ?? Date.now(),
            };
            break;
          }
          // Any other completed item means the prior agent_message (if any)
          // was a preamble. Promote before emitting this item so the order
          // on the wire matches what the user sees.
          promotePendingAgentMsg();
          if (type === "reasoning") {
            // Atomic thinking marker with empty text — the raw reasoning
            // content is intentionally dropped. Forwarding it as text_delta
            // leaked the model's private reasoning into the transcript
            // bullet (and the marker-mode reclassify in the client couldn't
            // separate it from any preceding response text).
            onEvent({
              type: "thinking",
              seconds: elapsedSeconds(itemStartMs.get(id ?? "") ?? Date.now()),
              text: "",
            });
            break;
          }
          emitItemEvents(onEvent, ev.item);
          break;
        }

        case "turn.completed":
          // The final agent_message of the turn stays as text — clear without
          // promoting.
          pendingAgentMsg = null;
          if (ev.usage) {
            const usage: TurnUsage = {
              input: ev.usage.input_tokens ?? 0,
              output: ev.usage.output_tokens ?? 0,
              cacheRead: ev.usage.cached_input_tokens ?? 0,
              cacheWrite: 0,
              reasoningOutput: ev.usage.reasoning_output_tokens ?? 0,
              model,
            };
            onTurnUsage?.(usage);
            const window = codexWindowFor(model);
            if (window && onContextUsage) {
              const loaded = usage.input + usage.cacheRead;
              const pct = (loaded / window) * 100;
              onContextUsage({
                totalTokens: loaded,
                maxTokens: window,
                percentage: Math.round(Math.min(100, pct) * 10) / 10,
              });
            } else if (onContextUsage) {
              onContextUsage(null);
            }
          }
          break;

        case "turn.failed":
          pendingAgentMsg = null;
          onEvent({ type: "error", message: ev.error?.message ?? "turn failed" });
          break;

        case "error": {
          const msg = ev.message ?? "stream error";
          // Codex SDK surfaces non-fatal config warnings as `error` events;
          // forwarding them as fatal aborts the whole turn before any model
          // call happens. Drop known-benign cases silently.
          if (/deprecated|warning/i.test(msg)) break;
          onEvent({ type: "error", message: msg });
          break;
        }
      }
    }
  } catch (err: any) {
    if (signal?.aborted) return;
    onEvent({ type: "error", message: `codex sdk: ${err?.message ?? String(err)}` });
  } finally {
    perf.done();
  }
}

function emitItemEvents(onEvent: (ev: RunEvent) => void, item: any): void {
  if (!item || typeof item !== "object") return;
  switch (item.type) {
    case "todo_list":
      // Plan items aren't user-facing in v1; the assistant text and tool
      // logs carry the visible content. Reasoning is handled inline by the
      // item.completed branch (emitted as a collapsed thought).
      return;

    case "command_execution": {
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exit = typeof item.exit_code === "number" ? item.exit_code : null;
      // Surface a non-zero exit even when the SDK doesn't flag the item as
      // failed (e.g. timeouts, signal terminations, scripts that the model
      // expects to fail). Zero exits stay quiet — matches Claude's Bash card.
      const trailer = exit !== null && exit !== 0 ? (output ? `\n[exit ${exit}]` : `[exit ${exit}]`) : "";
      onEvent({
        type: "tool_log",
        log: {
          name: "Bash",
          input: { command: item.command },
          output: output + trailer,
          isError: item.status === "failed",
        },
      });
      return;
    }

    case "file_change": {
      const changes: Array<{ path: string; kind: string }> = Array.isArray(item.changes)
        ? item.changes
            .filter((c: any) => c && typeof c === "object" && typeof c.path === "string")
            .map((c: any) => ({ path: c.path, kind: typeof c.kind === "string" ? c.kind : "update" }))
        : [];
      // Codex emits `{path, kind}` per file; no diff hunks. Use the path as
      // the header summary (matches Claude's Edit/Write header) and the body
      // as a one-line-per-file list so add/update/delete is visible.
      const input: Record<string, unknown> =
        changes.length === 1
          ? { file_path: changes[0].path }
          : { file_path: `${changes.length} files` };
      // Single-file: body is just the kind (path already in header).
      // Multi-file: `kind path` per line so no path is lost.
      const body = changes.length === 0
        ? `status: ${item.status ?? "unknown"}`
        : changes.length === 1
          ? changes[0].kind
          : changes.map((c) => `${c.kind} ${c.path}`).join("\n");
      onEvent({
        type: "tool_log",
        log: {
          name: "Edit",
          input,
          output: body,
          isError: item.status === "failed",
        },
      });
      return;
    }

    case "mcp_tool_call": {
      // result.content is an MCP ContentBlock[] (typically [{type:"text",...}])
      // — let format.ts unwrap it. error is `{message}` — flatten so the body
      // shows the message directly rather than a JSON dump.
      let output: unknown = null;
      if (item.error && typeof item.error.message === "string") {
        output = item.error.message;
      } else if (item.result && Array.isArray(item.result.content)) {
        output = item.result.content;
      } else if (item.result && item.result.structured_content !== undefined) {
        output = item.result.structured_content;
      }
      onEvent({
        type: "tool_log",
        log: {
          name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
          input: item.arguments ?? {},
          output,
          isError: item.status === "failed",
        },
      });
      return;
    }

    case "web_search":
      onEvent({
        type: "tool_log",
        log: {
          name: "WebSearch",
          input: { query: item.query },
          output: "(results delivered to model)",
        },
      });
      return;

    case "todo_list": {
      // Claude exposes the same concept via the TodoWrite tool. Mirror the
      // name so both runners produce one tool card per plan update. The SDK
      // fires item.completed once when the turn ends with the final list.
      const items: Array<{ text: string; completed: boolean }> = Array.isArray(item.items)
        ? item.items
            .filter((t: any) => t && typeof t === "object")
            .map((t: any) => ({
              text: typeof t.text === "string" ? t.text : "",
              completed: t.completed === true,
            }))
        : [];
      if (items.length === 0) return;
      const done = items.filter((t) => t.completed).length;
      onEvent({
        type: "tool_log",
        log: {
          name: "TodoWrite",
          input: { count: items.length, completed: done },
          output: items.map((t) => `[${t.completed ? "x" : " "}] ${t.text}`).join("\n"),
        },
      });
      return;
    }

    case "error":
      if (item.message) onEvent({ type: "error", message: item.message });
      return;
  }
}

