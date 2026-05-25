import { describe, expect, test } from "bun:test";
import { collectChatItemIds } from "./blocks";
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
