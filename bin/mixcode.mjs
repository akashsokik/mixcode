#!/usr/bin/env node
// mixcode — launcher that boots a single Bun process for the directory it's
// invoked from. The backend is embedded inside the TUI process (see
// tui/src/index.tsx → startServer), so this launcher's job is just:
//   - resolve the real cwd and derive a deterministic per-project port
//   - lay out the per-project state dirs under ~/.mixcode/projects/<slug>/
//   - load env files (install-dir .env is API-keys-only — see INSTALL_ENV_SKIP)
//   - spawn `bun` at the TUI entry and exit when it exits
//
// No ping, no server spawn, no SIGTERM dance. One PID owns everything; if
// the user Ctrl-Cs, Bun exits, the embedded server dies with it, no orphans.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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

function loadEnvFile(filePath, { skip } = {}) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (skip && skip.has(key)) continue;
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
//
// Install-dir .env is for API keys only — PORT / SERVER_URL must stay
// per-project, otherwise the install repo's own PORT=… leaks into every
// project that doesn't define its own, collapsing them onto a shared backend.
const INSTALL_ENV_SKIP = new Set([
  "PORT",
  "SERVER_URL",
  "ADVERSERIAL_SERVER_URL",
  "MIXCODE_PROJECT_DIR",
  "MIXCODE_SESSION_FILE",
  "MIXCODE_TRANSCRIPT_DIR",
]);
loadEnvFile(path.join(projectCwd, ".env"));
loadEnvFile(path.join(os.homedir(), ".mixcode", ".env"));
loadEnvFile(path.join(root, ".env"), { skip: INSTALL_ENV_SKIP });
loadEnvFile(path.join(root, "server", ".env"), { skip: INSTALL_ENV_SKIP });

// Encoded directory: safe filename derived from the absolute path. Mirrors
// Claude Code's `~/.claude/projects/<encoded-path>/` convention so users get
// a recognisable layout.
function encodeProject(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Deterministic port from the project path. 16 bits of MD5 keeps us inside a
// safe ephemeral-port window (40000–55535) and makes collisions rare. Same
// invocation twice → same port → the embedded server's EADDRINUSE branch
// kicks in and the second TUI attaches to the first (see server startServer).
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
const port = Number(process.env.PORT ?? projectPort(projectCwd));
const base =
  process.env.ADVERSERIAL_SERVER_URL ?? `http://127.0.0.1:${port}`;

process.env.MIXCODE_PROJECT_DIR = projectCwd;
process.env.MIXCODE_SESSION_FILE = sessionFile;
process.env.MIXCODE_TRANSCRIPT_DIR = transcriptDir;
process.env.PORT = String(port);
process.env.ADVERSERIAL_SERVER_URL = base;

function ensureBun() {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error("bun is required to run mixcode but was not found on PATH.");
    console.error("install: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
}

ensureBun();

const tui = spawn("bun", ["run", path.join(root, "tui", "src", "index.tsx")], {
  cwd: projectCwd,
  env: process.env,
  stdio: "inherit",
});

tui.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => tui.kill("SIGINT"));
process.on("SIGTERM", () => tui.kill("SIGTERM"));
