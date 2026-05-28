import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";

import { listOllamaModels, pickDefaultModel } from "./ollama.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("listOllamaModels", () => {
  test("drops embedding models and sorts by name", async () => {
    mockFetch({
      models: [
        { name: "qwen3:8b", details: { family: "qwen3", families: ["qwen3"] } },
        { name: "gpt-oss:20b", details: { family: "gptoss", families: ["gptoss"] } },
        {
          name: "nomic-embed-text:latest",
          details: { family: "nomic-bert", families: ["nomic-bert"] },
        },
        { name: "llama3.2:1b", details: { family: "llama", families: ["llama"] } },
      ],
    });
    const models = await listOllamaModels();
    assert.deepEqual(models, ["gpt-oss:20b", "llama3.2:1b", "qwen3:8b"]);
  });

  test("returns empty list when the daemon has no models", async () => {
    mockFetch({ models: [] });
    assert.deepEqual(await listOllamaModels(), []);
  });

  test("throws on a non-ok response so callers can surface a hint", async () => {
    mockFetch({}, 500);
    await assert.rejects(() => listOllamaModels());
  });
});

describe("pickDefaultModel", () => {
  test("skips a tiny chat model in favor of a tool-capable one", () => {
    // Alphabetical-first would be gemma3:270m; the preference must beat it.
    const picked = pickDefaultModel([
      "gemma3:270m",
      "gpt-oss:20b",
      "llama3.2:1b",
      "qwen3:8b",
    ]);
    assert.equal(picked, "qwen3:8b");
  });

  test("prefers a code-tuned qwen over plain qwen3", () => {
    const picked = pickDefaultModel(["qwen3:8b", "qwen2.5-coder:7b"]);
    assert.equal(picked, "qwen2.5-coder:7b");
  });

  test("falls back to alphabetical when nothing matches the preference", () => {
    assert.equal(pickDefaultModel(["zeta:1b", "alpha:1b"]), "alpha:1b");
  });

  test("returns undefined for an empty list", () => {
    assert.equal(pickDefaultModel([]), undefined);
  });
});
