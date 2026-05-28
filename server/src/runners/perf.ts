// Temporary per-turn TTFT instrumentation. Splits the measured time-to-first-
// token into spawn+init (t0 -> first SDK message) and prefill+reasoning
// (first SDK message -> first visible text), so we can attribute the wall-clock
// cost before committing to the warm-process refactor. Gated behind
// ADVERSARIA_PERF=1 and isolated here so it is easy to remove later.

export type PerfPhase = "init" | "firstText";

export type TurnPerf = {
  mark: (phase: PerfPhase) => void;
  done: () => void;
};

export type PerfMarks = {
  t0: number;
  tInit: number | null;
  tFirstText: number | null;
};

export function formatPerfLine(runner: string, marks: PerfMarks): string {
  const { t0, tInit, tFirstText } = marks;
  const ms = (a: number, b: number): number => Math.max(0, Math.round(b - a));
  const parts: string[] = [];
  if (tInit !== null) parts.push(`spawn+init=${ms(t0, tInit)}ms`);
  if (tInit !== null && tFirstText !== null) {
    parts.push(`prefill+reasoning=${ms(tInit, tFirstText)}ms`);
  }
  parts.push(tFirstText !== null ? `toFirstText=${ms(t0, tFirstText)}ms` : "toFirstText=n/a");
  return `[perf:${runner}] ${parts.join(" ")}`;
}

export function startTurnPerf(runner: string, now: () => number = Date.now): TurnPerf {
  const marks: PerfMarks = { t0: now(), tInit: null, tFirstText: null };
  return {
    mark(phase: PerfPhase): void {
      if (phase === "init") {
        if (marks.tInit === null) marks.tInit = now();
      } else if (marks.tFirstText === null) {
        marks.tFirstText = now();
      }
    },
    done(): void {
      if (process.env.ADVERSARIA_PERF !== "1") return;
      console.error(formatPerfLine(runner, marks));
    },
  };
}
