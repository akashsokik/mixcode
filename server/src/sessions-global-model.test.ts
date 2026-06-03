import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "./sessions.js";
import { TranscriptLogger } from "./transcript.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function freshManager(): { mgr: SessionManager; storePath: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adv-sessions-"));
  tmpDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  const mgr = new SessionManager(storePath, new TranscriptLogger(path.join(dir, "tx")));
  return { mgr, storePath, dir };
}

describe("global model defaults", () => {
  test("set, get, and reset round-trip in memory", () => {
    const { mgr } = freshManager();
    assert.equal(mgr.getGlobalModel("ollama"), undefined);

    mgr.setGlobalModel("ollama", "qwen3:8b");
    assert.equal(mgr.getGlobalModel("ollama"), "qwen3:8b");
    assert.deepEqual(mgr.getGlobalModels(), { ollama: "qwen3:8b" });

    // Whitespace-only clears, matching setModel semantics.
    mgr.setGlobalModel("ollama", "   ");
    assert.equal(mgr.getGlobalModel("ollama"), undefined);

    mgr.setGlobalModel("claude", "claude-opus-4-8");
    mgr.setGlobalModel("claude", null);
    assert.equal(mgr.getGlobalModel("claude"), undefined);
  });

  test("trims the stored value", () => {
    const { mgr } = freshManager();
    mgr.setGlobalModel("ollama", "  qwen3:8b  ");
    assert.equal(mgr.getGlobalModel("ollama"), "qwen3:8b");
  });

  test("setGlobalModel broadcasts the full map", () => {
    const { mgr } = freshManager();
    const seen: unknown[] = [];
    // Minimal WSContext stand-in: only send() is used by broadcast.
    mgr.subscribe({ send: (p: string) => seen.push(JSON.parse(p)) } as never);

    mgr.setGlobalModel("ollama", "qwen3:8b");
    const update = seen.find(
      (m): m is { type: string; globalModels: Record<string, string> } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "global_models_updated",
    );
    assert.ok(update, "expected a global_models_updated broadcast");
    assert.deepEqual(update.globalModels, { ollama: "qwen3:8b" });
  });

  test("persists across a reload from the same store file", () => {
    const { mgr, storePath, dir } = freshManager();
    mgr.setGlobalModel("ollama", "qwen3:8b");
    mgr.setGlobalModel("claude", "claude-opus-4-8");
    mgr.flush();

    const reloaded = new SessionManager(storePath, new TranscriptLogger(path.join(dir, "tx2")));
    assert.equal(reloaded.getGlobalModel("ollama"), "qwen3:8b");
    assert.equal(reloaded.getGlobalModel("claude"), "claude-opus-4-8");
  });
});
