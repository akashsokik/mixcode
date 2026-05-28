import { describe, expect, test } from "bun:test";
import {
  EFFORT_ORDER,
  isEffortLevel,
  openAiEffortLevels,
  effortLevelsFromAnthropicCapability,
  clampEffort,
} from "./effort.js";

describe("isEffortLevel", () => {
  test("accepts canonical levels, rejects junk", () => {
    expect(isEffortLevel("xhigh")).toBe(true);
    expect(isEffortLevel("medium")).toBe(true);
    expect(isEffortLevel("turbo")).toBe(false);
    expect(isEffortLevel("")).toBe(false);
  });
});

describe("openAiEffortLevels", () => {
  test("known models return ordered levels", () => {
    expect(openAiEffortLevels("gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
    expect(openAiEffortLevels("gpt-5-codex")).toEqual([
      "minimal", "low", "medium", "high", "xhigh",
    ]);
  });
  test("no-effort models return empty", () => {
    expect(openAiEffortLevels("gpt-4o")).toEqual([]);
    expect(openAiEffortLevels("gpt-4o-mini")).toEqual([]);
  });
  test("strips the [1m] suffix before lookup", () => {
    expect(openAiEffortLevels("gpt-5[1m]")).toEqual(["minimal", "low", "medium", "high"]);
  });
  test("unknown model returns empty (no throw)", () => {
    expect(openAiEffortLevels("o9-ultra")).toEqual([]);
  });
});

describe("effortLevelsFromAnthropicCapability", () => {
  test("maps supported booleans into ordered levels including xhigh", () => {
    const cap = {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
    };
    expect(effortLevelsFromAnthropicCapability(cap)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });
  test("omits unsupported levels and null xhigh", () => {
    const cap = {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: null,
      max: { supported: true },
    };
    expect(effortLevelsFromAnthropicCapability(cap)).toEqual([
      "low", "medium", "high", "max",
    ]);
  });
  test("top-level unsupported yields empty", () => {
    const cap = {
      supported: false,
      low: { supported: false },
      medium: { supported: false },
      high: { supported: false },
      xhigh: null,
      max: { supported: false },
    };
    expect(effortLevelsFromAnthropicCapability(cap)).toEqual([]);
  });
  test("null capability yields empty", () => {
    expect(effortLevelsFromAnthropicCapability(null)).toEqual([]);
  });
});

describe("clampEffort", () => {
  const levels: ReadonlyArray<"low" | "medium" | "high" | "xhigh"> = [
    "low", "medium", "high", "xhigh",
  ];
  test("returns the requested level when supported", () => {
    expect(clampEffort(levels, "high")).toBe("high");
  });
  test("clamps down to nearest supported when requested exceeds set", () => {
    // requested "max" is above every supported level -> highest supported
    expect(clampEffort(levels, "max")).toBe("xhigh");
  });
  test("clamps down when requested sits between/below supported", () => {
    expect(clampEffort(["medium", "high"], "low")).toBe("medium");
  });
  test("returns null when no levels are supported", () => {
    expect(clampEffort([], "high")).toBe(null);
  });
});
