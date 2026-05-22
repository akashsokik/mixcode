#!/usr/bin/env node
// mixcode — launcher that boots the local backend + TUI scoped to the
// directory it's invoked from. Each PWD gets:
//   - its own sessions store under ~/.mixcode/projects/<encoded-pwd>/
//   - its own transcript directory
//   - its own log file
//   - a deterministic port derived from the PWD, so reopening mixcode in
//     the same directory attaches to the running backend instead of
//     starting a duplicate.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Resolve the *real* invocation directory. realpathSync collapses symlinks so
// `/private/var/x` and `/var/x` hash to the same project dir on macOS.
function realCwd() {
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

const projectCwd = realCwd();

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

// Project-pwd env wins (most specific), then ~/.mixcode/.env (user-global),
// then the install dir's own .env files (fallback so a fresh user with no
// global setup still inherits the installer's keys).
loadEnvFile(path.join(projectCwd, ".env"));
loadEnvFile(path.join(os.homedir(), ".mixcode", ".env"));
loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, "server", ".env"));

// Encoded directory: safe filename derived from the absolute path. Mirrors
// Claude Code's `~/.claude/projects/<encoded-path>/` convention so users get
// a recognisable layout.
function encodeProject(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Deterministic port from the project path. 16 bits of MD5 keeps us inside a
// safe ephemeral-port window (40000–55535) and makes collisions rare.
function projectPort(absPath) {
  const digest = createHash("md5").update(absPath).digest();
  const slot = digest.readUInt16BE(0);
  return 40000 + (slot % 15536);
}

const projectSlug = encodeProject(projectCwd);
const projectDir = path.join(os.homedir(), ".mixcode", "projects", projectSlug);
mkdirSync(projectDir, { recursive: true });

const sessionFile = path.join(projectDir, "sessions.json");
const transcriptDir = path.join(projectDir, "transcripts");
const logPath = path.join(projectDir, "server.log");
const port = Number(process.env.PORT ?? projectPort(projectCwd));
const base =
  process.env.ADVERSERIAL_SERVER_URL ?? `http://127.0.0.1:${port}`;

process.env.MIXCODE_PROJECT_DIR = projectCwd;
process.env.MIXCODE_SESSION_FILE = sessionFile;
process.env.MIXCODE_TRANSCRIPT_DIR = transcriptDir;
process.env.PORT = String(port);
process.env.ADVERSERIAL_SERVER_URL = base;

function localBin(name) {
  const candidates = [
    path.join(root, "node_modules", ".bin", name),
    path.join(root, "server", "node_modules", ".bin", name),
  ];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(
      `${name} binary not found. Run \`npm install\` at ${root} first.`,
    );
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
    cwd: projectCwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(
        `\nmixcode server exited with code ${code} (signal=${signal})`,
      );
      console.error(`see ${logPath} for details`);
    }
  });
  closeSync(fd);
  return child;
}

function spawnTui() {
  const entry = path.join(root, "tui", "src", "index.tsx");
  return spawn("bun", ["run", entry], {
    cwd: projectCwd,
    env: { ...process.env, ADVERSERIAL_SERVER_URL: base },
    stdio: "inherit",
  });
}

ensureBun();

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
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

tui.on("exit", (code) => shutdown(code ?? 0));
