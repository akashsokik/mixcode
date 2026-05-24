// A Worker is the smallest unit of "do one thing with Claude" — a single
// messages.create call (optionally with prompt caching), wrapped in retry-
// with-backoff for 429 / overloaded responses. It is intentionally NOT a
// full agent loop: no tool use, no multi-turn, no session state. Use the
// regular Agent SDK `query()` when you need those.
//
// The point of going through the raw Anthropic SDK rather than the Agent
// SDK is weight: at 100s of concurrent calls, the per-call setup of an
// agent loop, working directory, MCP transport, etc. dominates. A
// messages.create coroutine is essentially a fetch + JSON parse.

import Anthropic from "@anthropic-ai/sdk";

export type WorkerRequest = {
  // System text. If shared across many workers, set `cache: true` so we
  // attach an ephemeral cache_control breakpoint — the 2nd+ call pays 10%
  // input tokens for the cached portion and doesn't burn ITPM.
  system?: string;
  cache?: boolean;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type WorkerResult = {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  stopReason: string | null;
  attempts: number;
  model: string;
};

export interface Worker {
  run(req: WorkerRequest): Promise<WorkerResult>;
}

export type AnthropicWorkerOptions = {
  client?: Anthropic;
  defaultModel?: string;
  defaultMaxTokens?: number;
  // Max retries on 429 / 5xx / overloaded_error. Backoff is exponential
  // with jitter: 2^attempt * base + rand(0, base). Capped at maxBackoffMs.
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class AnthropicWorker implements Worker {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(opts: AnthropicWorkerOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  async run(req: WorkerRequest): Promise<WorkerResult> {
    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;

    // System is sent as a content block array when caching is requested so we
    // can attach cache_control. The bare-string form is fine when no cache.
    const system = req.system
      ? req.cache
        ? [
            {
              type: "text" as const,
              text: req.system,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : req.system
      : undefined;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const msg = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          ...(system !== undefined ? { system } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          messages: [{ role: "user", content: req.prompt }],
        });

        // Collapse content blocks into a single string. We don't support tool
        // use here — workers are single-shot completions.
        const text = msg.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");

        return {
          text,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
          },
          stopReason: msg.stop_reason ?? null,
          attempts: attempt + 1,
          model,
        };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxRetries) throw err;
        const delay = this.computeBackoff(attempt, err);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  private computeBackoff(attempt: number, err: unknown): number {
    // Honor server-provided Retry-After when present. Anthropic SDK puts the
    // header value into `error.headers['retry-after']` (seconds) on 429.
    const retryAfter = retryAfterMs(err);
    if (retryAfter !== null) {
      return Math.min(retryAfter, this.maxBackoffMs);
    }
    const exp = this.baseBackoffMs * 2 ** attempt;
    const jitter = Math.random() * this.baseBackoffMs;
    return Math.min(exp + jitter, this.maxBackoffMs);
  }
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; error?: { type?: string } };
  if (e.status === 429) return true;
  if (typeof e.status === "number" && e.status >= 500 && e.status < 600) return true;
  if (e.error?.type === "overloaded_error") return true;
  return false;
}

function retryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { headers?: Record<string, string> }).headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
