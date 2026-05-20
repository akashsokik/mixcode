import { Codex } from "@openai/codex-sdk";
import type { RunEvent } from "../../../shared/events.js";

type CodexRunArgs = {
  prompt: string;
  cwd?: string;
  threadId?: string;
  model?: string;
  signal?: AbortSignal;
  onEvent: (ev: RunEvent) => void;
  onThreadId: (id: string | null) => void;
};

let codex: Codex | null = null;
function getCodex(): Codex {
  if (codex) return codex;
  const key = process.env.OPENAI_API_KEY ?? "";
  codex = new Codex(key ? ({ apiKey: key } as any) : ({} as any));
  return codex;
}

export async function runCodex(args: CodexRunArgs): Promise<void> {
  const { prompt, cwd, threadId, model, signal, onEvent, onThreadId } = args;

  if (!process.env.OPENAI_API_KEY) {
    onEvent({
      type: "error",
      message: "OPENAI_API_KEY is not set. Add it to server/.env and restart.",
    });
    return;
  }

  try {
    const threadOptions: any = { skipGitRepoCheck: true };
    if (cwd) threadOptions.workingDirectory = cwd;
    if (model) threadOptions.model = model;

    const client = getCodex();
    const thread = threadId
      ? client.resumeThread(threadId, threadOptions)
      : client.startThread(threadOptions);

    const streamed = await thread.runStreamed(prompt);
    const finalized = new Set<string>();
    const streamedPrefix = new Map<string, string>();

    const emitAgentDelta = (item: any): void => {
      const id: string | undefined = item?.id;
      const full: string = typeof item?.text === "string" ? item.text : "";
      if (!id || !full) return;
      const prev = streamedPrefix.get(id) ?? "";
      const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
      if (delta.length === 0) return;
      streamedPrefix.set(id, full);
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
      switch (ev.type) {
        case "thread.started":
          if (!threadId && ev.thread_id) onThreadId(ev.thread_id);
          break;

        case "item.started":
        case "item.updated":
          if (ev.item?.type === "agent_message") emitAgentDelta(ev.item);
          break;

        case "item.completed": {
          const id = ev.item?.id;
          if (id && finalized.has(id)) break;
          if (id) finalized.add(id);
          if (ev.item?.type === "agent_message") {
            emitAgentDelta(ev.item);
            break;
          }
          emitItemEvents(onEvent, ev.item);
          break;
        }

        case "turn.completed":
          if (ev.usage) {
            onEvent({
              type: "usage",
              input: ev.usage.input_tokens ?? 0,
              output: ev.usage.output_tokens ?? 0,
              cacheRead: ev.usage.cached_input_tokens ?? 0,
              cacheWrite: 0,
            });
          }
          break;

        case "turn.failed":
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
  }
}

function emitItemEvents(onEvent: (ev: RunEvent) => void, item: any): void {
  if (!item || typeof item !== "object") return;
  switch (item.type) {
    case "reasoning":
    case "todo_list":
      // Reasoning and plan items aren't user-facing in v1; the assistant text
      // and tool logs carry the visible content.
      return;

    case "command_execution":
      onEvent({
        type: "tool_log",
        log: {
          name: "Bash",
          input: { command: item.command },
          output: item.aggregated_output ?? "",
          isError: item.status === "failed",
        },
      });
      return;

    case "file_change":
      onEvent({
        type: "tool_log",
        log: {
          name: "Edit",
          input: { changes: item.changes ?? [] },
          output: { changes: item.changes?.length ?? 0, status: item.status },
          isError: item.status === "failed",
        },
      });
      return;

    case "mcp_tool_call":
      onEvent({
        type: "tool_log",
        log: {
          name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
          input: item.arguments ?? {},
          output: item.result ?? item.error ?? null,
          isError: item.status === "failed",
        },
      });
      return;

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

    case "error":
      if (item.message) onEvent({ type: "error", message: item.message });
      return;
  }
}

