import { describe, expect, test } from "bun:test";
import {
  blocksFromEvents,
  collectChatItemIds,
  groupDelegations,
  latestDelegationId,
  peerBlockRunId,
  resolveItemContent,
} from "./blocks";
import type { RunEvent, Session } from "../../../shared/events.ts";
import type { Notice } from "./notice";

function makeSession(): Session {
  return {
    id: "s1",
    title: "demo",
    activeRunner: "claude",
    cwd: "/tmp",
    streaming: false,
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:00:05.000Z",
    models: {},
    claudeMode: "default",
    git: null,
    messages: [
      {
        id: "m1",
        role: "user",
        text: "hi",
        events: [],
        createdAt: "2026-05-25T10:00:01.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        text: "hello",
        events: [
          { type: "text_delta", delta: "hello" },
          { type: "tool_log", log: { name: "Read", input: { path: "/a" }, output: "ok" } },
        ],
        createdAt: "2026-05-25T10:00:02.000Z",
      },
    ],
  };
}

function makeNotice(id: string, at: string): Notice {
  return { id, command: "/help", lines: ["…"], createdAt: at };
}

describe("collectChatItemIds", () => {
  test("emits one id per row in chronological order", () => {
    const session = makeSession();
    const notice = makeNotice("n1", "2026-05-25T10:00:03.000Z");
    const ids = collectChatItemIds(session, [notice]);
    expect(ids).toEqual([
      "msg:m1",
      "m2:0",
      "m2:1",
      "notice:n1",
    ]);
  });

  test("returns [] for a null session", () => {
    expect(collectChatItemIds(null, [])).toEqual([]);
  });
});

describe("collaboration grouping", () => {
  test("folds collab snapshots, control tools, and peer back-and-forth into one group", () => {
    const events: RunEvent[] = [
      { type: "text_delta", delta: "Creating the plan.\n" },
      {
        type: "tool_log",
        log: {
          name: "mcp__orchestrator__plan_create",
          input: { title: "Demo" },
          output: { ok: true, planId: "plan_abc12345", path: "docs/plans/demo.md" },
        },
      },
      { type: "text_delta", delta: "Starting collaboration.\n" },
      {
        type: "tool_log",
        log: {
          id: "collab:log_1",
          name: "collab",
          input: { planId: "plan_abc12345", path: "docs/plans/demo.md" },
          output: {
            collabId: "collab_xyz98765",
            planId: "plan_abc12345",
            planPath: "docs/plans/demo.md",
            leadRunner: "claude",
            peerRunner: "codex",
            status: "running",
            phases: [
              {
                id: "phase_1",
                title: "Create shared plan",
                status: "running",
                owner: "claude",
              },
            ],
            messages: 1,
            decisions: 0,
            peerTurns: 1,
            maxPeerTurns: 8,
          },
        },
      },
      {
        type: "tool_log",
        log: {
          name: "mcp__orchestrator__collab_start",
          input: { planId: "plan_abc12345" },
          output: { ok: true, collabId: "collab_xyz98765" },
        },
      },
      {
        type: "tool_log",
        log: {
          name: "mcp__orchestrator__phase_start",
          input: { collabId: "collab_xyz98765", phaseId: "phase_1" },
          output: { ok: true, phaseId: "phase_1" },
        },
      },
      {
        type: "tool_log",
        log: {
          id: "peer:codex:reply",
          name: "[codex] reply",
          input: {},
          output: "Looks good; keep the phases bounded.",
        },
      },
      {
        type: "tool_log",
        log: {
          name: "mcp__orchestrator__collab_ask_peer",
          input: { collabId: "collab_xyz98765", role: "review" },
          output: { ok: true },
        },
      },
    ];

    const grouped = groupDelegations(blocksFromEvents(events), "m-collab");
    const collab = grouped.find((g) => g.kind === "collab_group");
    if (!collab || collab.kind !== "collab_group") {
      throw new Error("expected collab_group");
    }

    expect(collab.id).toBe("m-collab:c:1");
    expect(grouped.filter((g) => g.kind === "collab_group")).toHaveLength(1);
    expect(grouped.filter((g) => g.kind === "passthrough")).toHaveLength(2);
    expect(collab.snapshot?.name).toBe("collab");
    expect(collab.children.map((child) => child.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "peer_reply",
      "tool",
    ]);
  });

  test("collab groups participate in navigation, clipboard, and latest-toggle ids", () => {
    const session = makeSession();
    session.messages.push({
      id: "m3",
      role: "assistant",
      text: "collab",
      events: [
        {
          type: "tool_log",
          log: {
            name: "mcp__orchestrator__plan_read",
            input: { planId: "plan_abc12345" },
            output: { ok: true },
          },
        },
        {
          type: "tool_log",
          log: {
            id: "collab:log_1",
            name: "collab",
            input: { planId: "plan_abc12345", path: "docs/plans/demo.md" },
            output: {
              collabId: "collab_xyz98765",
              planId: "plan_abc12345",
              planPath: "docs/plans/demo.md",
              leadRunner: "codex",
              peerRunner: "claude",
              status: "running",
              phases: [],
              messages: 0,
              decisions: 0,
              peerTurns: 0,
              maxPeerTurns: 8,
            },
          },
        },
      ],
      createdAt: "2026-05-25T10:00:04.000Z",
    });

    expect(collectChatItemIds(session, [])).toContain("m3:c:0");
    expect(latestDelegationId(session)).toBe("m3:c:0");
    expect(resolveItemContent(session, [], "m3:c:0")).toContain("Plan read");
  });
});

