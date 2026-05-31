// Ollama runner. Drives a local Ollama daemon through its OpenAI-compatible
// /v1 endpoint via @ai-sdk/openai's chat-completions path, reusing the Vercel
// runner's hand-rolled coding toolkit (Bash/Read/Write/Edit/MultiEdit/Grep/
// Glob/TodoWrite) and the same shared PermissionStore gate. The point is a
// free, local, token-burn-free runner for testing — so it is a deliberate
// subset of the Vercel runner: coding tools plus workflow authoring, no peer
// orchestrator tools (delegate/validate/task_*), no MCP, and not
// consensus-eligible.
//
// Ollama implements the Chat Completions API, NOT OpenAI's newer Responses
// API that the default `openai()` helper targets — so we construct the client
// with `.chat(modelId)`. Session continuity is process-local: streamText is
// stateless, so the caller passes the prior ModelMessage[] back on every turn
// and reads the new tail out of onMessages (persisted in
// SessionManager.runtime.ollamaMessages).

import { createOpenAI } from "@ai-sdk/openai";
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from "ai";

import type {
  ClaudePermissionMode,
  ContextUsage,
  RunEvent,
  TurnUsage,
} from "../../../shared/events.js";
import type { PermissionStore } from "../permissions.js";
import type { WorkflowProposedHandler } from "../orchestrator/workflow-tools.js";
import {
  buildWorkflowAiTools,
  buildBaseSystemPrompt,
  buildCodingTools,
  buildGate,
  formatError,
} from "./vercel.js";

// Ollama daemon's OpenAI-compatible base URL. Override with OLLAMA_BASE_URL
// (e.g. a remote box). No API key is required, but the OpenAI SDK insists on a
// non-empty one, so we pass a placeholder.
const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

// The native model-listing endpoint (/api/tags) lives at the daemon root, not
// under the OpenAI-compat /v1 path — strip the suffix to reach it.
function ollamaHostBase(): string {
  return BASE_URL.replace(/\/v1\/?$/, "");
}

type OllamaTag = {
  name: string;
  details?: { family?: string; families?: string[] };
};

// Embedding-only models (e.g. nomic-embed-text, family "nomic-bert") can't
// drive a chat/tool loop, so they're excluded from the picker.
function isEmbeddingModel(tag: OllamaTag): boolean {
  const fams = [tag.details?.family, ...(tag.details?.families ?? [])]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  const blob = [String(tag.name).toLowerCase(), ...fams].join(" ");
  return /embed|bert|nomic/.test(blob);
}

// Live list of pulled chat models from the local daemon, embedding models
// dropped and sorted by name. Throws on transport failure (daemon down) so
// callers can surface a connection hint. Nothing about the model set is
// hardcoded — this is the single source of truth for "what can I run".
export async function listOllamaModels(): Promise<string[]> {
  const res = await fetch(`${ollamaHostBase()}/api/tags`);
  if (!res.ok) {
    throw new Error(`ollama /api/tags returned ${res.status}`);
  }
  const data = (await res.json()) as { models?: OllamaTag[] };
  const tags = Array.isArray(data.models) ? data.models : [];
  return tags
    .filter((t) => t && typeof t.name === "string" && !isEmbeddingModel(t))
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
}

// Auto-pick preference for the no-override default: families that drive the
// tool/agent loop well, best first. This does NOT filter or hardcode the model
// LIST (the picker still shows every pulled model) — it only stops a fresh
// session from defaulting to a tiny chat-only model (e.g. gemma3:270m) that
// would fail the agentic loop. Unmatched models rank last, alphabetically.
const DEFAULT_MODEL_PREFERENCE: RegExp[] = [
  /^qwen2\.5-coder/i,
  /^qwen3/i,
  /^qwen/i,
  /^gpt-oss/i,
  /^codestral/i,
  /^deepseek-coder/i,
  /^llama3/i,
  /^mistral/i,
];

export function pickDefaultModel(models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  const rank = (name: string): number => {
    const i = DEFAULT_MODEL_PREFERENCE.findIndex((re) => re.test(name));
    return i === -1 ? DEFAULT_MODEL_PREFERENCE.length : i;
  };
  return [...models].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a.localeCompare(b);
  })[0];
}

