import { spawn } from "node:child_process";
import type { GitInfo } from "../../shared/events.js";

// Read branch + dirty for a directory. Returns null if the path isn't a git
// repo or git isn't installed; never throws. Treats detached-HEAD as branch
// = short SHA so the status bar still shows something useful.
//
// Implementation uses `spawn` directly with an array of args — no shell, so
// the cwd value is never interpreted as a command. Safe to call on any path.
export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const inside = await run(["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside.trim() !== "true") return null;
  } catch {
    return null;
  }

  const [branchResult, statusResult] = await Promise.allSettled([
    run(["rev-parse", "--abbrev-ref", "HEAD"], cwd).then((s) => s.trim()),
    run(["status", "--porcelain"], cwd),
  ]);

  let branch: string | null = null;
  if (branchResult.status === "fulfilled") {
    const v = branchResult.value;
    if (v === "HEAD") {
      try {
        branch = (await run(["rev-parse", "--short", "HEAD"], cwd)).trim();
      } catch {
        branch = "HEAD";
      }
    } else if (v) {
      branch = v;
    }
  }

  const dirty =
    statusResult.status === "fulfilled" && statusResult.value.trim().length > 0;

  return { branch, dirty };
}

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("git timed out"));
    }, 2000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git exited with ${code}`));
    });
  });
}

export function gitInfoEquals(a: GitInfo | null, b: GitInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.branch === b.branch && a.dirty === b.dirty;
}