describe("workflow authoring fold", () => {
  const addNode = (id: string, title: string): RunEvent => ({
    type: "tool_log",
    log: {
      name: "mcp__orchestrator__workflow_add_node",
      input: { id, title, runner: "ollama" },
      output: [{ type: "text", text: "{}" }],
    },
  });
  const runTool: RunEvent = {
    type: "tool_log",
    log: {
      name: "mcp__orchestrator__workflow_run",
      input: { goal: "math" },
      output: [{ type: "text", text: "{}" }],
    },
  };

  test("folds a run of 2+ authoring tools into one workflow_authoring group", () => {
    const events = [addNode("a1", "Compute A1"), addNode("a2", "Compute A2"), runTool];
    const grouped = groupDelegations(blocksFromEvents(events), "m1");
    expect(grouped).toHaveLength(1);
    const g = grouped[0];
    expect(g.kind).toBe("workflow_authoring");
    if (g.kind !== "workflow_authoring") throw new Error("expected workflow_authoring");
    expect(g.children).toHaveLength(3);
    expect(g.id).toBe("m1:wfauth:0");
    // The folded group is selectable as one item, not three.
    expect(collectChatItemIds({
      id: "s", title: "t", activeRunner: "claude", cwd: "/tmp", streaming: false,
      createdAt: "2026-05-25T10:00:00.000Z", updatedAt: "2026-05-25T10:00:00.000Z",
      models: {}, claudeMode: "default", git: null,
      messages: [{ id: "m1", role: "assistant", text: "", events, createdAt: "2026-05-25T10:00:01.000Z" }],
    }, [])).toEqual(["m1:wfauth:0"]);
  });

  test("a lone authoring tool is left unfolded", () => {
    const grouped = groupDelegations(blocksFromEvents([addNode("a1", "only")]), "m1");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe("passthrough");
  });
});

describe("peerBlockRunId", () => {
  test("extracts the short run-id from tagged peer reply / tool names", () => {
    const events: RunEvent[] = [
      { type: "tool_log", log: { name: "[ollama][lf00lmyA…] reply", output: "50" } },
      { type: "tool_log", log: { name: "[ollama][fkPlDEIT…] Bash", input: {}, output: "ok" } },
    ];
    const blocks = blocksFromEvents(events);
    expect(blocks.map(peerBlockRunId)).toEqual(["lf00lmyA…", "fkPlDEIT…"]);
  });

  test("returns null for an untagged peer reply and a non-peer block", () => {
    const events: RunEvent[] = [
      { type: "tool_log", log: { name: "[codex] reply", output: "hi" } },
      { type: "tool_log", log: { name: "Read", input: { path: "/a" }, output: "ok" } },
    ];
    expect(blocksFromEvents(events).map(peerBlockRunId)).toEqual([null, null]);
  });
});
