// Animation hooks used by tuicards. Terminal "animation" means re-rendering
// text frames on a setInterval; everything here either auto-stops when the
// target is reached or short-circuits cleanly when the card isn't active so
// idle transcripts stay quiet.

import { useEffect, useRef, useState } from "react";

const FRAME_MS = 40; // ~25fps. Smooth enough for counter ramps, low enough
                    // that a long transcript with many active cards doesn't
                    // monopolise the event loop.

// Tween an integer value toward `target` over `durationMs`. Returns the
// currently-displayed integer. The hook lazy-starts a timer only when target
// changes; once the tween completes, the timer stops until the next change.
//
// Easing is ease-out cubic — the count finishes feeling like a settle rather
// than a uniform countdown, which reads better next to live status text.
export function useAnimatedNumber(target: number, durationMs = 450): number {
  const [shown, setShown] = useState(target);
  const startVal = useRef(target);
  const startedAt = useRef(0);
  const prevTarget = useRef(target);
  const animatingRef = useRef(false);

  if (target !== prevTarget.current) {
    startVal.current = shown;
    startedAt.current = Date.now();
    prevTarget.current = target;
    animatingRef.current = true;
  }

  useEffect(() => {
    if (!animatingRef.current) return;
    const t = setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      const t01 = Math.min(1, elapsed / Math.max(1, durationMs));
      const eased = 1 - Math.pow(1 - t01, 3);
      const next = startVal.current + (target - startVal.current) * eased;
      if (t01 >= 1) {
        animatingRef.current = false;
        setShown(target);
        clearInterval(t);
      } else {
        setShown(Math.round(next));
      }
    }, FRAME_MS);
    return () => clearInterval(t);
  }, [target, durationMs]);

  return shown;
}

// Discrete 0..steps-1 phase for active="running" cards. Wraps around. Use to
// shimmer a color through a small palette of hues. When `active` is false,
// returns 0 and the interval never starts.
export function usePulsePhase(active: boolean, periodMs = 1100, steps = 4): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) {
      setPhase(0);
      return;
    }
    setPhase(0);
    const stepMs = Math.max(60, Math.floor(periodMs / steps));
    const i = setInterval(() => setPhase((p) => (p + 1) % steps), stepMs);
    return () => clearInterval(i);
  }, [active, periodMs, steps]);
  return phase;
}

// Smooth 0..1 sinusoidal phase. Useful for color blending if we ever step
// across a longer palette. Kept here so other primitives can pick up amplitude
// modulation without re-implementing the timer dance.
export function usePulseWave(active: boolean, periodMs = 1400): number {
  const [t, setT] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!active) {
      setT(0);
      return;
    }
    startRef.current = Date.now();
    const i = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) % periodMs;
      setT(elapsed / periodMs);
    }, 70);
    return () => clearInterval(i);
  }, [active, periodMs]);
  return active ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2) : 0;
}

// Fade a new card row from dim → muted → bright on mount. Returns a phase
// index that the caller maps to a color. Stops as soon as the brightest
// phase is reached so static cards don't keep ticking.
const FADE_FRAMES = 3;
const FADE_FRAME_MS = 90;

export function useFadeInPhase(): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (phase >= FADE_FRAMES - 1) return;
    const i = setInterval(() => {
      setPhase((p) => {
        if (p >= FADE_FRAMES - 1) {
          clearInterval(i);
          return p;
        }
        return p + 1;
      });
    }, FADE_FRAME_MS);
    return () => clearInterval(i);
  }, [phase]);
  return phase;
}
