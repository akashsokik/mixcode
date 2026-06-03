import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";

import { registerModelResolver, resolvePeerModel } from "./delegate.js";

// Restore the default no-op resolver between tests so registrations don't leak.
afterEach(() => {
  registerModelResolver(() => undefined);
});

describe("resolvePeerModel precedence", () => {
  test("an explicit model always wins and skips the resolver", () => {
    let consulted = false;
    registerModelResolver(() => {
      consulted = true;
      return "global-model";
    });
    assert.equal(resolvePeerModel("node-override", "s1", "ollama"), "node-override");
    assert.equal(consulted, false, "resolver must not be consulted when explicit is set");
  });

  test("falls back to the resolver when no explicit model is given", () => {
    registerModelResolver((sessionId, runner) =>
      sessionId === "s1" && runner === "ollama" ? "resolved-model" : undefined,
    );
    assert.equal(resolvePeerModel(undefined, "s1", "ollama"), "resolved-model");
  });

  test("returns undefined (runner default) when the resolver has nothing", () => {
    registerModelResolver(() => undefined);
    assert.equal(resolvePeerModel(undefined, "s1", "claude"), undefined);
  });

  test("default resolver (before any registration) yields undefined", () => {
    // afterEach has reset to the no-op; an unset session resolves to undefined.
    assert.equal(resolvePeerModel(undefined, "unknown", "codex"), undefined);
  });
});
