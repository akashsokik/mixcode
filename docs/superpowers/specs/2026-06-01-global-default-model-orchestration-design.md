# Global default model for orchestration tools

Date: 2026-06-01

## Problem / goal

The per-session `/model` override is applied only to the top-level active agent.
Every spawned peer -- `delegate_run`, `validate_run`, `task_spawn`, workflow
nodes, consensus, and collab -- spawns with `model: undefined` and silently
falls back to the runner's hardcoded default (e.g. Ollama's `pickDefaultModel`).
There is currently no knob that controls what model these orchestration tools
run on.

Goal: a machine-wide per-runner default model, settable from the command
palette, that governs the active agent AND every tool it spawns, with an
optional per-session override layered on top.

## Resolution precedence (single source of truth)

```
session.models[runner]    // per-session override (existing)
  ?? globalModels[runner]  // new machine-wide default
  ?? undefined             // runner's hardcoded default (unchanged)
```

`undefined` continues to mean "let the runner pick its own default" -- the
runner default-pick logic itself does not change.

## Storage -- extend the existing store file

Reuse the existing `~/.adverserial-code/sessions.json` store rather than adding
a new config file.

- `shared/events.ts`: reuse the existing `ModelOverrides` shape. The on-disk
  `StoreFile` gains an optional `globalModels?: ModelOverrides` field alongside
  `sessions`.
- `server/src/sessions.ts` `SessionManager`:
  - hold `globalModels: ModelOverrides` in memory;
  - load it from `StoreFile` on startup (absent -> empty map) and persist it in
    the existing debounced write;
  - add `getGlobalModel(runner): string | undefined`,
    `setGlobalModel(runner, model: string | null)` (trim/delete semantics
    matching the existing `setModel`), and `getGlobalModels(): ModelOverrides`;
  - `setGlobalModel` marks the store dirty and broadcasts a new
    `global_models_updated` ServerMsg.

## Injected resolver -- one chokepoint, no per-site edits

`startRun` (in `server/src/runners/delegate.ts`) is the single funnel that every
peer spawn reaches: it holds the only calls to `runClaude` / `runCodex` /
`runOllama` / `runVercel` for peers. Two paths feed it -- `executeDelegate`
(behind `delegate_run`, and `validate_run` via `executeValidate`) calls
`startRun` directly, while `task_spawn`, `consensus.ts`, `collab.ts`, and
workflow dispatch call it through the `startSubtaskRun` wrapper. Both carry
`ctx.parentSessionId` / `args.runner`, so the resolution happens in `startRun`,
once, and cannot be bypassed.

(An earlier draft placed the hook in `startSubtaskRun`; that would have missed
`delegate_run` and `validate_run`, which skip the wrapper and call `startRun`
directly -- hence the move one layer down.)

Add a module-level registrable resolver mirroring the existing
`registerParentCallbacks` pattern:

```ts
let modelResolver: (sessionId: string, runner: RunnerKind) => string | undefined =
  () => undefined;
export function registerModelResolver(
  fn: (sessionId: string, runner: RunnerKind) => string | undefined,
): void {
  modelResolver = fn;
}
```

Inside `startRun`, resolve the model before invoking the runner:

```ts
const model = resolvePeerModel(args.model, ctx.parentSessionId, args.runner);
```

where `resolvePeerModel` is the exported, unit-testable helper
`(explicit) => explicit ?? modelResolver(sessionId, runner)`. Because
`workflow_add_node` supplies an explicit
per-node `model`, that value is already present in `args.model` and still wins;
only an undefined model triggers the resolver. No spawn-site call sites need to
change.

`index.ts` registers the resolver at server startup:

```ts
registerModelResolver(
  (sid, runner) => sessions.get(sid)?.models[runner] ?? sessions.getGlobalModel(runner),
);
```

The four top-level active-agent reads in `index.ts`
(`session.models.claude` / `.codex` / `.vercel` / `.ollama`) switch to a shared
helper using the same precedence, so the lead agent and its spawned peers
resolve identically.

## Wire protocol (`shared/events.ts`)

- ClientMsg: `{ type: "set_global_model"; runner: RunnerKind; model: string | null }`.
- ServerMsg: `{ type: "global_models_updated"; globalModels: ModelOverrides }`.
- The initial `globalModels` is included in the existing bootstrap/hello payload
  so clients know the current defaults on connect.

Server `index.ts` handles `set_global_model` by calling
`sessions.setGlobalModel(runner, model)` (which broadcasts the update).

## Command palette / TUI

- `tui/src/components/ModelPicker.tsx` gains a scope toggle (Tab) between
  "this session" and "global default". On select it calls either
  `api.setModel` (session) or the new `api.setGlobalModel` (global). The
  picker header shows the current global default for the runner.
- `/model` parsing in `tui/src/util/slash.ts` gains:
  - `/model global <name>` -> set global default for the active runner;
  - `/model global <runner> <name>` -> set global default for a specific runner;
  - `/model global reset` (and `global <runner> reset`) -> clear it.
  These produce new `ModelAction` variants wired up in `tui/src/app.tsx`.
- `/model show` lists both the session override and the global default per
  runner.
- The TUI client (`useApi`) gains `setGlobalModel(runner, model)` sending the
  new ClientMsg, and stores `globalModels` received from the new ServerMsg and
  from bootstrap.

## Testing

- `sessions.ts`: global model set/get/reset; persistence round-trips through
  `StoreFile`; broadcast fires on set.
- Resolver precedence: session override > global default > undefined;
  `workflow_add_node` explicit model still wins over both.
- `resolvePeerModel`: with no explicit model and a registered resolver, the
  resolved model is returned; with an explicit model set, the resolver is not
  consulted; with neither, returns undefined. Structural guarantee that the
  four peer-runner calls live only in `startRun` (so the hook can't be
  bypassed) is covered by code review, not a spawning test.
- `slash.ts`: parsing for `global <name>`, `global reset`,
  `global <runner> <name>`, `global <runner> reset`.
- All test/source strings ASCII, no emojis (repo convention).

## Out of scope (YAGNI)

- No separate per-tool model map (one default per runner governs all tools).
- No new `config.json` / ConfigStore.
- No changes to runner default-pick logic.
- consensus.ts and collab.ts are covered for free by the central resolver; no
  bespoke handling.
