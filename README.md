# adverserial-code

A custom coding-agent TUI built on [OpenTUI](https://opentui.com/).
Drives Claude Code and Codex side-by-side from one terminal.

The TUI is a React app rendered into the terminal via `@opentui/react`. It
talks to a local Node backend over a single WebSocket; the backend owns the
agent loops (`@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`) and
streams normalised events back as the model thinks and tools execute.

## Layout

```
adverserial-code/
  shared/events.ts        WS protocol (Session, ClientMsg, ServerMsg)
  server/                 Hono + WebSocket; runs the two SDKs
    src/
      index.ts            ws route + turn dispatch
      sessions.ts         in-memory session manager
      runners/            claude.ts and codex.ts SDK adapters
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

## Setup

Requires Node.js >= 20 and Bun (`curl -fsSL https://bun.sh/install | bash`).

```
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY and/or OPENAI_API_KEY
```

## Run

```
npm start
```

Boots the backend in the background (logs to `~/.adverserial-code/server.log`)
and launches the TUI. On exit the backend is killed.

To run the backend standalone:

```
npm run server
```

## Inside the TUI

- Prompt — type a message, Enter to send.
- `/claude`, `/codex` — pick the runner for the active session.
- `/switch` — flip between Claude and Codex.
- `Esc` — leave the prompt and enter browse mode.
- Browse mode: `j` / `k` cycle sessions, `n` new session, `dd` (double-d) delete.
- `Enter` from browse mode returns focus to the prompt.
- Up / Down in the prompt walk history; `@<partial>` opens fuzzy file completion.

## How it works

1. The TUI opens one WebSocket to `ws://127.0.0.1:4567/ws`.
2. Sending a prompt posts `{ type: "send", sessionId, text }` to the server.
3. The server picks the session's active runner (Claude or Codex), drives the
   SDK to completion, and broadcasts `RunEvent`s (`text_delta`, `tool_log`,
   `usage`, `error`) wrapped in `{ type: "event", ... }` server messages.
4. All connected clients see the same broadcast stream — session state is
   server-owned, the TUI is a thin projection.
5. Per-session SDK continuity (`claudeSessionId` / `codexThreadId`) stays in
   server memory; restart the server and conversations reset.

## Development

```
npm run typecheck   # both workspaces
```

Environment overrides:

- `PORT` — server port (default 4567)
- `ADVERSERIAL_SERVER_URL` — base URL the TUI fetches/upgrades from
