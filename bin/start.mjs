#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

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

const port = Number(process.env.PORT ?? 4567);
const base = process.env.ADVERSERIAL_SERVER_URL ?? `http://127.0.0.1:${port}`;

const logDir = path.join(os.homedir(), ".adverserial-code");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, "server.log");
const pidPath = path.join(logDir, "server.pid");

// Files whose mtime invalidates a running backend. tsx loads .ts files once
// per process, so edits to these never reach an already-running server. When
// any of them is newer than the recorded launch mtime we treat the running
// backend as stale and respawn — keeping attach-on-ping ergonomics for the
// no-edits case while making "edit code → bun start" actually pick up edits.
const SOURCE_FILES = [
  path.join(root, "server", "src", "index.ts"),
  path.join(root, "server", "src", "sessions.ts"),
  path.join(root, "server", "src", "transcript.ts"),
  path.join(root, "server", "src", "permissions.ts"),
  path.join(root, "server", "src", "git.ts"),
  path.join(root, "server", "src", "runners", "claude.ts"),
  path.join(root, "server", "src", "runners", "codex.ts"),
  path.join(root, "server", "src", "runners", "delegate.ts"),
  path.join(root, "shared", "events.ts"),
];

function latestSourceMtime() {
  let max = 0;
  for (const p of SOURCE_FILES) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > max) max = m;
    } catch {
      // Missing optional source files are fine — only count what exists.
    }
  }
  return max;
}

function readPidfile() {
  if (!existsSync(pidPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pidPath, "utf8"));
    if (typeof parsed.pid !== "number" || typeof parsed.mtimeMs !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPortFree(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await ping())) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function killStaleBackend() {
  const record = readPidfile();
  const sourceMtime = latestSourceMtime();
  const live = await ping();
  if (!live) {
    // Nothing listening — clean up any leftover pidfile and let the caller spawn.
    try { unlinkSync(pidPath); } catch {}
    return false;
  }
  if (!record || record.mtimeMs >= sourceMtime) {
    // Either we don't know the running backend's vintage (no pidfile) or it
    // was launched after the last source edit. Trust the attach.
    return false;
  }
  console.error(
    `[start] backend on :${port} is older than source edits — killing pid ${record.pid} and respawning`,
  );
  if (pidAlive(record.pid)) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (err) {
      console.error(`[start] failed to SIGTERM pid ${record.pid}: ${err?.message ?? err}`);
    }
  }
  const freed = await waitForPortFree();
  if (!freed) {
    console.error(
      `[start] port :${port} is still in use after kill attempt (pid ${record.pid} may have been already dead or held by another process); aborting`,
    );
    process.exit(1);
  }
  try { unlinkSync(pidPath); } catch {}
  return true;
}

function localBin(name) {
  const candidates = [
    path.join(root, "node_modules", ".bin", name),
    path.join(root, "server", "node_modules", ".bin", name),
  ];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`${name} binary not found. Run \`npm install\` at ${root} first.`);
  }
  return found;
}

function ensureBun() {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error("bun is required to run the TUI but was not found on PATH.");
    console.error("install: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
}

async function ping() {
  try {
    const res = await fetch(`${base}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function spawnServer() {
  const entry = path.join(root, "server", "src", "index.ts");
  const fd = openSync(logPath, "a");
  const child = spawn(localBin("tsx"), [entry], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`\nadverserial-code server exited with code ${code} (signal=${signal})`);
      console.error(`see ${logPath} for details`);
    }
  });
  closeSync(fd);
  try {
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: child.pid, mtimeMs: latestSourceMtime() }),
    );
  } catch (err) {
    console.error(`[start] failed to write pidfile ${pidPath}: ${err?.message ?? err}`);
  }
  return child;
}

function spawnTui() {
  const entry = path.join(root, "tui", "src", "index.tsx");
  return spawn("bun", ["run", entry], {
    cwd: process.cwd(),
    env: { ...process.env, ADVERSERIAL_SERVER_URL: base },
    stdio: "inherit",
  });
}

ensureBun();

await killStaleBackend();

const startedServer = !(await ping());
const server = startedServer ? spawnServer() : null;

if (startedServer) {
  const ok = await waitForServer();
  if (!ok) {
    console.error(`backend did not come up at ${base}; see ${logPath}`);
    server?.kill("SIGTERM");
    process.exit(1);
  }
}

const tui = spawnTui();

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server && !server.killed) server.kill("SIGTERM");
  if (server) {
    try { unlinkSync(pidPath); } catch {}
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

tui.on("exit", (code) => shutdown(code ?? 0));
