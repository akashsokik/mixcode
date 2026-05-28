import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ContextUsage, RunEvent, TurnUsage } from "../../../shared/events.js";
import { startTurnPerf } from "./perf.js";

// Pull just the plugin-related keys out of the user's ~/.claude/settings.json
// without enabling the rest of the file (hooks, permissions, etc.). The runner
// sets `settingSources: []` to isolate from user filesystem state for
// predictable per-machine behavior, but that also drops `enabledPlugins`, so
// plugin-bundled slash skills like /superpowers:brainstorming never resolve.
// Reading and re-applying those two keys surgically keeps the isolation
// promise while letting the user's enabled plugins load.
function userClaudePluginSettings(): {
  enabledPlugins?: Record<string, unknown>;
  extraKnownMarketplaces?: Record<string, unknown>;
} {
  const file = path.join(homedir(), ".claude", "settings.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: {
    enabledPlugins?: Record<string, unknown>;
    extraKnownMarketplaces?: Record<string, unknown>;
  } = {};
  if (parsed && typeof parsed === "object") {
    if (parsed.enabledPlugins && typeof parsed.enabledPlugins === "object") {
      out.enabledPlugins = parsed.enabledPlugins;
    }
    if (
      parsed.extraKnownMarketplaces &&
      typeof parsed.extraKnownMarketplaces === "object"
    ) {
      out.extraKnownMarketplaces = parsed.extraKnownMarketplaces;
    }
  }
  return out;
}

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

import type { ClaudePermissionMode, EffortLevel } from "../../../shared/events.js";

