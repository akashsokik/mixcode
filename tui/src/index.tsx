import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { startServer } from "../../server/src/index.ts";
import { App } from "./app";

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
