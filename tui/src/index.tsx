import {
  createCliRenderer,
  EditBufferRenderable,
  parseColor,
  TextBufferRenderable,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import { startServer } from "../../server/src/index.ts";
import { App } from "./app";
import { theme } from "./theme";

// Dim the default mouse-drag selection highlight. Without this opentui falls
// back to fg/bg inversion, which on this dark palette looks like a glaring
// white block. We patch onSelectionChanged so that any text/edit renderable
// that did not explicitly set selectionBg/Fg picks up our theme values just
// in time for the underlying buffer view to draw them.
{
  const dimBg = parseColor(theme.selectionBg);
  const dimFg = parseColor(theme.selectionFg);
  const patchProto = (
    proto: typeof TextBufferRenderable.prototype | typeof EditBufferRenderable.prototype,
  ): void => {
    const orig = proto.onSelectionChanged;
    proto.onSelectionChanged = function (sel) {
      const self = this as unknown as { _selectionBg: unknown; _selectionFg: unknown };
      if (self._selectionBg === undefined) self._selectionBg = dimBg;
      if (self._selectionFg === undefined) self._selectionFg = dimFg;
      return orig.call(this, sel);
    };
  };
  patchProto(TextBufferRenderable.prototype);
  patchProto(EditBufferRenderable.prototype);
}

// Embed the backend in this same Bun process. One PID owns both the server
// and the TUI, so Ctrl-C → process exits → server dies → no orphans, no
// pidfiles, no second-invocation reuse hazards. The launcher (bin/mixcode.mjs)
// derives PORT per-project and exports it before spawning us.
const { port } = startServer();
process.env.ADVERSERIAL_SERVER_URL = `http://127.0.0.1:${port}`;

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 60,
});

createRoot(renderer).render(<App />);
