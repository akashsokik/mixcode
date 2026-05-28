import { describe, expect, test } from "bun:test";
import { parseSlash } from "./slash";

describe("/effort parsing", () => {
  test("bare /effort opens the picker", () => {
    expect(parseSlash("/effort")).toEqual({ type: "effort", action: { kind: "picker" } });
  });
  test("show/status/list print current state", () => {
    expect(parseSlash("/effort show")).toEqual({ type: "effort", action: { kind: "show" } });
    expect(parseSlash("/effort status")).toEqual({ type: "effort", action: { kind: "show" } });
  });
  test("a bare level sets the active runner", () => {
    expect(parseSlash("/effort xhigh")).toEqual({
      type: "effort",
      action: { kind: "set", effort: "xhigh" },
    });
  });
  test("runner + level sets a specific runner", () => {
    expect(parseSlash("/effort codex high")).toEqual({
      type: "effort",
      action: { kind: "setRunner", runner: "codex", effort: "high" },
    });
  });
  test("runner alone resets that runner", () => {
    expect(parseSlash("/effort vercel")).toEqual({
      type: "effort",
      action: { kind: "resetRunner", runner: "vercel" },
    });
  });
  test("reset clears the active runner", () => {
    expect(parseSlash("/effort reset")).toEqual({ type: "effort", action: { kind: "reset" } });
  });
  test("an unknown token falls back to show (not a silent set)", () => {
    expect(parseSlash("/effort turbo")).toEqual({ type: "effort", action: { kind: "show" } });
  });
});
