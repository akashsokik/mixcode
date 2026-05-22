import { spawn, spawnSync } from "node:child_process";
import type { RunnerKind } from "../../../shared/events.ts";

// Hard cap on how long any blocking shell-out is allowed to take. The MCP
// CLIs do network health checks on `list`, so we keep this comfortably high.
const CLI_TIMEOUT_MS = 15_000;

export type CliOutcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  // Best-effort string; "command not found" when the binary itself is missing.
  errorReason?: string;
};

function runCli(binary: string, args: string[]): CliOutcome {
  const res = spawnSync(binary, args, { encoding: "utf8", timeout: CLI_TIMEOUT_MS });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, stdout: "", stderr: "", errorReason: `${binary} not found on PATH` };
    }
    return { ok: false, stdout: "", stderr: "", errorReason: res.error.message };
  }
  if (res.status === null) {
    return {
      ok: false,
      stdout: (res.stdout ?? "").toString(),
      stderr: (res.stderr ?? "").toString(),
      errorReason: res.signal ? `killed by signal ${res.signal}` : "timed out",
    };
  }
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    errorReason: res.status !== 0 ? `exit ${res.status}` : undefined,
  };
}

function binaryFor(runner: RunnerKind): string {
  return runner === "claude" ? "claude" : "codex";
}

export function listMcp(runner: RunnerKind): CliOutcome {
  return runCli(binaryFor(runner), ["mcp", "list"]);
}

export function removeMcp(runner: RunnerKind, name: string): CliOutcome {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, stdout: "", stderr: "", errorReason: `invalid name: ${name}` };
  }
  return runCli(binaryFor(runner), ["mcp", "remove", name]);
}

// Add a stdio MCP server. Both CLIs accept `<name> -- <cmd> [args...]`.
// Claude defaults to local scope; we pin to `user` so the server is visible
// across projects — that matches what most users expect from a global TUI.
export function addMcp(
  runner: RunnerKind,
  name: string,
  command: string,
  args: string[],
): CliOutcome {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, stdout: "", stderr: "", errorReason: `invalid name: ${name}` };
  }
  if (runner === "claude") {
    return runCli("claude", ["mcp", "add", "-s", "user", name, "--", command, ...args]);
  }
  return runCli("codex", ["mcp", "add", name, "--", command, ...args]);
}

export function getMcp(runner: RunnerKind, name: string): CliOutcome {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, stdout: "", stderr: "", errorReason: `invalid name: ${name}` };
  }
  return runCli(binaryFor(runner), ["mcp", "get", name]);
}

export type McpTestResult = {
  ok: boolean;
  // One-line summary suitable for the notice headline.
  summary: string;
  // Tail of stderr captured during the spawn window, if any.
  stderrTail: string;
  // The command we actually spawned, for debugging.
  command?: string;
};

// Parse `<runner> mcp get <name>` output. Both CLIs print human-readable text;
// we look for a `command` / `Command` line followed by `args` / `Args` to
// reconstruct the spawn target. Returns null if we can't tell.
function extractStdioCommand(text: string): { command: string; args: string[] } | null {
  const cmdMatch = text.match(/^\s*(?:command|Command)\s*[:=]\s*(.+)$/m);
  if (!cmdMatch) return null;
  const command = cmdMatch[1].trim().replace(/^["']|["']$/g, "");
  // Args line may be `args: [ "-y", "x" ]` (codex) or `Args: -y x` (claude).
  const argsLineMatch = text.match(/^\s*(?:args|Args)\s*[:=]\s*(.+)$/m);
  let args: string[] = [];
  if (argsLineMatch) {
    const raw = argsLineMatch[1].trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        args = JSON.parse(raw.replace(/'/g, '"'));
      } catch {
        args = raw.slice(1, -1).split(/\s*,\s*/).map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else {
      args = raw.split(/\s+/).filter(Boolean);
    }
  }
  return { command, args };
}

// Spawn the configured server for a brief window. A live MCP server should
// still be running when we kill it; immediate exit means something is wrong.
export async function testMcp(runner: RunnerKind, name: string): Promise<McpTestResult> {
  const getOut = getMcp(runner, name);
  if (!getOut.ok) {
    return {
      ok: false,
      summary: `failed to read server config: ${getOut.errorReason ?? "unknown"}`,
      stderrTail: tail(getOut.stderr),
    };
  }
  const parsed = extractStdioCommand(getOut.stdout);
  if (!parsed) {
    return {
      ok: false,
      summary: "could not parse command from `mcp get` output (non-stdio server, or unknown format)",
      stderrTail: tail(getOut.stdout),
    };
  }
  const { command, args } = parsed;
  return await new Promise<McpTestResult>((resolve) => {
    let settled = false;
    let stderr = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const settle = (result: McpTestResult) => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {}
      }, 200).unref?.();
      resolve(result);
    };
    child.on("error", (err) => {
      settle({
        ok: false,
        summary: `spawn failed: ${err.message}`,
        stderrTail: tail(stderr),
        command: `${command} ${args.join(" ")}`.trim(),
      });
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("exit", (code, signal) => {
      // Exit during the watch window means the server crashed on startup.
      settle({
        ok: false,
        summary:
          signal
            ? `exited via ${signal} before window closed`
            : `exited with code ${code} before window closed`,
        stderrTail: tail(stderr),
        command: `${command} ${args.join(" ")}`.trim(),
      });
    });
    setTimeout(() => {
      settle({
        ok: true,
        summary: "still running after 2s — looks healthy",
        stderrTail: tail(stderr),
        command: `${command} ${args.join(" ")}`.trim(),
      });
    }, 2000).unref?.();
  });
}

function tail(s: string, lines = 8): string {
  if (!s) return "";
  const arr = s.split(/\r?\n/).filter((l) => l.length > 0);
  return arr.slice(-lines).join("\n");
}
