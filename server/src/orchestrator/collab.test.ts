import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { RunEvent } from "../../../shared/events.js";
import {
  askPeer,
  cancelCollabsForSession,
  clearCollabsForSession,
  finishCollab,
  handoffPhase,
  observeCollab,
  readPlan,
  registerCollabEmitter,
  sendCollabMessage,
  startCollab,
  startPhase,
  unregisterCollabEmitter,
  writePlan,
  donePhase,
  type PeerRunStarter,
} from "./collab.js";

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "mixcode-collab-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("collaboration plans", () => {
  test("writePlan creates a shared repo-local markdown plan that readPlan can load by id", async () => {
    await withTempCwd(async (cwd) => {
      const written = await writePlan({
        cwd,
        owner: "codex",
        title: "Agent collaboration",
        goal: "Let Codex and Claude build a feature from a shared plan.",
        phases: ["Create server state", "Wire MCP tools"],
        risks: ["Unbounded peer loops"],
        verification: ["npm --workspace server test"],
      });

      assert.equal(written.ok, true);
      if (!written.ok) return;
      assert.match(written.path, /^docs\/plans\/\d{4}-\d{2}-\d{2}-agent-collaboration-[a-z0-9]+\.md$/);

      const loaded = await readPlan({ cwd, planId: written.planId });
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.plan.planId, written.planId);
      assert.equal(loaded.plan.owner, "codex");
      assert.deepEqual(loaded.plan.phases, ["Create server state", "Wire MCP tools"]);
      assert.match(loaded.plan.body, /Let Codex and Claude build a feature/);
    });
  });
});

describe("collaboration runs", () => {
  test("startCollab creates phases, emits snapshots, records messages, and finishes", async () => {
    await withTempCwd(async (cwd) => {
      const written = await writePlan({
        cwd,
        owner: "codex",
        title: "Phased work",
        goal: "Build in phases.",
        phases: ["Inspect", "Implement"],
      });
      assert.equal(written.ok, true);
      if (!written.ok) return;

      const events: RunEvent[] = [];
      registerCollabEmitter("s1", (event) => events.push(event));
      try {
        const started = await startCollab({
          sessionId: "s1",
          cwd,
          planId: written.planId,
          leadRunner: "codex",
        });
        assert.equal(started.ok, true);
        if (!started.ok) return;

        assert.equal(started.snapshot.leadRunner, "codex");
        assert.equal(started.snapshot.peerRunner, "claude");
        assert.equal(started.snapshot.phases.length, 2);

        const firstPhase = started.snapshot.phases[0]!.id;
        const phaseStarted = startPhase(started.collabId, firstPhase);
        assert.equal(phaseStarted.ok, true);

        const sent = sendCollabMessage(started.collabId, {
          from: "codex",
          kind: "decision",
          phaseId: firstPhase,
          body: "Codex will implement the server state first.",
        });
        assert.equal(sent.ok, true);

        const phaseDone = donePhase(started.collabId, firstPhase, "State inspected.");
        assert.equal(phaseDone.ok, true);

        const finished = finishCollab(started.collabId, "Ready for handoff.");
        assert.equal(finished.ok, true);

        const observed = observeCollab(started.collabId);
        assert.equal(observed.ok, true);
        if (!observed.ok) return;
        assert.equal(observed.snapshot.status, "done");
        assert.equal(observed.snapshot.messages, 2);
        assert.equal(observed.snapshot.phases[0]!.status, "done");

        assert.ok(
          events.some((event) => event.type === "tool_log" && event.log.name === "collab"),
          "expected collab tool_log snapshots",
        );
      } finally {
        unregisterCollabEmitter("s1");
        clearCollabsForSession("s1");
      }
    });
  });

  test("handoffPhase changes phase owner and lead runner", async () => {
    await withTempCwd(async (cwd) => {
      const written = await writePlan({
        cwd,
        owner: "codex",
        title: "Handoff",
        goal: "Switch phase ownership.",
        phases: ["Review"],
      });
      assert.equal(written.ok, true);
      if (!written.ok) return;

      const started = await startCollab({
        sessionId: "s2",
        cwd,
        planId: written.planId,
        leadRunner: "codex",
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;

      const phaseId = started.snapshot.phases[0]!.id;
      const handed = handoffPhase(started.collabId, phaseId, {
        owner: "claude",
        makeLead: true,
        note: "Claude should lead verification.",
      });
      assert.equal(handed.ok, true);

      const observed = observeCollab(started.collabId);
      assert.equal(observed.ok, true);
      if (!observed.ok) return;
      assert.equal(observed.snapshot.leadRunner, "claude");
      assert.equal(observed.snapshot.phases[0]!.owner, "claude");
      assert.equal(observed.snapshot.decisions, 1);

      clearCollabsForSession("s2");
    });
  });

  test("askPeer runs one bounded peer turn and records the response", async () => {
    await withTempCwd(async (cwd) => {
      const written = await writePlan({
        cwd,
        owner: "codex",
        title: "Peer review",
        goal: "Ask Claude to review.",
        phases: ["Review"],
      });
      assert.equal(written.ok, true);
      if (!written.ok) return;

      const started = await startCollab({
        sessionId: "s3",
        cwd,
        planId: written.planId,
        leadRunner: "codex",
        maxPeerTurns: 1,
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;

      const starter: PeerRunStarter = (args) => {
        const abort = new AbortController();
        const record = {
          runId: "peer-run-1",
          runner: args.runner,
          status: "ok" as const,
          result: "Claude reviewed the phase and found no blockers.",
          parentSessionId: args.parentSessionId,
          abort,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          work: Promise.resolve(),
        };
        return { ok: true, record };
      };

      const phaseId = started.snapshot.phases[0]!.id;
      const asked = await askPeer(
        started.collabId,
        {
          phaseId,
          request: "Review the phase plan.",
          role: "review",
          timeoutSec: 5,
          parentCwd: cwd,
          depth: 0,
        },
        starter,
      );
      assert.equal(asked.ok, true);
      if (!asked.ok) return;
      assert.equal(asked.message.from, "claude");
      assert.match(asked.message.body, /no blockers/);

      const second = await askPeer(
        started.collabId,
        {
          phaseId,
          request: "Review again.",
          role: "review",
          timeoutSec: 5,
          parentCwd: cwd,
          depth: 0,
        },
        starter,
      );
      assert.equal(second.ok, false);
      if (second.ok) return;
      assert.match(second.error, /peer turn limit/);

      cancelCollabsForSession("s3");
      clearCollabsForSession("s3");
    });
  });
});
