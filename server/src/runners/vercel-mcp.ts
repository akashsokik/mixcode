// MCP server enumeration + lifecycle for the Vercel runner.
//
// The Claude SDK and Codex CLI both auto-load user-configured MCP servers
// from their own state files. The Vercel runner has no such ambient loader,
// so we read Claude's config (`~/.claude.json` -> `mcpServers`) directly and
// spawn each as a stdio MCP client via `@ai-sdk/mcp`. The resulting tools
// are merged into streamText's tool set so vercel sessions have the same
// MCP surface a claude session would.
//
// Lifecycle is per-turn: spawn at turn start, close in finally. Each spawn
// is timeout-bounded and isolated via Promise.allSettled — a single broken
// server cannot hang or block the others.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";

const CONNECT_TIMEOUT_MS = 5_000;
const TOOLS_TIMEOUT_MS = 5_000;

type StdioServerSpec = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type LoadedMcp = {
  tools: ToolSet;
  // Names of servers that connected successfully, for logging.
  loaded: string[];
  // { name, reason } for servers that failed (timeout, missing binary,
  // schema errors, etc). Surfaced to the user as a single tool_log so
  // they know which MCP server isn't reaching the vercel runner.
  failed: Array<{ name: string; reason: string }>;
  close: () => Promise<void>;
};

const EMPTY_MCP: LoadedMcp = {
  tools: {} as ToolSet,
  loaded: [],
  failed: [],
  close: async () => {},
};

// Read Claude's MCP server registry. Returns [] silently when the file is
// missing (e.g. user has never run `claude mcp add`) — MCP is optional, not
// a required feature.
async function readClaudeMcpConfig(): Promise<StdioServerSpec[]> {
  const filePath = path.join(homedir(), ".claude.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") return [];

  const out: StdioServerSpec[] = [];
  for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as {
      type?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
    // Only stdio is supported here. HTTP/SSE transports exist but require a
    // running URL — out of scope for the local-TUI use case.
    if (r.type && r.type !== "stdio") continue;
    if (typeof r.command !== "string" || !r.command) continue;
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === "string")
      : [];
    const env: Record<string, string> = {};
    if (r.env && typeof r.env === "object") {
      for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    out.push({ name, command: r.command, args, env });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

type ConnectResult =
  | { ok: true; name: string; client: Awaited<ReturnType<typeof createMCPClient>>; tools: ToolSet }
  | { ok: false; name: string; reason: string };

async function connectOne(spec: StdioServerSpec): Promise<ConnectResult> {
  const transport = new Experimental_StdioMCPTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    // MCP child stderr defaults to "inherit", which routes the spawned
    // server's startup banners + diagnostics into the TUI's terminal —
    // they peek through before the next OpenTUI render and corrupt the
    // prompt placeholder area. "ignore" sends them to /dev/null. Cost:
    // a misbehaving server's stderr is invisible; the connect/tools
    // timeout below still catches "never responds" cases.
    stderr: "ignore",
  });
  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  try {
    client = await withTimeout(
      createMCPClient({ transport }),
      CONNECT_TIMEOUT_MS,
      `mcp:${spec.name} connect`,
    );
    const tools = (await withTimeout(
      client.tools(),
      TOOLS_TIMEOUT_MS,
      `mcp:${spec.name} tools`,
    )) as ToolSet;
    return { ok: true, name: spec.name, client, tools };
  } catch (err) {
    // Connect or tools() failed/timed out — kill the spawned child so we
    // don't leak it. Prefer client.close() if the client made it past
    // construction; otherwise close the transport directly.
    try {
      if (client) await client.close();
      else await transport.close();
    } catch {
      // best-effort cleanup
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, name: spec.name, reason };
  }
}

// Spawn every stdio MCP server in Claude's config, merge their tools, and
// return a handle that closes them all when the turn ends. Safe to call
// when no config exists — returns an empty handle.
//
// Tool name collisions across servers: later wins. Matches the @ai-sdk/mcp
// documented merge semantics (`{ ...toolSetOne, ...toolSetTwo }`). We
// namespace nothing — keep the surface identical to what Claude sees.
export async function loadMcpForVercel(): Promise<LoadedMcp> {
  const specs = await readClaudeMcpConfig();
  if (specs.length === 0) return EMPTY_MCP;

  const results = await Promise.allSettled(specs.map(connectOne));
  const clients: Array<Awaited<ReturnType<typeof createMCPClient>>> = [];
  const loaded: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  let merged: ToolSet = {} as ToolSet;

  for (const r of results) {
    if (r.status === "rejected") {
      // Should not happen — connectOne already catches — but cover it.
      failed.push({ name: "?", reason: String(r.reason) });
      continue;
    }
    const v = r.value;
    if (!v.ok) {
      failed.push({ name: v.name, reason: v.reason });
      continue;
    }
    clients.push(v.client);
    loaded.push(v.name);
    merged = { ...merged, ...v.tools };
  }

  return {
    tools: merged,
    loaded,
    failed,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
