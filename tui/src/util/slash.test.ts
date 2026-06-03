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

describe("/model global parsing", () => {
  test("/model global <name> sets the active runner's global default", () => {
    expect(parseSlash("/model global qwen3:8b")).toEqual({
      type: "model",
      action: { kind: "setGlobal", model: "qwen3:8b" },
    });
  });
  test("/model global <runner> <name> targets a specific runner", () => {
    expect(parseSlash("/model global ollama qwen2.5-coder:7b")).toEqual({
      type: "model",
      action: { kind: "setGlobalRunner", runner: "ollama", model: "qwen2.5-coder:7b" },
    });
  });
  test("/model global reset clears the active runner's global default", () => {
    expect(parseSlash("/model global reset")).toEqual({
      type: "model",
      action: { kind: "resetGlobal" },
    });
  });
  test("/model global <runner> reset clears that runner's global default", () => {
    expect(parseSlash("/model global ollama reset")).toEqual({
      type: "model",
      action: { kind: "resetGlobalRunner", runner: "ollama" },
    });
  });
  test("/model global with no tail resets the active runner", () => {
    expect(parseSlash("/model global")).toEqual({
      type: "model",
      action: { kind: "resetGlobal" },
    });
  });
});

describe("/workflow parsing", () => {
  test("bare goal threads through to workflow authoring", () => {
    expect(parseSlash("/workflow ship the login page")).toEqual({
      type: "workflow",
      action: { goal: "ship the login page" },
    });
  });
  test("a leading --planner flag is no longer special - it stays in the goal", () => {
    expect(parseSlash("/workflow --planner codex refactor auth")).toEqual({
      type: "workflow",
      action: { goal: "--planner codex refactor auth" },
    });
  });
  test("empty goal yields empty string (App shows usage)", () => {
    expect(parseSlash("/workflow")).toEqual({
      type: "workflow",
      action: { goal: "" },
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

describe("/theme parsing", () => {
  test("bare /theme opens the picker", () => {
    expect(parseSlash("/theme")).toEqual({ type: "theme", action: { kind: "picker" } });
  });
  test("list/show/status print the palette list", () => {
    expect(parseSlash("/theme list")).toEqual({ type: "theme", action: { kind: "list" } });
    expect(parseSlash("/theme show")).toEqual({ type: "theme", action: { kind: "list" } });
    expect(parseSlash("/theme status")).toEqual({ type: "theme", action: { kind: "list" } });
  });
  test("a name sets it directly (resolution happens in the App)", () => {
    expect(parseSlash("/theme nord")).toEqual({
      type: "theme",
      action: { kind: "set", name: "nord" },
    });
  });
  test("preserves the raw name token incl. casing for the resolver", () => {
    expect(parseSlash("/theme TokyoNight")).toEqual({
      type: "theme",
      action: { kind: "set", name: "TokyoNight" },
    });
  });
});
