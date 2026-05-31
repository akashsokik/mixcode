import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ModelMessage } from "ai";

import {
  buildRequestMessages,
  buildVercelProviderOptions,
  buildVercelTurnUsage,
} from "./vercel.js";

const systemMessage: ModelMessage = {
  role: "system",
  content: "system + tools",
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
};

function hasBreakpoint(m: ModelMessage | undefined): boolean {
  const a = (m?.providerOptions as any)?.anthropic;
  return a?.cacheControl?.type === "ephemeral";
}

describe("buildRequestMessages (conversation cache breakpoint)", () => {
  test("places the breakpoint on the last prior message, not the new prompt", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "turn 1 question" },
      { role: "assistant", content: "turn 1 answer" },
      { role: "user", content: "turn 2 question (new)" },
    ];
    const out = buildRequestMessages(systemMessage, messages);

    // [system, u1, a1, u2] — breakpoint on a1 (the tail of the prior turn).
    assert.equal(out.length, 4);
    assert.ok(hasBreakpoint(out[0]), "system keeps its own breakpoint");
    assert.ok(hasBreakpoint(out[2]), "last prior message gets a breakpoint");
    assert.equal(hasBreakpoint(out[3]), false, "new prompt is the uncached suffix");
  });

  test("does not mutate the input messages array or its elements", () => {
    const lastPrior: ModelMessage = { role: "assistant", content: "prior answer" };
    const messages: ModelMessage[] = [
      { role: "user", content: "q1" },
      lastPrior,
      { role: "user", content: "new q" },
    ];
    buildRequestMessages(systemMessage, messages);

    // Persistence isolation: the array the caller persists via onMessages must
    // never gain provider metadata, or the breakpoint accumulates every turn.
    assert.equal(messages.length, 3);
    assert.equal(hasBreakpoint(lastPrior), false);
    assert.equal(lastPrior.providerOptions, undefined);
  });

  test("first turn (no prior history) adds no extra breakpoint", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "first prompt" }];
    const out = buildRequestMessages(systemMessage, messages);

    // [system, userPrompt] — only system carries a breakpoint.
    assert.equal(out.length, 2);
    assert.ok(hasBreakpoint(out[0]));
    assert.equal(hasBreakpoint(out[1]), false);
  });

  test("merges with existing providerOptions on the tail message", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "prior",
        providerOptions: { openai: { reasoningEffort: "high" } as any },
      },
      { role: "user", content: "new q" },
    ];
    const out = buildRequestMessages(systemMessage, messages);
    const opts = (out[1].providerOptions as any) ?? {};
    assert.ok(hasBreakpoint(out[1]), "anthropic breakpoint added");
    assert.deepEqual(opts.openai, { reasoningEffort: "high" }, "openai opts preserved");
  });
});

describe("buildVercelTurnUsage", () => {
  test("reads cache read AND write tokens from inputTokenDetails", () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 200,
      inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 150 },
    };
    const out = buildVercelTurnUsage(usage as any, "claude-sonnet-4-5");
    assert.equal(out.cacheRead, 800);
    assert.equal(out.cacheWrite, 150, "cache-creation tokens are no longer dropped");
    assert.equal(out.input, 1000);
    assert.equal(out.output, 200);
    assert.equal(out.model, "claude-sonnet-4-5");
  });

  test("falls back to deprecated cachedInputTokens when details are absent", () => {
    const usage = { inputTokens: 500, outputTokens: 50, cachedInputTokens: 400 };
    const out = buildVercelTurnUsage(usage as any, "gpt-4o");
    assert.equal(out.cacheRead, 400);
    assert.equal(out.cacheWrite, 0);
  });

  test("defaults every field to 0 for undefined usage", () => {
    const out = buildVercelTurnUsage(undefined, "gpt-4o");
    assert.deepEqual(
      { i: out.input, o: out.output, r: out.cacheRead, w: out.cacheWrite },
      { i: 0, o: 0, r: 0, w: 0 },
    );
  });
});

describe("buildVercelProviderOptions (OpenAI prompt-cache routing)", () => {
  test("sets a stable promptCacheKey from the sessionId for OpenAI models", () => {
    const opts = buildVercelProviderOptions({ modelId: "gpt-4o", sessionId: "sess-123" });
    assert.equal((opts as any)?.openai?.promptCacheKey, "sess-123");
    assert.equal((opts as any)?.openai?.reasoningEffort, undefined);
  });

  test("includes reasoningEffort alongside the cache key when effort is set", () => {
    const opts = buildVercelProviderOptions({
      modelId: "gpt-5",
      effort: "high",
      sessionId: "sess-9",
    });
    assert.equal((opts as any)?.openai?.promptCacheKey, "sess-9");
    assert.equal((opts as any)?.openai?.reasoningEffort, "high");
  });

  test("drops the unsupported 'max' effort but keeps the cache key", () => {
    const opts = buildVercelProviderOptions({
      modelId: "gpt-5",
      effort: "max",
      sessionId: "sess-9",
    });
    assert.equal((opts as any)?.openai?.promptCacheKey, "sess-9");
    assert.equal((opts as any)?.openai?.reasoningEffort, undefined);
  });

  test("returns undefined for Anthropic models (breakpoints handle caching)", () => {
    const opts = buildVercelProviderOptions({
      modelId: "claude-sonnet-4-5",
      effort: "high",
      sessionId: "sess-9",
    });
    assert.equal(opts, undefined);
  });
});
