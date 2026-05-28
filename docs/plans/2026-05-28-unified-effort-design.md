# Unified `/effort` command — design

Date: 2026-05-28

## Goal

Add a `/effort` slash command to the TUI with an interactive horizontal slider
(Speed <-> Intelligence) that controls per-model reasoning effort across all
three harnesses the backend drives: the Claude Agent SDK, the Codex SDK, and the
Vercel AI SDK. It mirrors the existing `/model` feature end to end.

## Decisions

- **Per-runner native stops.** The slider shows the levels the *active runner +
  active model* actually supports. Stops redraw when the runner or model
  changes. (Chosen over a canonical clamped scale and over lowest-common-denominator.)
- **Per-runner storage.** Each runner keeps its own effort, mirroring
  `ModelOverrides`. `Session.efforts = {claude?, codex?, vercel?}`.
- **Levels are API-discovered, never hardcoded as logic.** Resolution source
  differs by provider (see below). The hard requirement: no scattered per-model
  conditionals; all level data flows through one resolution layer.
- **OpenAI gap is an authored typed catalog.** No OpenAI capability API exists
  and SDK level enums are compile-time TS types (erased at runtime), so per-model
  OpenAI/Codex levels cannot be fetched at runtime. The floor is a single
  `as const` catalog whose level vocabulary is compile-time-checked against the
  SDKs' own exported unions, so it can't silently drift. Only the per-model
  mapping is authored.

## Verified provider reality

| Provider | Per-model levels at runtime via API? | Source |
|---|---|---|
| Anthropic (claude runner; vercel -> `claude-*`) | Yes | `anthropic.models.retrieve(id).capabilities.effort` -> `{low,medium,high,max}` (each `CapabilitySupport`) + `xhigh: CapabilitySupport \| null` + top-level `supported`. Includes `xhigh`. |
| Codex (`@openai/codex-sdk`) | No | only `type ModelReasoningEffort = "minimal"|"low"|"medium"|"high"|"xhigh"` (erased at runtime); `/v1/models` has no capability metadata |
| Vercel -> OpenAI (`@ai-sdk/openai`) | No | only `reasoningEffort?: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"` (type, erased) |

SDK injection points (verified against installed type defs):

- Claude Agent SDK: `options.effort` (`"low"|"medium"|"high"|"xhigh"|"max"`).
- Codex SDK: `ThreadOptions.modelReasoningEffort` (`minimal..xhigh`, no `max`).
- Vercel AI SDK (OpenAI provider): `providerOptions.openai.reasoningEffort`.
- Vercel AI SDK (Anthropic provider) / `gpt-4o*`: no effort param -> N/A.

## Capability resolution (server-owned)

The server resolves effort capability for the session's active runner+model and
attaches it to `Session`, recomputed whenever the runner or model changes (mirrors
how `contextUsage` / `git` are server-computed and pushed today). The TUI slider
reads it off `Session` — no extra request/response message.

- Anthropic models: `models.retrieve(modelId)` (API key is server-side), read
  `capabilities.effort`, build ordered supported levels `[low,medium,high,xhigh,max]`
  filtered by each `.supported` (treat `xhigh: null` and top-level
  `supported: false` as unsupported). Cache per modelId in-memory.
- OpenAI models: lookup in `shared/effort.ts` `OPENAI_EFFORT` (`[1m]` stripped first).
- No-effort models (Haiku 4.5, gpt-4o*, etc.): `levels: []`.

## Data model (`shared/events.ts`)

```ts
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; // ordered union
export type EffortOverrides = { claude?: EffortLevel; codex?: EffortLevel; vercel?: EffortLevel };

// On Session:
//   efforts: EffortOverrides                       // chosen override per runner (mirrors ModelOverrides)
//   effortInfo?: { levels: EffortLevel[]; source: "api" | "catalog" } | null  // for the active runner+model

// ClientMsg gains (mirrors set_model):
//   { type: "set_effort"; sessionId: string; runner: RunnerKind; effort: EffortLevel | null }  // null clears
```

## `shared/effort.ts` (new)

- `OPENAI_EFFORT` — `as const` table mapping OpenAI model ids to ordered levels,
  level values typed against the SDK unions so they can't drift.
- `effortLevelsFromAnthropic(capabilities)` — maps the Models API
  `EffortCapability` to an ordered `EffortLevel[]`.
- `clampEffort(levels, requested)` — nearest supported `<=` requested; returns
  `null` if `levels` is empty.
- `effortLevelsFor(...)` — single consumer entry point used by TUI + server.

## TUI

- `tui/src/util/slash.ts` — `EffortAction` mirroring `ModelAction`
  (`picker | show | set <level> | setRunner <runner> <level> | reset | resetRunner <runner>`),
  `parseEffortAction`, `SlashCommand` union member, `parseSlash` case `"effort"`,
  `SLASH_COMMANDS` help entry. Validate level against the `EffortLevel` set.
- `tui/src/components/EffortSlider.tsx` (new) — horizontal Speed<->Intelligence
  slider rendering `session.effortInfo.levels`. `<-`/`->` adjust, Enter confirm,
  Esc cancel, `r` reset-to-default. Disabled line "effort not supported for
  <model>" when `levels` is empty. Runner accent like `ModelPicker`.
- Unset override: no `(default)` badge (the per-model default is not
  API-discoverable for either provider); cursor opens on the median supported
  stop; first Enter writes the override.
- `tui/src/app.tsx` — mirror the `ModelPicker` overlay toggle: picker -> open
  slider; set/reset -> send `set_effort` + notice; show -> notice listing all
  runners' efforts.

## Server

- `server/src/sessions.ts` (+ dispatch in `index.ts`) — store `efforts`,
  recompute `effortInfo` on runner/model change, pass the active runner's clamped
  effort into the run call.
- `server/src/runners/claude.ts` — `options.effort = clampEffort(levels, efforts.claude)`.
- `server/src/runners/codex.ts` — `threadOptions.modelReasoningEffort = clampEffort(levels, efforts.codex)`.
- `server/src/runners/vercel.ts` — OpenAI model: `providerOptions.openai.reasoningEffort = clampEffort(levels, efforts.vercel)`; Anthropic / gpt-4o: ignore.
- All runners clamp server-side against the resolved `levels` (sessions outlive
  model picks; also guards stale clients).

## Lifecycle

- `/clear` — efforts persist (session config, not transcript; mirrors `/model`).

## Tests

- `tui/src/util/slash` parse tests for `/effort` (mirror existing parse-test style).
- `shared/effort` tests: `OPENAI_EFFORT` lookups (incl. `[1m]` strip and empty for
  no-effort models), `effortLevelsFromAnthropic` mapping, `clampEffort` nearest-`<=`.
- Slider component test is nice-to-have, not required.
- ASCII only in source/tests.

## Touch list (~9 files)

`shared/events.ts`, `shared/effort.ts` (new), `tui/src/util/slash.ts`,
`tui/src/components/EffortSlider.tsx` (new), `tui/src/app.tsx`,
`server/src/runners/{claude,codex,vercel}.ts`, server session/dispatch wiring
(`server/src/sessions.ts` / `server/src/index.ts`), plus the two test files.
