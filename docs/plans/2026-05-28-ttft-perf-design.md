# Phase-1 TTFT performance patch

**Goal:** Materially reduce wall-clock time-to-first-token (TTFT) for the codex
and claude runners, and add the instrumentation needed to attribute the
remaining cost before committing to the larger Phase-2/3 work.

## Problem

The TTFT the user observes (the spinner's `thought for Ns`, `Spinner.tsx:48-67`)
is wall-clock from assistant-placeholder creation (`index.ts:705`, before the
runner is even invoked) to the first visible `text_delta`. Inside that window,
per turn:

1. Cold subprocess spawn + SDK init, every turn. Neither runner reuses a
   process: claude calls `query()` with a string prompt (`claude.ts:257`); codex
   spawns `codex exec` per `runStreamed` (`@openai/codex-sdk` spawns a fresh
   child each run).
2. Claude init loads `skills: "all"` + enabled plugins + marketplaces on every
   spawn (`claude.ts:163,179`).
3. Codex spawns an extra Node MCP child (`node mcp-codex-orchestrator.mjs`) and
   completes an MCP initialize + list-tools handshake every turn, because the
   orchestrator is wired unconditionally (`index.ts:867`, `codex.ts:71-89`).
   Claude's orchestrator MCP is in-process (`createSdkMcpServer`,
   `delegate.ts:513`) -- no child, no handshake. This is the structural reason
   codex TTFT > claude TTFT.
4. Model reasoning is fully counted: both runners drop reasoning/thinking from
   the visible stream (`claude.ts:300-303`, `codex.ts:238-250`), so all reasoning
   time lands inside the measured TTFT. Codex sets no reasoning effort, so it
   runs at the CLI default (medium for gpt-5-codex).

We can name these contributors but cannot yet attribute seconds to each. The
codex effort win is robust regardless; the claude warm-process win (Phase 2) is
conditional on spawn/init being a large fraction, which we must measure first.

## Scope (this patch)

Three low-risk changes. No architecture change. Default behavior preserved
except the codex effort default.

### Change 1 -- Per-turn timing instrumentation (both runners)

New helper `server/src/runners/perf.ts`:

- `startTurnPerf(runner)` captures `t0` and returns `{ mark, done }`.
- `mark("init")` records the first SDK message/event time (spawn + init done).
- `mark("firstText")` records the first emitted `text_delta`.
- `done()` emits one concise line via `console.error` when `ADVERSARIA_PERF=1`,
  otherwise no-op.
- `formatPerfLine(runner, marks)` builds the line and is unit-tested.

Output: `[perf:codex] spawn+init=Xms prefill+reasoning=Yms toFirstText=Zms`.
This splits spawn+init (`t0 -> tInit`) from prefill+reasoning until first visible
text (`tInit -> tFirstText`) -- the attribution we currently lack.

Wiring:
- `claude.ts`: `startTurnPerf("claude")` before the `for await` loop;
  `mark("init")` on the first message; `mark("firstText")` on the first
  `text_delta` emit; `done()` in a `finally`.
- `codex.ts`: `startTurnPerf("codex")` before `runStreamed`; `mark("init")` on
  the first stream event; `mark("firstText")` inside `emitAgentDelta` on the
  first delta; `done()` in a `finally`.

Temporary: gated behind `ADVERSARIA_PERF` and isolated in one file so it is
trivial to remove once the perf work concludes.

### Change 2 -- Codex reasoning effort default to "low"

- Add `reasoningEffort?: ModelReasoningEffort` to `CodexRunArgs`
  (`@openai/codex-sdk` exports the type).
- In `runCodex`, inject `threadOptions.modelReasoningEffort = reasoningEffort`
  when set (`codex.ts:119-138`).
- At the call site (`index.ts:851`), pass `reasoningEffort: "low"`.

This is the same injection point the in-flight `/effort` plan
(`docs/plans/2026-05-28-unified-effort.md`) designates, so it is
forward-compatible: when `/effort` lands, the call site becomes
`session.effort?.codex ?? "low"`. Trades some reasoning depth for speed; biggest
predictable codex wall-clock win.

### Change 3 -- Env-gated orchestrator drop (experiment)

Guard the `orchestrator` arg to `runCodex` behind `ADVERSARIA_NO_CODEX_ORCH=1`
(`index.ts:867`). When set, pass `orchestrator: undefined` so codex skips the
Node MCP child spawn + handshake. `runCodex` already treats `orchestrator` as
optional. Default unchanged. Lets us run identical turns with/without the child
and read the perf-line delta -- confirming whether the MCP child is the codex>
claude gap (and thus whether Phase 3 is worth it).

## Verification

- `npm --workspace server run test` (includes the new `formatPerfLine` test).
- `npm run typecheck`.
- No event-handling logic changes, so existing runner behavior is unaffected.
- Per the user's standing instruction, the server is not started here. The user
  reads the `[perf:...]` lines and runs the orchestrator-drop experiment on
  their next launch.

## Expected effect

Codex `low` effort should cut several seconds off `tInit -> tFirstText`
immediately. The instrumentation + experiment then tell us whether the remaining
gap is spawn/init (-> warm-process Phase 2 for claude via streaming-input mode)
or the MCP child (-> Phase 3 for codex), so the larger refactor is data-driven.

## Out of scope (later phases)

- Phase 2: claude persistent per-session process via streaming-input mode
  (`query()` accepts `AsyncIterable<SDKUserMessage>`).
- Phase 3: slim or gate the codex orchestrator MCP child based on the
  experiment result.
