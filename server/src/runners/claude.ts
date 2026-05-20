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
  onEvent: (ev: RunEvent) => void;
  onResumeId: (id: string | null) => void;
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
    onEvent,
    onResumeId,
  } = args;

  const options: Record<string, unknown> = { includePartialMessages: true };
  if (cwd) options.cwd = cwd;
  if (model) options.model = model;
  if (resumeId) options.resume = resumeId;
  if (abortController) options.abortController = abortController;
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
