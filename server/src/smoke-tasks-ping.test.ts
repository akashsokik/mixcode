import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildPingTaskPrompt, PING_SUBTASKS } from "./smoke-tasks-ping.js";

describe("task smoke ping prompt", () => {
  test("builds the existing PING/PONG fan-out instructions", () => {
    assert.deepEqual(PING_SUBTASKS, [
      { runner: "codex", prompt: "Respond with only the word PING." },
      { runner: "codex", prompt: "Respond with only the word PONG." },
    ]);

    assert.equal(
      buildPingTaskPrompt(),
      [
        "Use the task tools now. Steps in order, exactly:",
        "1) Call task_create with title='smoke fan-out'.",
        "2) Call task_spawn with the taskId and these 2 subtasks:",
        "   - {runner:'codex', prompt:'Respond with only the word PING.'}",
        "   - {runner:'codex', prompt:'Respond with only the word PONG.'}",
        "   Use maxConcurrent=2, timeoutSec=60.",
        "3) Call task_await with the taskId and timeoutSec=120.",
        "4) Call task_done with the taskId and summary='ok'.",
        "5) Reply with just the two subtask results separated by a space.",
      ].join("\n"),
    );
  });
});