type ClaudeRunArgs = {
  prompt: string;
  cwd?: string;
  resumeId?: string;
  systemPrompt?: string;
  model?: string;
  effort?: EffortLevel;
  allowRules?: string[];
  // Wire-level union plus the SDK-only "dontAsk" mode for peers that have no
  // user UI to gate tool calls. The TUI never sets "dontAsk"; consensus
  // rounds use it to silently deny anything outside `allowedTools`.
  permissionMode?: ClaudePermissionMode | "dontAsk";
  canUseTool?: CanUseToolBridge;
  abortController?: AbortController;
  // In-process MCP servers (e.g. the orchestrator's delegate_run tool).
  // Forwarded verbatim to the SDK's mcpServers option.
  mcpServers?: Record<string, unknown>;
  // Hard cap on agent turns. Consensus rounds set this to keep peer Claude
  // from making 80+ tool calls before producing a plan.
  maxTurns?: number;
  // Whitelist of tool names the SDK exposes to the model. Use together with
  // `permissionMode: "dontAsk"` to lock a peer down to read-only tools.
  allowedTools?: string[];
  onEvent: (ev: RunEvent) => void;
  // Fires exactly once per turn from `result.usage` (the SDK's canonical
  // final-aggregate). The runner does not emit per-assistant-message usage
  // anymore — see the comment near the `result` case below.
  onTurnUsage?: (usage: TurnUsage) => void;
  // Fires once per turn, derived from `result.modelUsage[<model>].contextWindow`
  // (authoritative SDK-reported window for the model that produced the turn)
  // and the same result's `usage` totals. Null on result subtypes that don't
  // carry usage (anything outside success / error_max_turns).
  onContextUsage?: (ctx: ContextUsage | null) => void;
  onResumeId: (id: string | null) => void;
  // Fires once per turn from the SDK's `system init` message with the actual
  // skill names and plugin metadata loaded into this session. Names are bare
  // (`use-railway`, built-ins like `update-config`) or plugin-qualified
  // (`superpowers:brainstorming`). Plugins gives the install path so the TUI
  // can resolve descriptions out of the cache.
  onSkillInfo?: (info: {
    skills: string[];
    plugins: { name: string; path: string }[];
  }) => void;
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
    effort,
    allowRules,
    permissionMode,
    canUseTool,
    abortController,
    mcpServers,
    maxTurns,
    allowedTools,
    onEvent,
    onTurnUsage,
    onContextUsage,
    onResumeId,
    onSkillInfo,
    onRaw,
  } = args;

  const options: Record<string, unknown> = { includePartialMessages: true };
  if (cwd) options.cwd = cwd;
  if (model) options.model = model;
  if (effort) options.effort = effort;
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
  // settings so behavior is predictable across machines. But also splice
  // back the user's enabledPlugins / extraKnownMarketplaces so
  // plugin-bundled slash skills (e.g. /superpowers:brainstorming) actually
  // resolve. Permission rules and hooks stay server-owned because the
  // settings we set below override the user file (precedence is user <
  // project < local < flag < policy, and `options.settings` lands at flag).
  options.settingSources = [];
  const userPlugins = userClaudePluginSettings();
  const settings: Record<string, unknown> = {};
  if (allowRules && allowRules.length > 0) {
    settings.permissions = { allow: [...allowRules] };
  }
  if (userPlugins.enabledPlugins) {
    settings.enabledPlugins = userPlugins.enabledPlugins;
  }
  if (userPlugins.extraKnownMarketplaces) {
    settings.extraKnownMarketplaces = userPlugins.extraKnownMarketplaces;
  }
  if (Object.keys(settings).length > 0) {
    options.settings = settings;
  }
  // Enable every discovered skill — without this the SDK keeps skills off
  // for non-CLI integrations even when plugins are loaded.
  options.skills = "all";

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
  if (typeof maxTurns === "number" && maxTurns > 0) {
    options.maxTurns = maxTurns;
  }
  if (allowedTools !== undefined) {
    // Empty array intentionally locks the agent to text-only output —
    // useful for synthesis rounds that should not touch the repo at all.
    options.allowedTools = allowedTools;
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

  // Track whether the stream ever yielded a `result:success`. Some SDK
  // paths (notably local slash commands like /usage that bypass the model
  // loop) close the stream without emitting `result`, leaving the
  // session_id we captured on init pointing at a conversation that was
  // never persisted. The post-loop guard below uses this to clear the
  // resumeId in that case so the next turn doesn't try to resume a ghost.
  let sawSuccessResult = false;
  const perf = startTurnPerf("claude");
  try {
    // Per-message index → start timestamp for thinking blocks, used to attach
    // elapsed seconds to the "thinking" marker emitted on content_block_stop.
    const thinkingBlockStart = new Map<number, number>();
    const elapsedSeconds = (startedAt: number): number =>
      Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    for await (const message of query({ prompt, options: options as any })) {
      perf.mark("init");
      onRaw?.(message);
      switch (message.type) {
        case "system": {
          const sub = (message as any).subtype;
          if (sub === "init") {
            const m = message as any;
            if (m.session_id) onResumeId(m.session_id);
            if (onSkillInfo) {
              const skills: string[] = Array.isArray(m.skills) ? m.skills : [];
              const plugins: { name: string; path: string }[] = Array.isArray(m.plugins)
                ? m.plugins.filter(
                    (p: any) =>
                      p && typeof p === "object" && typeof p.name === "string" && typeof p.path === "string",
                  )
                : [];
              onSkillInfo({ skills, plugins });
            }
          } else if (sub === "local_command_output") {
            // Output from a local slash command (e.g. /usage, /voice). The
            // SDK bypasses the model loop and emits this single chunk. Render
            // it as plain text so the user sees the result instead of an
            // empty bullet.
            const content = (message as any).content;
            if (typeof content === "string" && content.length > 0) {
              perf.mark("firstText");
              onEvent({ type: "text_delta", delta: content });
            }
          }
          break;
        }

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
              perf.mark("firstText");
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
          // We intentionally do NOT emit usage from the per-assistant-message
          // record. Multi-tool-call turns produce several `assistant` messages
          // and each carries the SDK's running totals for its own API call;
          // taking them as truth either double-counts or requires max-merging
          // against the eventual `result.usage`. The `result` message below is
          // the SDK's canonical per-turn aggregate — that's the only source of
          // truth we forward.
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
            sawSuccessResult = true;
            forwardClaudeResultUsage(m, onTurnUsage, onContextUsage);
          } else if (m.subtype === "error_max_turns") {
            // Soft cap. The session is still valid (resumeId stays good), the
            // partial text the agent produced before exhausting turns is what
            // it is. Emit a notice instead of a red error row so callers that
            // opt into maxTurns (e.g. /consensus rounds) can use the partial
            // output without the transcript treating it as a crash.
            forwardClaudeResultUsage(m, onTurnUsage, onContextUsage);
            onEvent({
              type: "tool_log",
              log: {
                name: "maxTurns",
                output: `Hit per-call turn cap. Partial output kept; session still resumable.`,
              },
            });
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
  } finally {
    perf.done();
  }

  for (const [, call] of pendingTool) {
    onEvent({
      type: "tool_log",
      log: { name: call.name, input: call.input, output: "(no result)" },
    });
  }

  // Loop-bypassed turns (e.g. /usage, /voice — see the SDK's "local slash
  // command" path) close the stream without emitting `result:success`. The
  // session_id captured on init points at a conversation that was never
  // persisted, so trying to resume it on the next turn raises
  // `error_during_execution (No conversation found with session ID: …)`.
  // Drop the id to force the next turn to start a fresh conversation.
  if (!sawSuccessResult) {
    onResumeId(null);
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}

// Map the SDK's snake_case usage record to our internal TurnUsage shape.
// Pure projection — no field merging, no summing across events.
function normalizeUsage(u: any): TurnUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

// Forward a result message's usage record as a TurnUsage and derive the
// context-window snapshot from the same SDK payload. Both signals come from
// one event, so they're consistent by construction.
//
// `result.modelUsage` is keyed by model id (e.g. "claude-opus-4-7") and the
// entry's `contextWindow` is the authoritative window size for that model.
// In a single-model turn there's one entry; in a multi-model turn (e.g.
// orchestrator + worker) we pick the first matching the result's primary
// model when available, otherwise the entry with the largest window so we
// don't accidentally clip the displayed % against a smaller delegate model.
function forwardClaudeResultUsage(
  m: any,
  onTurnUsage?: (u: TurnUsage) => void,
  onContextUsage?: (c: ContextUsage | null) => void,
): void {
  const raw = m?.usage;
  if (!raw) {
    onContextUsage?.(null);
    return;
  }
  const usage = normalizeUsage(raw);
  if (typeof m.total_cost_usd === "number") usage.costUsd = m.total_cost_usd;
  onTurnUsage?.(usage);

  if (!onContextUsage) return;
  const modelUsage = m?.modelUsage;
  const window = pickPrimaryContextWindow(modelUsage);
  if (!window) {
    onContextUsage(null);
    return;
  }
  const loaded = usage.input + usage.cacheRead + usage.cacheWrite;
  const pct = window > 0 ? Math.min(100, (loaded / window) * 100) : 0;
  onContextUsage({
    totalTokens: loaded,
    maxTokens: window,
    percentage: Math.round(pct * 10) / 10,
  });
}

function pickPrimaryContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
): number | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  let best: number | null = null;
  for (const entry of Object.values(modelUsage)) {
    const w = entry?.contextWindow;
    if (typeof w === "number" && w > 0 && (best == null || w > best)) {
      best = w;
    }
  }
  return best;
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
