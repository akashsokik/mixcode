import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addDraftNode,
  clearDraft,
  draftToNodes,
  getDraft,
  type DraftNode,
} from "./workflow-draft.js";

// Each test uses a distinct sessionId so the module-level store doesn't bleed
// between cases (the store is global, mirroring the WorkflowRun store).

describe("workflow draft store", () => {
  test("accumulates nodes per session and reports the running count", () => {
    const s = "draft-accum";
    assert.deepEqual(getDraft(s), []);
    const r1 = addDraftNode(s, { id: "a", title: "A", runner: "claude", prompt: "do a" });
    assert.deepEqual(r1, { ok: true, count: 1 });
    const r2 = addDraftNode(s, { id: "b", title: "B", runner: "codex", prompt: "do b", dependsOn: ["a"] });
    assert.deepEqual(r2, { ok: true, count: 2 });
    assert.equal(getDraft(s).length, 2);
    clearDraft(s);
  });

  test("rejects a duplicate id within the same draft without adding it", () => {
    const s = "draft-dupe";
    addDraftNode(s, { id: "a", title: "A", runner: "claude", prompt: "x" });
    const r = addDraftNode(s, { id: "a", title: "A2", runner: "codex", prompt: "y" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /duplicate node id "a"/);
    assert.equal(getDraft(s).length, 1); // unchanged
    clearDraft(s);
  });

  test("drafts in different sessions are independent", () => {
    const s1 = "draft-iso-1";
    const s2 = "draft-iso-2";
    addDraftNode(s1, { id: "a", title: "A", runner: "claude", prompt: "x" });
    // Same id is fine in a different session.
    const r = addDraftNode(s2, { id: "a", title: "A", runner: "claude", prompt: "x" });
    assert.equal(r.ok, true);
    assert.equal(getDraft(s1).length, 1);
    assert.equal(getDraft(s2).length, 1);
    clearDraft(s1);
    clearDraft(s2);
  });

  test("clearDraft drops the whole draft", () => {
    const s = "draft-clear";
    addDraftNode(s, { id: "a", title: "A", runner: "claude", prompt: "x" });
    clearDraft(s);
    assert.deepEqual(getDraft(s), []);
  });

  test("draftToNodes fills engine-owned fields and preserves authored ones", () => {
    const draft: DraftNode[] = [
      { id: "a", title: "Recon", runner: "claude", prompt: "explore" },
      { id: "b", title: "Fix", runner: "codex", model: "gpt-5-codex", prompt: "fix it", dependsOn: ["a"] },
    ];
    const nodes = draftToNodes(draft);
    assert.equal(nodes.length, 2);
    // authored fields preserved
    assert.equal(nodes[1].id, "b");
    assert.equal(nodes[1].title, "Fix");
    assert.equal(nodes[1].runner, "codex");
    assert.equal(nodes[1].model, "gpt-5-codex");
    assert.equal(nodes[1].prompt, "fix it");
    assert.deepEqual(nodes[1].dependsOn, ["a"]);
    // engine-owned fields initialized
    assert.equal(nodes[0].status, "pending");
    assert.equal(nodes[0].attempt, 0);
    assert.equal(nodes[0].output, undefined);
    assert.equal(nodes[0].runId, undefined);
  });
});
