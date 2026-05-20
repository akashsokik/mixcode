import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunEvent } from "../../../shared/events.js";

type ClaudeRunArgs = {
  prompt: string;
  resumeId?: string;
  systemPrompt?: string;
  model?: string;
  onEvent: (ev: RunEvent) => void;
  onResumeId: (id: string | null) => void;
};

export async function runClaude(args: ClaudeRunArgs): Promise<void> {
  const { prompt, resumeId, systemPrompt, model, onEvent, onResumeId } = args;

  const options: Record<string, unknown> = { includePartialMessages: true };
  if (model) options.model = model;
  if (resumeId) options.resume = resumeId;
  if (systemPrompt && systemPrompt.trim()) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt,
    };
  }

  const pendingTool = new Map<string, { name: string; input: unknown }>();

  try {
    const streamedBlocks = new Set<number>();
    for await (const message of query({ prompt, options: options as any })) {
      switch (message.type) {
        case "system":
          if ((message as any).subtype === "init" && (message as any).session_id) {
            onResumeId((message as any).session_id);
          }
          break;

        case "stream_event": {
          const ev = (message as any).event;
          if (!ev) break;
          if (ev.type === "content_block_start") {
            if (ev.content_block?.type === "text") streamedBlocks.add(ev.index);
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
              streamedBlocks.add(ev.index);
              onEvent({ type: "text_delta", delta: d.text });
            }
          }
          break;
        }

        case "assistant": {
          const blocks = (message as any).message?.content ?? [];
          blocks.forEach((b: any, idx: number) => {
            if (b.type === "text") {
              if (streamedBlocks.has(idx)) return;
              if (b.text) onEvent({ type: "text_delta", delta: b.text });
            } else if (b.type === "tool_use") {
              pendingTool.set(b.id ?? "", { name: b.name ?? "", input: b.input ?? {} });
            }
          });
          const mu = (message as any).message?.usage;
          if (mu) onEvent({ type: "usage", ...normalizeUsage(mu) });
          streamedBlocks.clear();
          break;
        }

        case "user": {
          const blocks = (message as any).message?.content ?? [];
          for (const b of blocks) {
            if (b.type === "tool_result") {
              const id = b.tool_use_id ?? "";
              const call = pendingTool.get(id);
              pendingTool.delete(id);
              onEvent({
                type: "tool_log",
                log: {
                  name: call?.name ?? "tool",
                  input: call?.input,
                  output: b.content ?? null,
                  isError: b.is_error === true,
                },
              });
            }
          }
          break;
        }

        case "result": {
          const m = message as any;
          if (m.subtype === "success") {
            if (m.usage) onEvent({ type: "usage", ...normalizeUsage(m.usage) });
          } else {
            onResumeId(null);
            onEvent({
              type: "error",
              message: `run failed: ${m.subtype} (${(m.errors ?? []).join(";")})`,
            });
            return;
          }
          break;
        }
      }
    }
  } catch (err: any) {
    onResumeId(null);
    onEvent({ type: "error", message: `claude sdk: ${err?.message ?? String(err)}` });
    return;
  }

  for (const [, call] of pendingTool) {
    onEvent({
      type: "tool_log",
      log: { name: call.name, input: call.input, output: "(no result)" },
    });
  }
}

function normalizeUsage(u: any): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}
