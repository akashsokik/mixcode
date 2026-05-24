// Vercel AI SDK runner. Uses `streamText` from the `ai` package and routes
// the model id to either @ai-sdk/openai or @ai-sdk/anthropic based on the
// id's prefix. Unlike claude.ts and codex.ts (which both wrap vendor agent
// SDKs that bring their own coding tools), we hand-roll a minimal tool kit
// here — Bash, Read, Write — and route each invocation through the shared
// PermissionStore so vercel sessions honor the same allow-list rules and
// `bypassPermissions`/`acceptEdits` modes as Claude.
//
// Session continuity is process-local: streamText is stateless, so the
// caller passes the prior ModelMessage[] back on every turn and reads the
// new tail out of `result.response.messages`. Persistence lives in
// SessionManager.runtime.vercelMessages.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import {
  streamText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";

import type {
  ClaudePermissionMode,
  RunEvent,
  RunnerKind,
} from "../../../shared/events.js";
import type { PermissionStore, PermissionResolution } from "../permissions.js";
import {
  executeCancelRun,
  executeDelegate,
  executeGetRun,
} from "./delegate.js";
import { executeValidate } from "./validate.js";
import {
  awaitTask,
  cancelTask,
  createTask,
  doneTask,
  observeTask,
  spawnSubtasks,
} from "../orchestrator/tasks.js";
import { loadMcpForVercel } from "./vercel-mcp.js";

// Mirror Claude's edit-tool classification (index.ts EDIT_TOOL_NAMES) so the
// acceptEdits permission mode auto-allows the same set on vercel sessions.
// NotebookEdit isn't shipped here because we don't expose a notebook tool;
// the rest match Claude's documented behaviour.
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit"]);

// Default model id when neither the per-session override nor VERCEL_MODEL is
// set. gpt-4o is the conservative pick — broad provider compat, low chance
// of "unknown model" errors with whatever @ai-sdk/openai version is installed.
const DEFAULT_MODEL = "gpt-4o";

