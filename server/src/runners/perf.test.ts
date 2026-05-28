import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatPerfLine, startTurnPerf } from "./perf.js";

describe("formatPerfLine", () => {
  test("full turn reports all three phases", () => {
    const line = formatPerfLine("codex", { t0: 1000, tInit: 4000, tFirstText: 9000 });
    assert.equal(
      line,
      "[perf:codex] spawn+init=3000ms prefill+reasoning=5000ms toFirstText=8000ms",
    );
  });

  test("rounds fractional milliseconds", () => {
    const line = formatPerfLine("claude", { t0: 0, tInit: 1499.4, tFirstText: 2500.6 });
    assert.equal(
      line,
      "[perf:claude] spawn+init=1499ms prefill+reasoning=1001ms toFirstText=2501ms",
    );
  });

  test("turn with no visible text marks toFirstText n/a", () => {
    const line = formatPerfLine("codex", { t0: 1000, tInit: 4000, tFirstText: null });
    assert.equal(line, "[perf:codex] spawn+init=3000ms toFirstText=n/a");
  });

  test("clamps negative deltas to zero", () => {
    const line = formatPerfLine("claude", { t0: 5000, tInit: 4000, tFirstText: 3000 });
    assert.equal(
      line,
      "[perf:claude] spawn+init=0ms prefill+reasoning=0ms toFirstText=0ms",
    );
  });
});

describe("startTurnPerf", () => {
  test("mark records only the first occurrence of each phase", () => {
    let clock = 100;
    const tick = () => clock;
    const perf = startTurnPerf("codex", tick);

    clock = 250;
    perf.mark("init");
    clock = 400;
    perf.mark("init"); // ignored: init already set

    clock = 900;
    perf.mark("firstText");
    clock = 1200;
    perf.mark("firstText"); // ignored: firstText already set

    let captured = "";
    const origEnv = process.env.ADVERSARIA_PERF;
    const origErr = console.error;
    process.env.ADVERSARIA_PERF = "1";
    console.error = (msg?: unknown) => {
      captured = String(msg);
    };
    try {
      perf.done();
    } finally {
      console.error = origErr;
      if (origEnv === undefined) delete process.env.ADVERSARIA_PERF;
      else process.env.ADVERSARIA_PERF = origEnv;
    }

    assert.equal(
      captured,
      "[perf:codex] spawn+init=150ms prefill+reasoning=650ms toFirstText=800ms",
    );
  });

  test("done is silent when ADVERSARIA_PERF is not set", () => {
    const origEnv = process.env.ADVERSARIA_PERF;
    delete process.env.ADVERSARIA_PERF;
    let called = false;
    const origErr = console.error;
    console.error = () => {
      called = true;
    };
    try {
      const perf = startTurnPerf("claude");
      perf.mark("init");
      perf.done();
    } finally {
      console.error = origErr;
      if (origEnv !== undefined) process.env.ADVERSARIA_PERF = origEnv;
    }
    assert.equal(called, false);
  });
});
