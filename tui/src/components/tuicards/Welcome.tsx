import { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type BoxRenderable } from "@opentui/core";
import { theme } from "../../theme";
import pkg from "../../../../package.json" with { type: "json" };

const LOGO = "MixCode";
const LOGO_NOISE = "ZXCVBNMASDFGHJKL";

const TIP = "Use /sessions to browse previous conversations";
const HINTS_TOP = "ctrl+k for palette  ·  shift+tab to cycle modes";
const HINTS_BOT = "@ to insert files  ·  /help for commands";

type Runner = readonly [name: string, ready: boolean];
const RUNNERS: ReadonlyArray<Runner> = [
  ["Claude", true],
  ["Codex", true],
  ["Vercel", true],
];

const SETTLE_FRAME = LOGO.length + 4;

// Faint glyph density ramp (sparse -> dense). ASCII only so the field stays
// legible in any terminal and the blobs read by character weight alone.
const RIPPLE_RAMP = " .:-=+#";

// Build one frame of the liquid field: three layered sine waves plus a slow
// radial term sampled per cell. The sum morphs over time, so dense glyphs
// drift and pool into blob-like clusters that ripple across the screen.
function buildRipple(w: number, h: number, frame: number): string[] {
  if (w <= 0 || h <= 0) return [];
  const t = frame * 0.12;
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    for (let x = 0; x < w; x++) {
      // y is scaled up since terminal cells are ~2x taller than wide, keeping
      // the blobs roughly round instead of vertically stretched.
      const yy = y * 2;
      const v =
        Math.sin(x * 0.18 + t) +
        Math.sin(yy * 0.16 - t * 0.7) +
        Math.sin((x + yy) * 0.1 + t * 0.5) +
        Math.sin(Math.hypot(x - w / 2, yy - h) * 0.12 - t);
      const n = (v + 4) / 8; // sum is in [-4, 4]; normalize to [0, 1]
      const idx = Math.min(
        RIPPLE_RAMP.length - 1,
        Math.max(0, Math.floor(n * RIPPLE_RAMP.length)),
      );
      line += RIPPLE_RAMP[idx];
    }
    lines.push(line);
  }
  return lines;
}

// Full-area animated backdrop. Measures its own rendered size so the grid
// matches the Welcome region exactly, then ticks a slow timer to morph the
// field. One faint color across the whole field keeps it behind the content.
function RippleBackground() {
  const ref = useRef<BoxRenderable>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setFrame((value) => value + 1), 120);
    return () => clearInterval(tick);
  }, []);

  const measure = () => {
    const node = ref.current;
    if (!node) return;
    setSize((prev) =>
      prev.w === node.width && prev.h === node.height
        ? prev
        : { w: node.width, h: node.height },
    );
  };

  const lines = useMemo(
    () => buildRipple(size.w, size.h, frame),
    [size.w, size.h, frame],
  );

  return (
    <box
      ref={ref}
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={0}
      flexDirection="column"
      onSizeChange={measure}
    >
      {lines.map((line, i) => (
        <text key={i} fg={theme.textFaint}>
          {line}
        </text>
      ))}
    </box>
  );
}

export function Welcome() {
  const [frame, setFrame] = useState(0);
  const settled = frame >= SETTLE_FRAME;

  const logoText = settled
    ? LOGO
    : LOGO.split("")
        .map((char, index) =>
          frame > index + 2
            ? char
            : LOGO_NOISE[(frame + index * 3) % LOGO_NOISE.length],
        )
        .join("");
  const logoColor = frame < 4
    ? theme.textFaint
    : frame < 10
      ? theme.textSubtle
      : theme.text;

  useEffect(() => {
    if (settled) return;
    const tick = setInterval(() => setFrame((value) => value + 1), 90);
    return () => clearInterval(tick);
  }, [settled]);

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center">
      <RippleBackground />
      <box flexDirection="column" alignItems="center" zIndex={1}>
        <ascii-font text={logoText} font="block" color={logoColor} />

        <box marginTop={1}>
          <text fg={theme.textMuted}>v{pkg.version}</text>
        </box>

        <box marginTop={2} flexDirection="row">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            TIP:
          </text>
          <text fg={theme.text}>{` ${TIP}`}</text>
        </box>

        <box marginTop={2} flexDirection="column" alignItems="center">
          <text fg={theme.textMuted}>{HINTS_TOP}</text>
          <text fg={theme.textMuted}>{HINTS_BOT}</text>
        </box>

        <box marginTop={2} flexDirection="row">
          {RUNNERS.map(([name, ok], i) => (
            <box key={name} flexDirection="row">
              {i > 0 && <text fg={theme.textFaint}>{"   "}</text>}
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {name}
              </text>
              <text fg={ok ? theme.toolEdit : theme.toolError}>
                {ok ? " ✓" : " ✗"}
              </text>
            </box>
          ))}
        </box>
      </box>
    </box>
  );
}