// Bound the agent loop so a runaway tool-call cycle can't burn through
// tokens unbounded. Matches the same order of magnitude Claude / Codex enforce
// internally; expose via env so power users can lift it.
const STEP_LIMIT = (() => {
  const v = process.env.VERCEL_MAX_STEPS;
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

// System prompt — the Vercel runner doesn't ship with a curated preset like
// Claude's `claude_code`, so we spell out the iterate-until-done contract
// here. Removing "be concise" was a deliberate change: early versions of the
// runner appeared to "just stop" after one tool call because the model would
// summarise tersely and emit finishReason=stop. Telling it to keep working
// until the task is actually done is the single biggest reliability lever.
function buildBaseSystemPrompt(cwd: string, isTopLevel: boolean): string {
  const lines = [
    "You are a coding assistant running in a terminal session against a real",
    "filesystem. The session's working directory is:",
    `  ${cwd}`,
    "",
    "Coding tools (always available):",
    "  - Bash         run shell commands (build, git, anything short)",
    "  - Read         read a file (absolute path)",
    "  - Write        create or overwrite a file (absolute path)",
    "  - Edit         exact-string find/replace in a file",
    "  - MultiEdit    sequence of exact-string edits applied atomically",
    "  - Grep         ripgrep across files (regex + glob filter)",
    "  - Glob         list files matching a glob pattern",
    "  - TodoWrite    maintain a running todo list (renders as one card)",
  ];

  if (isTopLevel) {
    lines.push(
      "",
      "Orchestrator tools (adversarial workflow):",
      "  - delegate_run    spawn a peer agent (claude, codex, vercel) with a",
      "                    task; by default waits and returns the peer's text",
      "  - get_run         poll a previously-started peer run",
      "  - cancel_run      stop a running peer",
      "  - validate_run    adversarial peer review — call as your FINAL step",
      "                    before declaring a task done; the peer returns a",
      "                    verdict (pass / needs_changes / fail) you act on",
      "  - task_create / task_spawn / task_await / task_observe /",
      "    task_done / task_cancel — fan-out multiple peers under one card",
      "",
      "User-configured MCP servers (loaded from ~/.claude.json) may also",
      "appear in your tool list — use them like any other tool.",
    );
  }

  lines.push(
    "",
    "Operating rules:",
    "  - Use the tools. If the user asks you to inspect/modify the repo,",
    "    actually run them — do not guess at file contents.",
    "  - Keep iterating until the task is done. After a tool result, decide",
    "    what to do next: another tool call, or a final answer. Do NOT stop",
    "    after one tool call unless the answer is genuinely complete.",
    "  - Prefer Grep (ripgrep) for searching; Glob for path discovery.",
    "  - If you can't make progress (missing info, ambiguous request), say so",
    "    clearly instead of going silent.",
  );

  return lines.join("\n");
}

export type VercelRunArgs = {
  prompt: string;
  cwd: string;
  // Prior turns' ModelMessages, passed back in for continuity. The caller
  // reads the new tail out of onMessages and persists it for next turn.
  priorMessages: ModelMessage[];
  model?: string;
  systemPromptAppend?: string;
  signal: AbortSignal;
  sessionId: string;
  // Subset of the Claude permission modes that make sense here. "plan" is a
  // Claude-SDK concept (no tool execution) and is treated as bypassPermissions
  // with a tighter system prompt suffix — kept as default for v1.
  permissionMode?: ClaudePermissionMode;
  // Optional so peer-spawned vercel runs (via delegate_run) can opt out of
  // the interactive prompt entirely — they bypass for the same reason peer
  // claude/codex runs do (the parent's permission context already gated).
  permissions?: PermissionStore;
  allowRules?: string[];
  // Per-call override of STEP_LIMIT. Consensus rounds set a tight budget
  // (e.g. 5) so peers don't burn 80 tool calls on planning. Falls back to
  // STEP_LIMIT when undefined.
  maxSteps?: number;
  // Delegation depth. Top-level vercel sessions (depth=0) get the full tool
  // set: coding tools + orchestrator (delegate/validate/task_*) + user MCP
  // servers. Peer-spawned vercel runs (depth>=1) get only coding tools, the
  // same gating Claude uses (peer claude runs are launched without the
  // orchestrator MCP).
  depth?: number;
  onEvent: (ev: RunEvent) => void;
  onMessages: (messages: ModelMessage[]) => void;
  onRaw?: (msg: unknown) => void;
};

export async function runVercel(args: VercelRunArgs): Promise<void> {
  const {
    prompt,
    cwd,
    priorMessages,
    model,
    systemPromptAppend,
    signal,
    sessionId,
    permissionMode,
    permissions,
    allowRules,
    maxSteps,
    depth,
    onEvent,
    onMessages,
    onRaw,
  } = args;
  const stepLimit =
    typeof maxSteps === "number" && maxSteps > 0 ? maxSteps : STEP_LIMIT;
  // Top-level vercel sessions get the heavy tool set (orchestrator + user
  // MCP); peer-spawned ones (depth>=1) get only coding tools. Same gate
  // Claude uses — peer claude runs are launched without `mcpServers:` set,
  // so they see no delegate/validate/task_* tools either.
  const isTopLevel = !depth || depth === 0;

  const modelId = model || process.env.VERCEL_MODEL || DEFAULT_MODEL;

  const resolved = resolveProvider(modelId);
  if (!resolved.ok) {
    onEvent({ type: "error", message: resolved.message });
    return;
  }
  const languageModel = resolved.model;

  const baseSystem = buildBaseSystemPrompt(cwd, isTopLevel);
  const system = systemPromptAppend
    ? `${baseSystem}\n\n${systemPromptAppend}`
    : baseSystem;

  const messages: ModelMessage[] = [
    ...priorMessages,
    { role: "user", content: prompt },
  ];

  // Closure used by every tool's execute() to gate on the shared permission
  // store. Mirrors the Claude runtime's canUseTool semantics:
  //   - bypassPermissions: silent allow
  //   - acceptEdits: silent allow for Write
  //   - explicit allowRule match: silent allow
  //   - otherwise: prompt the user via permissions.request
  const gate = async (
    toolName: string,
    input: Record<string, unknown>,
    suggestions: string[],
    description: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    // No PermissionStore -> peer-spawned run. Silently allow; the parent
    // turn's permission context is the gate.
    if (!permissions) return { ok: true };
    if (permissionMode === "bypassPermissions") return { ok: true };
    if (permissionMode === "acceptEdits" && EDIT_TOOL_NAMES.has(toolName)) {
      return { ok: true };
    }
    if (allowRulesMatch(allowRules ?? [], toolName, input)) return { ok: true };

    const resolution = await permissions.request({
      sessionId,
      tool: toolName,
      input,
      title: toolName,
      description,
      suggestions,
      signal,
    });
    return resolutionToGate(resolution, suggestions, permissions);
  };

  const codingTools = buildCodingTools({ cwd, signal, gate, onEvent });
  const orchestratorTools = isTopLevel
    ? buildOrchestratorTools({
        parentSessionId: sessionId,
        parentCwd: cwd,
        depth: depth ?? 0,
      })
    : {};

  // MCP servers configured in Claude's user state get spawned per-turn and
  // their tools merged in. Skipped for peer runs (consistent with Claude's
  // peer-spawn rules) and for non-top-level depth.
  const mcp = isTopLevel ? await loadMcpForVercel() : null;
  if (mcp && (mcp.loaded.length > 0 || mcp.failed.length > 0)) {
    const lines: string[] = [];
    if (mcp.loaded.length > 0) {
      lines.push(`loaded: ${mcp.loaded.join(", ")}`);
    }
    for (const f of mcp.failed) {
      lines.push(`failed: ${f.name} — ${f.reason}`);
    }
    onEvent({
      type: "tool_log",
      log: {
        name: "vercel: mcp",
        input: { servers: mcp.loaded.length + mcp.failed.length },
        output: lines.join("\n") || "(no mcp servers)",
        isError: mcp.failed.length > 0 && mcp.loaded.length === 0,
      },
    });
  }

  const tools: ToolSet = {
    ...(mcp?.tools ?? {}),
    ...orchestratorTools,
    // Coding tools last so they win on collision — never let an upstream
    // MCP server shadow our Bash/Read/Write contracts.
    ...codingTools,
  } as ToolSet;

  try {
    const result = streamText({
      model: languageModel,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(stepLimit),
      abortSignal: signal,
      // Stream errors are surfaced via the `error` part inside `fullStream`
      // below — adding an `onError` callback here would emit them twice.
    });

    // Per-block reasoning timer so we can emit a "thinking (Ns)" marker on
    // reasoning-end without leaking the raw chain-of-thought text.
    const reasoningStart = new Map<string, number>();
    // True once we've observed a final `finish` part. Without this guard a
    // dropped upstream connection produces an empty turn with no visible
    // error — the loop just exits cleanly. We surface that case below.
    let sawFinish = false;
    // Visibility counters so we can name *why* a turn ended. "No error, just
    // stopped" is the dominant failure mode of agent loops, and it's almost
    // always the model hitting finishReason=stop after one step.
    let stepIndex = 0;
    let lastStepFinishReason: string | undefined;

    for await (const part of result.fullStream) {
      onRaw?.(part);
      switch (part.type) {
        case "start-step": {
          stepIndex += 1;
          break;
        }

        case "finish-step": {
          lastStepFinishReason = part.finishReason;
          break;
        }

        case "text-delta": {
          if (part.text.length === 0) break;
          onEvent({ type: "text_delta", delta: part.text });
          break;
        }

        case "reasoning-start": {
          reasoningStart.set(part.id, Date.now());
          break;
        }
        case "reasoning-delta": {
          // Raw chain-of-thought intentionally dropped — same rationale as
          // claude.ts / codex.ts. The "> Thought (Ns)" marker fires on
          // reasoning-end.
          break;
        }
        case "reasoning-end": {
          const startedAt = reasoningStart.get(part.id);
          if (startedAt !== undefined) {
            reasoningStart.delete(part.id);
            onEvent({
              type: "thinking",
              seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
              text: "",
            });
          }
          break;
        }

        case "tool-input-start": {
          // Live "preparing tool" card. Without this the UI looks idle
          // between the model deciding to call a tool and the tool's own
          // execute() landing a tool_log — that gap can be 1–10s on slow
          // providers and reads as a freeze.
          onEvent({
            type: "tool_log",
            log: {
              id: `vercel:tool-input:${part.id}`,
              name: `${part.toolName} (preparing)`,
              output: "…",
            },
          });
          break;
        }

        case "tool-error": {
          // Tools throw inside their `execute` to signal an unrecoverable
          // call; the SDK catches and emits a tool-error part. Our tools
          // already emit a tool_log of their own before throwing, so this is
          // just a safety net for unexpected throws.
          onEvent({
            type: "error",
            message: `${part.toolName}: ${formatError(part.error)}`,
          });
          break;
        }

        case "abort": {
          // User-initiated stop. Don't emit an error row; mark `sawFinish`
          // so the post-loop guard doesn't double-report "stream ended
          // without finish".
          sawFinish = true;
          return;
        }

        case "error": {
          onEvent({
            type: "error",
            message: `vercel sdk: ${formatError(part.error)}`,
          });
          break;
        }

        case "finish": {
          sawFinish = true;
          const usage = part.totalUsage;
          if (usage) {
            onEvent({
              type: "usage",
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cacheRead: usage.cachedInputTokens ?? 0,
              cacheWrite: 0,
            });
          }
          // Bare "stop" is the happy path and stays silent. Anything else
          // ("length", "content-filter", "error", "tool-calls" without a
          // follow-up step, etc.) gets a one-line notice so the user knows
          // why the run ended without further output.
          if (part.finishReason && part.finishReason !== "stop") {
            onEvent({
              type: "tool_log",
              log: {
                name: "vercel: finish",
                input: { steps: stepIndex },
                output: `finishReason: ${part.finishReason}`,
              },
            });
          }
          break;
        }

        // tool-call / tool-result are emitted by the tools themselves via the
        // shared `emitToolLog` helper (which also captures execute() errors).
        // The SDK's own tool-result event arrives AFTER our emit and would
        // duplicate the card; drop them.
        default:
          break;
      }
    }

    if (!sawFinish) {
      onEvent({
        type: "error",
        message: `vercel sdk: stream ended after step ${stepIndex} without a finish event${
          lastStepFinishReason ? ` (last step: ${lastStepFinishReason})` : ""
        } — likely a dropped upstream connection`,
      });
    }

    const response = await result.response;
    // `response.messages` is the new tail (assistant turns + tool results);
    // append onto the messages we already sent. The cast is structural — v6
    // ResponseMessage is a subset of ModelMessage. If a provider-specific
    // content shape ever leaks through, that surfaces on the *next* turn
    // when streamText re-validates its `messages` input.
    const nextTail = response.messages as ModelMessage[];
    onMessages([...messages, ...nextTail]);
  } catch (err) {
    if (signal.aborted) return;
    onEvent({
      type: "error",
      message: `vercel sdk: ${formatError(err)}`,
    });
  } finally {
    // Close every MCP client we successfully opened, regardless of how
    // streamText exited. allSettled in vercel-mcp.ts isolates individual
    // close failures.
    if (mcp) {
      await mcp.close();
    }
  }
}

// Translate a PermissionStore resolution into our internal gate result.
// Side effect: when the user picks "allow always" and the request carried
// suggestion rules, persist them to the store so the next call doesn't ask.
function resolutionToGate(
  resolution: PermissionResolution,
  suggestions: string[],
  permissions: PermissionStore,
): { ok: true } | { ok: false; message: string } {
  if (resolution.decision === "deny") {
    return { ok: false, message: "denied by user" };
  }
  if (resolution.decision === "allow_always" && suggestions.length > 0) {
    permissions.addMany(suggestions);
  }
  return { ok: true };
}

// Match `rules` (e.g. "Bash", "Bash(npm install)") against a tool invocation.
// - bare "Bash" matches any Bash call
// - "Bash(pattern)" matches when the command/path includes the pattern
//   (substring, case-sensitive — same as the Claude SDK's wire-format match)
function allowRulesMatch(
  rules: string[],
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  for (const raw of rules) {
    const m = raw.match(/^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/s);
    if (!m) continue;
    if (m[1] !== toolName) continue;
    if (!m[2]) return true;
    const needle = m[2];
    const hay = inputSummary(toolName, input);
    if (hay.includes(needle)) return true;
  }
  return false;
}

function inputSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return String(input.command ?? "");
  if (toolName === "Read" || toolName === "Write") {
    return String(input.file_path ?? "");
  }
  return JSON.stringify(input);
}

type ToolDeps = {
  cwd: string;
  signal: AbortSignal;
  gate: (
    toolName: string,
    input: Record<string, unknown>,
    suggestions: string[],
    description: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onEvent: (ev: RunEvent) => void;
};

function buildCodingTools(deps: ToolDeps) {
  const { cwd, signal, gate, onEvent } = deps;
  return {
    Bash: tool({
      description:
        "Run a shell command inside the session's working directory. Use for grep/rg/find, build commands, git inspection, and other short read operations. Avoid long-running servers.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Shell command to execute"),
        description: z
          .string()
          .optional()
          .describe("Short human-readable summary shown in the UI"),
      }),
      execute: async (input) => {
        const decision = await gate(
          "Bash",
          { command: input.command },
          [`Bash(${input.command})`, "Bash"],
          input.description ?? input.command,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "Bash", { command: input.command }, decision.message, true);
          return { ok: false, error: decision.message };
        }
        const result = await runBash(input.command, cwd, signal);
        emitToolLog(
          onEvent,
          "Bash",
          { command: input.command },
          formatBashOutput(result),
          result.exitCode !== 0 || result.aborted,
        );
        return result.aborted
          ? { ok: false, error: "aborted" }
          : {
              ok: result.exitCode === 0,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            };
      },
    }),

    Read: tool({
      description:
        "Read a file from disk. Returns the entire file contents as text. Use absolute paths.",
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Absolute path to the file"),
      }),
      execute: async (input) => {
        const resolved = resolveCwdPath(cwd, input.file_path);
        const decision = await gate(
          "Read",
          { file_path: resolved },
          [`Read(${resolved})`, "Read"],
          resolved,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "Read", { file_path: resolved }, decision.message, true);
          return { ok: false, error: decision.message };
        }
        try {
          const content = await readFile(resolved, "utf8");
          emitToolLog(
            onEvent,
            "Read",
            { file_path: resolved },
            truncate(content, 4_000),
          );
          return { ok: true, content };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitToolLog(onEvent, "Read", { file_path: resolved }, message, true);
          return { ok: false, error: message };
        }
      },
    }),

    Write: tool({
      description:
        "Write content to a file, creating parent directories if needed. Overwrites existing files. Use absolute paths.",
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Absolute path to write"),
        content: z.string().describe("Full file contents"),
      }),
      execute: async (input) => {
        const resolved = resolveCwdPath(cwd, input.file_path);
        const decision = await gate(
          "Write",
          { file_path: resolved },
          [`Write(${resolved})`, "Write"],
          resolved,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "Write", { file_path: resolved }, decision.message, true);
          return { ok: false, error: decision.message };
        }
        try {
          await mkdir(path.dirname(resolved), { recursive: true });
          await writeFile(resolved, input.content, "utf8");
          emitToolLog(
            onEvent,
            "Write",
            { file_path: resolved },
            `wrote ${input.content.length} bytes`,
          );
          return { ok: true, bytes: input.content.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitToolLog(onEvent, "Write", { file_path: resolved }, message, true);
          return { ok: false, error: message };
        }
      },
    }),

    Edit: tool({
      description:
        "Replace the first occurrence (or all occurrences) of an exact string in a file. Returns an error if the search string isn't found. Use absolute paths.",
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Absolute path to the file to edit"),
        old_string: z.string().min(1).describe("Exact text to find — must match verbatim"),
        new_string: z.string().describe("Replacement text. Empty string deletes the match."),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every occurrence (default false)"),
      }),
      execute: async (input) => {
        const resolved = resolveCwdPath(cwd, input.file_path);
        const decision = await gate(
          "Edit",
          { file_path: resolved },
          [`Edit(${resolved})`, "Edit"],
          resolved,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "Edit", { file_path: resolved }, decision.message, true);
          return { ok: false, error: decision.message };
        }
        try {
          const content = await readFile(resolved, "utf8");
          if (!content.includes(input.old_string)) {
            const msg = "old_string not found in file";
            emitToolLog(onEvent, "Edit", { file_path: resolved }, msg, true);
            return { ok: false, error: msg };
          }
          const next = input.replace_all
            ? content.split(input.old_string).join(input.new_string)
            : content.replace(input.old_string, input.new_string);
          await writeFile(resolved, next, "utf8");
          const replacements = input.replace_all
            ? content.split(input.old_string).length - 1
            : 1;
          emitToolLog(
            onEvent,
            "Edit",
            { file_path: resolved },
            `replaced ${replacements} occurrence(s)`,
          );
          return { ok: true, replacements };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitToolLog(onEvent, "Edit", { file_path: resolved }, message, true);
          return { ok: false, error: message };
        }
      },
    }),

    MultiEdit: tool({
      description:
        "Apply a sequence of exact-string edits to one file atomically — if any edit fails to match, no changes are written. Edits apply in order.",
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Absolute path to the file"),
        edits: z
          .array(
            z.object({
              old_string: z.string().min(1),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1)
          .describe("Ordered list of edits to apply"),
      }),
      execute: async (input) => {
        const resolved = resolveCwdPath(cwd, input.file_path);
        const decision = await gate(
          "MultiEdit",
          { file_path: resolved },
          [`MultiEdit(${resolved})`, "MultiEdit"],
          resolved,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "MultiEdit", { file_path: resolved }, decision.message, true);
          return { ok: false, error: decision.message };
        }
        try {
          let content = await readFile(resolved, "utf8");
          let total = 0;
          for (const [i, e] of input.edits.entries()) {
            if (!content.includes(e.old_string)) {
              const msg = `edit ${i + 1}: old_string not found`;
              emitToolLog(onEvent, "MultiEdit", { file_path: resolved }, msg, true);
              return { ok: false, error: msg };
            }
            if (e.replace_all) {
              const before = content.split(e.old_string).length - 1;
              content = content.split(e.old_string).join(e.new_string);
              total += before;
            } else {
              content = content.replace(e.old_string, e.new_string);
              total += 1;
            }
          }
          await writeFile(resolved, content, "utf8");
          emitToolLog(
            onEvent,
            "MultiEdit",
            { file_path: resolved },
            `applied ${input.edits.length} edit(s), ${total} replacement(s)`,
          );
          return { ok: true, edits: input.edits.length, replacements: total };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitToolLog(onEvent, "MultiEdit", { file_path: resolved }, message, true);
          return { ok: false, error: message };
        }
      },
    }),

    Grep: tool({
      description:
        "Search files using ripgrep. Returns matching lines with file:line prefixes. Use `pattern` for the regex, `path` to scope the search.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Regex pattern (PCRE2-ish, ripgrep syntax)"),
        path: z
          .string()
          .optional()
          .describe("Directory or file to search within (default: cwd)"),
        glob: z
          .string()
          .optional()
          .describe('File glob filter, e.g. "*.ts" — passed to rg --glob'),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().min(1).max(1000).optional(),
      }),
      execute: async (input) => {
        // Grep is read-only; gate as "Read" so a single Read allow-rule
        // covers all read-style tools.
        const decision = await gate(
          "Grep",
          { pattern: input.pattern, path: input.path },
          [`Grep(${input.pattern})`, "Grep"],
          `rg ${input.pattern}${input.path ? ` ${input.path}` : ""}`,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "Grep", input as Record<string, unknown>, decision.message, true);
          return { ok: false, error: decision.message };
        }
        const args = ["--line-number", "--with-filename", "--no-heading"];
        if (input.case_insensitive) args.push("-i");
        if (input.glob) args.push("--glob", input.glob);
        args.push("--max-count", String(input.max_results ?? 200));
        args.push("--", input.pattern);
        if (input.path) args.push(resolveCwdPath(cwd, input.path));
        const result = await runChild("rg", args, cwd, signal);
        emitToolLog(
          onEvent,
          "Grep",
          { pattern: input.pattern, path: input.path },
          truncate(result.stdout || "(no matches)", 4_000),
          // rg exits 1 when there are no matches — that's success, not error.
          result.exitCode > 1 || result.aborted,
        );
        return {
          ok: result.exitCode <= 1 && !result.aborted,
          matches: result.stdout,
          exitCode: result.exitCode,
        };
      },
    }),

    Glob: tool({
      description:
        "List files matching a glob pattern (e.g. `src/**/*.ts`). Use to discover paths before reading.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Glob pattern, evaluated by `find` and `bash`"),
        path: z
          .string()
          .optional()
          .describe("Base directory (default: cwd)"),
      }),
      execute: async (input) => {
        const decision = await gate(
          "Glob",
          { pattern: input.pattern, path: input.path },
          [`Glob(${input.pattern})`, "Glob"],
          input.pattern,
        );
        if (!decision.ok) {
          emitToolLog(onEvent, "Glob", input as Record<string, unknown>, decision.message, true);
          return { ok: false, error: decision.message };
        }
        const base = input.path ? resolveCwdPath(cwd, input.path) : cwd;
        // Use bash's globstar expansion so `**` matches across directories.
        // Quote the base; let the shell glob the pattern.
        const cmd = `shopt -s globstar nullglob dotglob 2>/dev/null; cd "${base.replace(/"/g, '\\"')}" && ls -1d ${input.pattern} 2>/dev/null | head -1000`;
        const result = await runBash(cmd, cwd, signal);
        const matches = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        emitToolLog(
          onEvent,
          "Glob",
          { pattern: input.pattern, path: input.path },
          matches.length === 0 ? "(no matches)" : matches.slice(0, 100).join("\n"),
          result.aborted,
        );
        return { ok: !result.aborted, matches };
      },
    }),

    TodoWrite: tool({
      description:
        "Maintain a running todo list. Pass the full list each call — the renderer dedupes by name so callers can update statuses without juggling ids. Use to plan multi-step work.",
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              text: z.string().min(1),
              status: z
                .enum(["pending", "in_progress", "completed"])
                .default("pending"),
            }),
          )
          .min(1),
      }),
      execute: async (input) => {
        const done = input.todos.filter((t) => t.status === "completed").length;
        const body = input.todos
          .map((t) => {
            const mark =
              t.status === "completed"
                ? "x"
                : t.status === "in_progress"
                  ? "~"
                  : " ";
            return `[${mark}] ${t.text}`;
          })
          .join("\n");
        onEvent({
          type: "tool_log",
          log: {
            id: "vercel:todo",
            name: "TodoWrite",
            input: { count: input.todos.length, completed: done },
            output: body,
          },
        });
        return { ok: true, count: input.todos.length, completed: done };
      },
    }),
  };
}

