import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunEvent } from "../../../shared/events.js";

type CanUseToolBridge = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: {
    signal: AbortSignal;
    suggestions: string[];
    title?: string;
    description?: string;
  },
) => Promise<
  | {
      behavior: "allow";
      rulesToPersist?: string[];
      updatedInput?: Record<string, unknown>;
    }
  | { behavior: "deny"; message: string }
>;

import type { ClaudePermissionMode } from "../../../shared/events.js";

type ClaudeRunArgs = {
  prompt: string;
  cwd?: string;
  resumeId?: string;
  systemPrompt?: string;
  model?: string;
  allowRules?: string[];
  permissionMode?: ClaudePermissionMode;
  canUseTool?: CanUseToolBridge;
  abortController?: AbortController;
  // In-process MCP servers (e.g. the orchestrator's delegate_run tool).
  // Forwarded verbatim to the SDK's mcpServers option.
  mcpServers?: Record<string, unknown>;
  onEvent: (ev: RunEvent) => void;
  onResumeId: (id: string | null) => void;
  // Audit hook — fires for every raw SDK message before translation to a
  // RunEvent. The transcript NDJSON uses this to preserve detail (session
  // init, tool_use ids, result summaries) that the normalized stream drops.
  onRaw?: (msg: unknown) => void;
};

