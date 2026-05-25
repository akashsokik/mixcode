# adverserial-code

A custom coding-agent TUI built on [OpenTUI](https://opentui.com/). Drives Claude Code, Codex, and the Vercel AI SDK side-by-side from one terminal.

The TUI is a React app rendered into the terminal via `@opentui/react`. It talks to a local Node backend over a single WebSocket; the backend owns the agent loops (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, and `ai` with `@ai-sdk/openai`) and streams normalised events back as the model thinks and tools execute.

---

## Layout

```
adverserial-code/
  shared/events.ts        WS protocol (Session, ClientMsg, ServerMsg)
  server/                 Hono + WebSocket; runs the two SDKs
    src/
      index.ts            ws route + turn dispatch
      sessions.ts         in-memory session manager
      runners/            claude.ts, codex.ts, vercel.ts SDK adapters
  tui/                    Bun + React + @opentui/react
    src/
      index.tsx
      app.tsx             layout: header / sidebar / transcript / prompt / status
      api/ws.ts           WebSocket client
      state/              session + history + completion hooks
      components/         Header, Sidebar, Transcript, ToolCard, Prompt, StatusBar
      util/               format, fuzzy, files, slash parsing
  bin/start.mjs           spawns the server (Node) and the TUI (Bun)
```

---

## Setup

**Requirements:** Node.js ≥ 20 and Bun

```bash
curl -fsSL https://bun.sh/install | bash
bun install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY and/or OPENAI_API_KEY
```

---

## Run

```bash
bun start
```

Boots the backend in the background (logs to `~/.adverserial-code/server.log`) and launches the TUI. On exit the backend is killed.

### Run backend standalone

```bash
bun run server
```

### `mixcode` — per-PWD launcher

After `bun link` (run once in this repo), a `mixcode` command is available on `PATH`. Running it boots a backend + TUI scoped to the directory it was invoked from:

```bash
cd ~/code/some-project
mixcode
```

Each PWD gets its own sessions store, transcripts, log file and port under `~/.mixcode/projects/<encoded-pwd>/`, so sessions in one project never leak into another. Re-running `mixcode` in the same directory re-attaches to the already-running backend instead of spawning a second.

#### Env file lookup (most specific first)

1. `<pwd>/.env`
2. `~/.mixcode/.env`
3. the install-dir `.env` files (fallback)

---

## Inside the TUI

| Command | Action |
|---------|--------|
| `Enter` | Send message |
| `/claude`, `/codex`, `/vercel` | Pick the runner for the active session |
| `/switch` | Cycle through Claude → Codex → Vercel |
| `Esc` | Leave prompt, enter browse mode |
| `j` / `k` (browse mode) | Cycle sessions |
| `n` (browse mode) | New session |
| `dd` (browse mode) | Delete session |
| `Enter` (browse mode) | Return focus to prompt |
| `↑` / `↓` (prompt) | Walk history |
| `@<partial>` (prompt) | Fuzzy file completion |

---

## How it works

1. The TUI opens one WebSocket to `ws://127.0.0.1:4567/ws`
2. Sending a prompt posts `{ type: "send", sessionId, text }` to the server
3. The server picks the session's active runner (Claude, Codex, or Vercel), drives the SDK to completion, and broadcasts `RunEvent`s (`text_delta`, `tool_log`, `usage`, `error`) wrapped in `{ type: "event", ... }` server messages
4. All connected clients see the same broadcast stream — session state is server-owned, the TUI is a thin projection
5. Per-session SDK continuity (`claudeSessionId` / `codexThreadId` / `vercelMessages`) stays in server memory; restart the server and conversations reset. The Vercel runner is stateless at the SDK level, so the full `ModelMessage[]` is replayed on every turn

---

## Development

```bash
bun run typecheck   # both workspaces
```

### Environment overrides

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `4567` |
| `ADVERSERIAL_SERVER_URL` | Base URL the TUI fetches/upgrades from | — |
| `VERCEL_MODEL` | Default OpenAI model ID for the Vercel runner | `gpt-4o` |
| `VERCEL_MAX_STEPS` | Agent-loop step cap for the Vercel runner | `20` |

---

## The Vercel runner

`server/src/runners/vercel.ts` wraps `streamText` from the `ai` package and routes by model-id prefix:

- `claude-*` → `@ai-sdk/anthropic` (requires `ANTHROPIC_API_KEY`)
- `gpt-*` / `o*-*` / everything else → `@ai-sdk/openai` (requires `OPENAI_API_KEY`)

`/model vercel <id>` accepts any model either provider's SDK understands. The `[1m]` context-window suffix used by the Claude runner is silently stripped on vercel (the Anthropic API has no equivalent selector — users who need 1M context should stay on the Claude runner).

Unlike Claude / Codex (which ship with their own coding tools), the Vercel runner exposes a deliberately small hand-rolled tool kit — `Bash`, `Read`, `Write` — that routes each call through the same `PermissionStore` Claude uses, so `/permissions` rules and the `acceptEdits` / `bypassPermissions` modes apply identically.

### Caveats vs other runners

- **No skills / MCP integration** — `~/.vercel/skills` doesn't exist; `/skills` and `/mcp` print an "unsupported" notice
- **No delegated runs** — No `delegate_run` / `validate_run` / `task_*` tools exposed to the model (Vercel sessions don't fan out to peers in v1). Vercel can still be *spawned* as a peer reviewer via `/consensus` participants or via `delegate_run` from a Claude / Codex parent
- **Fixed consensus pairing** — `/consensus` is hardcoded to Claude ↔ Codex pairing
