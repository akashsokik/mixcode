import { useEffect, useState } from "react";

// Two-frame blink used by the in-transcript live-delegation header. A space
// for the off frame (not an empty string) keeps the layout width stable so the
// surrounding meta doesn't twitch with each tick.
const BLINK_FRAMES = ["●", " "];
const BLINK_INTERVAL_MS = 500;

export function useBlinkFrame(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    setFrame(0);
    const t = setInterval(
      () => setFrame((f) => (f + 1) % BLINK_FRAMES.length),
      BLINK_INTERVAL_MS,
    );
    return () => clearInterval(t);
  }, [active]);
  return BLINK_FRAMES[frame];
}