// Orchestrator tools: delegate to peer agents, validate work, manage Tasks.
// Only exposed for top-level (depth=0) vercel sessions — peer-spawned
// vercel runs (via delegate_run from a claude/codex parent) don't see
// these, same way peer claude runs aren't given the orchestrator MCP.
//
// Each tool is a thin wrapper around the pure execute* / task helpers in
// delegate.ts / tasks.ts. No permission gating: the model's choice to
// spawn a peer is an architectural one, not a security-sensitive
// filesystem op — Claude's orchestrator MCP isn't gated either.
type OrchestratorDeps = {
  parentSessionId: string;
  parentCwd: string;
  depth: number;
};

function buildOrchestratorTools(deps: OrchestratorDeps): ToolSet {
  const ctx = {
    parentRunner: "vercel" as RunnerKind,
    parentSessionId: deps.parentSessionId,
    parentCwd: deps.parentCwd,
    depth: deps.depth,
  };

  return {
    delegate_run: tool({
      description:
        "Spawn a peer agent (claude, codex, or vercel — must differ from this runner) with a natural-language task. By default waits for completion and returns the peer's final text. Set wait=false to return immediately with a runId you can poll via get_run.",
      inputSchema: z.object({
        profileName: z.enum(["claude", "codex", "vercel"]),
        prompt: z.string().min(1),
        sessionId: z.string().optional(),
        wait: z.boolean().default(true),
        timeoutSec: z.number().int().min(1).max(600).default(120),
      }),
      execute: async (input) => {
        const result = await executeDelegate(
          {
            profileName: input.profileName,
            prompt: input.prompt,
            sessionId: input.sessionId,
            wait: input.wait,
            timeoutSec: input.timeoutSec,
          },
          ctx,
        );
        return result.payload;
      },
    }),

    get_run: tool({
      description:
        "Fetch the current status (and result, if finished) of a peer run started with delegate_run.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => executeGetRun(runId).payload,
    }),

    cancel_run: tool({
      description:
        "Cancel a peer run started with delegate_run. No-op if the run has already finished.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => executeCancelRun(runId).payload,
    }),

    validate_run: tool({
      description:
        "Adversarial peer review of your just-completed work. Call as the FINAL step before declaring a task done. A peer agent reads the repo, looks for flaws in your claim, and returns a structured verdict (pass / fail / needs_changes) plus an issues list.",
      inputSchema: z.object({
        peer: z.enum(["claude", "codex", "vercel"]).optional(),
        claim: z.string().min(1),
        context: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        focus: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(600).default(180),
      }),
      execute: async (input) => {
        const result = await executeValidate(input, ctx);
        return result.payload;
      },
    }),

    task_create: tool({
      description:
        "Open a Task. Returns a taskId you pass to task_spawn / task_await / task_done. A Task groups parallel SubTasks under a single live tool card.",
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
      }),
      execute: async ({ title, description }) => {
        const task = createTask({
          sessionId: deps.parentSessionId,
          title,
          description,
        });
        return { taskId: task.id };
      },
    }),

    task_spawn: tool({
      description:
        "Append SubTasks to a Task and start them in parallel under maxConcurrent. Non-blocking. Each SubTask is a peer agent run.",
      inputSchema: z.object({
        taskId: z.string(),
        subtasks: z
          .array(
            z.object({
              runner: z.enum(["claude", "codex", "vercel"]),
              prompt: z.string().min(1),
              sessionId: z.string().optional(),
            }),
          )
          .min(1),
        maxConcurrent: z.number().int().min(1).max(16).default(4),
        timeoutSec: z.number().int().min(1).max(3600).default(600),
      }),
      execute: async (input) => {
        const r = spawnSubtasks(
          input.taskId,
          input.subtasks,
          {
            parentRunner: ctx.parentRunner,
            parentCwd: ctx.parentCwd,
            depth: ctx.depth + 1,
            timeoutSec: input.timeoutSec,
          },
          { maxConcurrent: input.maxConcurrent },
        );
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, subtaskIds: r.subtaskIds };
      },
    }),

    task_await: tool({
      description:
        "Block until every non-terminal SubTask of the Task settles. Returns aggregated results (each SubTask's final text + status).",
      inputSchema: z.object({
        taskId: z.string(),
        timeoutSec: z.number().int().min(1).max(3600).default(1200),
      }),
      execute: async ({ taskId, timeoutSec }) => {
        const r = await awaitTask(taskId, { timeoutSec });
        if (!r.ok) return { ok: false, error: r.error };
        return r;
      },
    }),

    task_observe: tool({
      description:
        "Non-blocking peek at a Task's current state and partial SubTask results.",
      inputSchema: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => {
        const r = observeTask(taskId);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, snapshot: r.snapshot };
      },
    }),

    task_done: tool({
      description:
        "Mark a Task complete with an optional summary. Errors if any SubTask is still running — call task_await or task_cancel first.",
      inputSchema: z.object({
        taskId: z.string(),
        summary: z.string().optional(),
      }),
      execute: async ({ taskId, summary }) => {
        const r = doneTask(taskId, summary);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, taskId: r.taskId, status: r.status };
      },
    }),

    task_cancel: tool({
      description:
        "Cancel a Task and abort every running SubTask under it.",
      inputSchema: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => {
        const r = cancelTask(taskId);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, taskId: r.taskId, cancelled: r.cancelled };
      },
    }),
  };
}

