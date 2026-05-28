import { describe, expect, test } from "bun:test";
import { parseSlash, toggleRunner } from "./slash";

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

describe("/ollama runner command", () => {
  test("bare /ollama switches runner", () => {
    expect(parseSlash("/ollama")).toEqual({ type: "ollama", rest: "" });
  });
  test("/ollama with text switches and sends", () => {
    expect(parseSlash("/ollama fix the bug")).toEqual({
      type: "ollama",
      rest: "fix the bug",
    });
  });
  test("/model ollama <id> sets the ollama model", () => {
    expect(parseSlash("/model ollama qwen3:8b")).toEqual({
      type: "model",
      action: { kind: "setRunner", runner: "ollama", model: "qwen3:8b" },
    });
  });
  test("/model ollama reset clears the ollama override", () => {
    expect(parseSlash("/model ollama reset")).toEqual({
      type: "model",
      action: { kind: "resetRunner", runner: "ollama" },
    });
  });
  test("/new <title> ollama creates an ollama session", () => {
    expect(parseSlash("/new scratch ollama")).toEqual({
      type: "new",
      action: { title: "scratch", runner: "ollama" },
    });
  });
});

describe("toggleRunner cycle", () => {
  test("cycles claude -> codex -> vercel -> ollama -> claude", () => {
    expect(toggleRunner("claude")).toBe("codex");
    expect(toggleRunner("codex")).toBe("vercel");
    expect(toggleRunner("vercel")).toBe("ollama");
    expect(toggleRunner("ollama")).toBe("claude");
  });
});