export async function runClaude(args: ClaudeRunArgs): Promise<void> {
  const {
    prompt,
    cwd,
    resumeId,
    systemPrompt,
    model,
    allowRules,
    permissionMode,
    canUseTool,
    abortController,
    mcpServers,
    onEvent,
    onResumeId,
    onRaw,
  } = args;

  const options: Record<string, unknown> = { includePartialMessages: true };
  if (cwd) options.cwd = cwd;
  if (model) options.model = model;
  if (resumeId) options.resume = resumeId;
  if (abortController) options.abortController = abortController;
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
  }
  if (systemPrompt && systemPrompt.trim()) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt,
    };
  }

  // The server owns the rule list — isolate from the user's filesystem
  // settings so behavior is predictable across machines.
  options.settingSources = [];
  if (allowRules && allowRules.length > 0) {
    options.settings = { permissions: { allow: [...allowRules] } };
  }

  // Apply permission mode to the SDK call. `bypassPermissions` additionally
  // requires opt-in via `allowDangerouslySkipPermissions` (SDK safety check).
  // `default` is the SDK default — leave the option unset so user/project
  // settings can still take effect if we ever expose them.
  if (permissionMode && permissionMode !== "default") {
    options.permissionMode = permissionMode;
    if (permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }
  }

  if (canUseTool) {
    options.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      ctx: {
        signal: AbortSignal;
        suggestions?: unknown[];
        title?: string;
        description?: string;
      },
    ) => {
      const suggestionStrings = extractSuggestionStrings(ctx.suggestions);
      const decision = await canUseTool(toolName, input, {
        signal: ctx.signal,
        suggestions: suggestionStrings,
        title: ctx.title,
        description: ctx.description,
      });

      if (decision.behavior === "allow") {
        const updates = decision.rulesToPersist
          ? buildAddRulesUpdate(decision.rulesToPersist)
          : undefined;
        // SDK control protocol forwards `updatedInput` to the CLI, which Zod-
        // validates it as a required record. Echo back the original `input`
        // when the caller has no override — sending `undefined` triggers
        // "invalid_type: expected record, received undefined".
        const allow: {
          behavior: "allow";
          updatedPermissions?: ReturnType<typeof buildAddRulesUpdate>;
          updatedInput: Record<string, unknown>;
        } = {
          behavior: "allow",
          updatedInput: decision.updatedInput ?? input,
        };
        if (updates && updates.length > 0) allow.updatedPermissions = updates;
        return allow;
      }
      return { behavior: "deny" as const, message: decision.message };
    };
  }

  const pendingTool = new Map<string, { name: string; input: unknown }>();

  try {
    // Per-message index → start timestamp for thinking blocks, used to attach
    // elapsed seconds to the "thinking" marker emitted on content_block_stop.
    const thinkingBlockStart = new Map<number, number>();
    const elapsedSeconds = (startedAt: number): number =>
      Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    for await (const message of query({ prompt, options: options as any })) {
      onRaw?.(message);
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
            if (ev.content_block?.type === "thinking") {
              thinkingBlockStart.set(ev.index, Date.now());
            }
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
              onEvent({ type: "text_delta", delta: d.text });
            }
            // thinking_delta is intentionally dropped — the SDK exposes the
            // model's private reasoning text, but we only surface a collapsed
            // "> Thought (Ns)" marker. Forwarding the deltas as text_delta
            // leaked the raw thoughts into the transcript bullet.
          } else if (ev.type === "content_block_stop") {
            const startedAt = thinkingBlockStart.get(ev.index);
            if (startedAt !== undefined) {
              thinkingBlockStart.delete(ev.index);
              // Atomic mode (text: "") so the marker doesn't steal preceding
              // text_delta buf in the client's blocksFromEvents — interleaved
              // thinking can land after a text block.
              onEvent({ type: "thinking", seconds: elapsedSeconds(startedAt), text: "" });
            }
          }
          break;
        }

        case "assistant": {
          // Text and thinking are streamed via stream_event because we always
          // set includePartialMessages: true. Re-emitting them from the
          // assembled assistant message caused the response to be duplicated
          // in the transcript (and historically leaked thinking text via the
          // fallback path). Only tool_use needs to be captured here — the
          // stream_event content_block_start for a tool_use carries no input,
          // and the input_json_delta partials aren't currently accumulated.
          const blocks = (message as any).message?.content ?? [];
          for (const b of blocks) {
            if (b?.type === "tool_use") {
              pendingTool.set(b.id ?? "", { name: b.name ?? "", input: b.input ?? {} });
            }
          }
          const mu = (message as any).message?.usage;
          if (mu) onEvent({ type: "usage", ...normalizeUsage(mu) });
          thinkingBlockStart.clear();
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
    // AbortController.abort() surfaces as an AbortError / DOMException — that's
    // a user-initiated stop, not a runner failure. Don't pollute the transcript
    // with a red error row.
    if (isAbortError(err) || abortController?.signal.aborted) {
      return;
    }
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

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
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

// Flatten the SDK's PermissionUpdate suggestions into the wire-format rule
// strings used by `settings.permissions.allow` (e.g. "Bash(npm install)").
// The SDK has historically shipped either camelCase (`toolName`/`ruleContent`)
// or snake_case (`tool_name`/`rule_content`) fields depending on version, so
// accept both rather than tying to one shape.
function extractSuggestionStrings(suggestions: unknown[] | undefined): string[] {
  if (!suggestions) return [];
  const out: string[] = [];
  for (const s of suggestions) {
    if (!s || typeof s !== "object") continue;
    const rules = (s as Record<string, unknown>).rules;
    if (!Array.isArray(rules)) continue;
    for (const r of rules) {
      if (!r || typeof r !== "object") continue;
      const obj = r as Record<string, unknown>;
      const toolName =
        (typeof obj.toolName === "string" && obj.toolName) ||
        (typeof obj.tool_name === "string" && obj.tool_name);
      if (!toolName) continue;
      const ruleContent =
        (typeof obj.ruleContent === "string" && obj.ruleContent) ||
        (typeof obj.rule_content === "string" && obj.rule_content) ||
        undefined;
      out.push(ruleContent ? `${toolName}(${ruleContent})` : toolName);
    }
  }
  return Array.from(new Set(out));
}

// Build a PermissionUpdate that adds the given rules to the session policy.
// Persistence to disk happens server-side; this only widens the SDK's view
// for the remainder of the turn.
function buildAddRulesUpdate(
  ruleStrings: string[],
): Array<{ type: "addRules"; rules: Array<{ toolName: string; ruleContent?: string }>; behavior: "allow"; destination: "session" }> {
  const rules = ruleStrings
    .map(parseRuleString)
    .filter((r): r is { toolName: string; ruleContent?: string } => r != null);
  if (rules.length === 0) return [];
  return [{ type: "addRules", rules, behavior: "allow", destination: "session" }];
}

function parseRuleString(
  s: string,
): { toolName: string; ruleContent?: string } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/s);
  if (!m) return null;
  const toolName = m[1];
  const ruleContent = m[2];
  return ruleContent ? { toolName, ruleContent } : { toolName };
}