// Run an arbitrary child process and capture stdout/stderr. Used by Grep
// (rg) and any future fixed-command tools; Bash uses its own wrapper that
// goes through `bash -lc` for shell features.
function runChild(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<BashResult> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: 130, aborted: true });
      return;
    }
    const child = spawn(command, args, { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        stdout,
        stderr: stderr ? `${stderr}\n${message}` : message,
        exitCode: 127,
        aborted: signal.aborted,
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        aborted: signal.aborted,
      });
    });
  });
}

type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted: boolean;
};

function runBash(command: string, cwd: string, signal: AbortSignal): Promise<BashResult> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: 130, aborted: true });
      return;
    }
    const child = spawn("bash", ["-lc", command], { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        stdout,
        stderr: stderr ? `${stderr}\n${message}` : message,
        exitCode: 1,
        aborted: signal.aborted,
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        aborted: signal.aborted,
      });
    });
  });
}

function formatBashOutput(r: BashResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(truncate(r.stdout, 4_000));
  if (r.stderr) parts.push(`[stderr]\n${truncate(r.stderr, 2_000)}`);
  if (r.aborted) parts.push("[aborted]");
  else if (r.exitCode !== 0) parts.push(`[exit ${r.exitCode}]`);
  return parts.join("\n") || "(no output)";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${s.length - max} more bytes]`;
}

function resolveCwdPath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function emitToolLog(
  onEvent: (ev: RunEvent) => void,
  name: string,
  input: Record<string, unknown>,
  output: unknown,
  isError = false,
): void {
  onEvent({ type: "tool_log", log: { name, input, output, isError } });
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Route a bare model id to the right Vercel AI SDK provider:
//   - claude-*     -> @ai-sdk/anthropic  (needs ANTHROPIC_API_KEY)
//   - everything else (gpt-*, o*-*, etc.) -> @ai-sdk/openai (needs OPENAI_API_KEY)
//
// The bracket-suffixed Claude variants used by the native Claude SDK
// (e.g. "claude-opus-4-7[1m]") aren't part of the Anthropic API model id
// surface — the suffix is the Claude SDK's context-window selector. Strip
// it before handing off, so picking the "1M context" entry in the picker
// just selects the base model on the Vercel runner. (The Vercel runner has
// no equivalent knob; users who need 1M context should stay on the Claude
// runner.)
type ResolveResult =
  | { ok: true; model: LanguageModel }
  | { ok: false; message: string };

function resolveProvider(modelId: string): ResolveResult {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return { ok: false, message: "vercel: empty model id" };
  }
  if (trimmed.startsWith("claude-")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        message:
          "ANTHROPIC_API_KEY is not set. Add it to server/.env to use Claude models with the vercel runner.",
      };
    }
    const stripped = trimmed.replace(/\[[^\]]*\]\s*$/, "");
    return { ok: true, model: anthropic(stripped) };
  }
  // Default: assume OpenAI. Covers gpt-*, o1*, o3*, future generations.
  if (!process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      message:
        "OPENAI_API_KEY is not set. Add it to server/.env to use OpenAI models with the vercel runner.",
    };
  }
  return { ok: true, model: openai(trimmed) };
}