// Bound the agent loop so a runaway tool-call cycle can't spin forever. Local
// inference is slow, so the practical ceiling is lower than a hosted model's;
// expose via env so power users can lift it.
const STEP_LIMIT = (() => {
  const v = process.env.OLLAMA_MAX_STEPS;
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

// Ollama doesn't report a per-model context window over the OpenAI-compat API.
// Map the common local models to their published native windows so the rail
// can show a Ctx %; fall back to a conservative default for anything else.
const OLLAMA_CONTEXT_WINDOWS: Record<string, number> = {
  "qwen3:8b": 32_768,
  "gpt-oss:20b": 131_072,
  "llama3.2:1b": 131_072,
  "llama3.2:3b": 131_072,
  "gemma3:270m": 32_768,
};
const DEFAULT_WINDOW = 32_768;

function ollamaWindowFor(model: string): number {
  return OLLAMA_CONTEXT_WINDOWS[model] ?? DEFAULT_WINDOW;
}

export type OllamaRunArgs = {
  prompt: string;
  cwd: string;
  // Prior turns' ModelMessages, passed back in for continuity. The caller
  // reads the new tail out of onMessages and persists it for next turn.
  priorMessages: ModelMessage[];
  model?: string;
  signal: AbortSignal;
  sessionId: string;
  permissionMode?: ClaudePermissionMode;
  permissions?: PermissionStore;
  allowRules?: string[];
  onWorkflowProposed?: WorkflowProposedHandler;
  // Per-call override of STEP_LIMIT.
  maxSteps?: number;
  onEvent: (ev: RunEvent) => void;
  onTurnUsage?: (usage: TurnUsage) => void;
  onContextUsage?: (ctx: ContextUsage | null) => void;
  onMessages: (messages: ModelMessage[]) => void;
  onRaw?: (msg: unknown) => void;
};

export async function runOllama(args: OllamaRunArgs): Promise<void> {
  const {
    prompt,
    cwd,
    priorMessages,
    model,
    signal,
    sessionId,
    permissionMode,
    permissions,
    allowRules,
    onWorkflowProposed,
    maxSteps,
    onEvent,
    onTurnUsage,
    onContextUsage,
    onMessages,
    onRaw,
  } = args;

  const stepLimit =
    typeof maxSteps === "number" && maxSteps > 0 ? maxSteps : STEP_LIMIT;

  // Resolve the model: explicit /model override or OLLAMA_MODEL pin wins;
  // otherwise auto-pick the first pulled model from the daemon. No hardcoded
  // default — if nothing is pulled, tell the user to pull one.
  let modelId = model || process.env.OLLAMA_MODEL;
  if (!modelId) {
    let available: string[];
    try {
      available = await listOllamaModels();
    } catch (err) {
      onEvent({ type: "error", message: friendlyError(err) });
      return;
    }
    if (available.length === 0) {
      onEvent({
        type: "error",
        message:
          "No Ollama models pulled. Run `ollama pull <model>` (e.g. `ollama pull qwen3:8b`), then retry.",
      });
      return;
    }
    modelId = pickDefaultModel(available) ?? available[0];
  }

  const provider = createOpenAI({ baseURL: BASE_URL, apiKey: "ollama" });
  const languageModel = provider.chat(modelId);

  // Keep the system prompt coding-focused. /workflow injects the authoring
  // instructions explicitly, and Ollama exposes only workflow_* from the
  // orchestrator family.
  const system = buildBaseSystemPrompt(cwd, false);

  const messages: ModelMessage[] = [
    ...priorMessages,
    { role: "user", content: prompt },
  ];

  const gate = buildGate({
    permissions,
    permissionMode,
    allowRules,
    sessionId,
    signal,
  });
  const tools = {
    ...buildWorkflowAiTools({
      parentSessionId: sessionId,
      parentRunner: "ollama",
      onWorkflowProposed,
    }),
    ...buildCodingTools({ cwd, signal, gate, onEvent }),
  } as ToolSet;

  try {
    const result = streamText({
      model: languageModel,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(stepLimit),
      abortSignal: signal,
    });

    const reasoningStart = new Map<string, number>();
    let sawFinish = false;
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
          // Raw chain-of-thought intentionally dropped; the "> Thought (Ns)"
          // marker fires on reasoning-end.
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
          onEvent({
            type: "tool_log",
            log: {
              id: `ollama:tool-input:${part.id}`,
              name: `${part.toolName} (preparing)`,
              output: "...",
            },
          });
          break;
        }
        case "tool-error": {
          onEvent({
            type: "error",
            message: `${part.toolName}: ${formatError(part.error)}`,
          });
          break;
        }
        case "abort": {
          sawFinish = true;
          return;
        }
        case "error": {
          onEvent({
            type: "error",
            message: friendlyError(part.error),
          });
          break;
        }
        case "finish": {
          sawFinish = true;
          const usage = part.totalUsage;
          if (usage) {
            const turnUsage: TurnUsage = {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cacheRead: usage.cachedInputTokens ?? 0,
              cacheWrite: 0,
              // Local inference is free.
              costUsd: 0,
              model: modelId,
            };
            onTurnUsage?.(turnUsage);
            if (onContextUsage) {
              const window = ollamaWindowFor(modelId);
              const loaded = turnUsage.input + turnUsage.cacheRead;
              const pct = (loaded / window) * 100;
              onContextUsage({
                totalTokens: loaded,
                maxTokens: window,
                percentage: Math.round(Math.min(100, pct) * 10) / 10,
              });
            }
          }
          if (part.finishReason && part.finishReason !== "stop") {
            onEvent({
              type: "tool_log",
              log: {
                name: "ollama: finish",
                input: { steps: stepIndex },
                output: `finishReason: ${part.finishReason}`,
              },
            });
          }
          break;
        }
        default:
          break;
      }
    }

    if (!sawFinish) {
      onEvent({
        type: "error",
        message: `ollama: stream ended after step ${stepIndex} without a finish event${
          lastStepFinishReason ? ` (last step: ${lastStepFinishReason})` : ""
        } - is the daemon still running?`,
      });
    }

    const response = await result.response;
    const nextTail = response.messages as ModelMessage[];
    onMessages([...messages, ...nextTail]);
  } catch (err) {
    if (signal.aborted) return;
    onEvent({ type: "error", message: friendlyError(err) });
  }
}

// Turn a raw transport failure into an actionable hint. The dominant first-run
// failure is the daemon not being up, which surfaces as a fetch/ECONNREFUSED
// error rather than anything model-related.
function friendlyError(err: unknown): string {
  const msg = formatError(err);
  const cause =
    err && typeof err === "object" && "cause" in err
      ? formatError((err as { cause: unknown }).cause)
      : "";
  const blob = `${msg} ${cause}`.toLowerCase();
  if (
    blob.includes("econnrefused") ||
    blob.includes("fetch failed") ||
    blob.includes("connection refused") ||
    blob.includes("connect econn")
  ) {
    return `Ollama daemon not reachable at ${BASE_URL}. Start it with \`ollama serve\` (and pull the model with \`ollama pull <model>\`).`;
  }
  return `ollama: ${msg}`;
}
