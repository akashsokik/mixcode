import { describe, expect, test } from "bun:test";
import { collectChatItemIds, pendingDelegations } from "./blocks";
import type { Session } from "../../../shared/events.ts";
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

describe("pendingDelegations", () => {
  test("returns empty list when session is null", () => {
    expect(pendingDelegations(null, null)).toEqual([]);
  });

  test("returns empty list when no delegate_run started", () => {
    const session = makeSession();
    expect(pendingDelegations(session, session.messages.at(-1)!.id)).toEqual([]);
  });

  test("returns pending group when peer is in-flight on the streaming message", () => {
    const session: Session = {
      ...makeSession(),
      streaming: true,
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "",
          createdAt: "2026-05-25T10:00:00.000Z",
          events: [
            // delegate_run anchor not yet emitted; only a peer reply
            // tool_log has arrived — groupDelegations synthesises a
            // pending group.
            {
              type: "tool_log",
              log: { name: "[claude] reply", input: {}, output: "drafting" },
            },
          ],
        },
      ],
    };
    const out = pendingDelegations(session, "m1");
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("delegation_group");
    expect(out[0].header).toBeNull();
    expect(out[0].pendingRunner).toBe("claude");
  });

  test("ignores pending groups on a non-streaming message", () => {
    const session = makeSession();
    // streamingMessageId points to a different / older id
    expect(pendingDelegations(session, "msg-that-isnt-streaming")).toEqual([]);
  });
});
