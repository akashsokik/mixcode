import { describe, expect, test } from "bun:test";
import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  test("returns '0s' for negative or zero", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(-1000)).toBe("0s");
  });
  test("seconds under a minute", () => {
    expect(formatElapsed(1_000)).toBe("1s");
    expect(formatElapsed(23_400)).toBe("23s");
    expect(formatElapsed(59_999)).toBe("59s");
  });
  test("minutes + seconds under an hour", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(64_000)).toBe("1m 4s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
  });
  test("hours + minutes at or above an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });
});
