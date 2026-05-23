#!/usr/bin/env node
// `adverserial-code` — the legacy launcher kept around so existing
// installs / READMEs still work. Functionally identical to `mixcode` now:
// the backend is embedded in the TUI's Bun process (see
// tui/src/index.tsx → startServer), so this script just spawns Bun and
// exits when it exits. No separate-process server, no pidfile, no ping.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, "server", ".env"));

function ensureBun() {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error("bun is required to run adverserial-code but was not found on PATH.");
    console.error("install: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
}

ensureBun();

const tui = spawn("bun", ["run", path.join(root, "tui", "src", "index.tsx")], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

tui.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => tui.kill("SIGINT"));
process.on("SIGTERM", () => tui.kill("SIGTERM"));
