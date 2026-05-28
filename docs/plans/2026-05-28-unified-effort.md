# Unified `/effort` Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/effort` slash command with an interactive horizontal slider that sets per-model reasoning effort for the active runner (Claude Agent SDK / Codex SDK / Vercel AI SDK), mirroring the existing `/model` feature.

**Architecture:** Effort is a per-runner override on `Session` (mirrors `ModelOverrides`). The level set a runner+model supports is resolved server-side and attached to `Session.effortInfo`: Claude/Anthropic models are discovered live via the Anthropic Models API (`models.retrieve(...).capabilities.effort`); OpenAI/Codex models use a single authored catalog in `shared/effort.ts` (no runtime capability API exists for them). The TUI slider renders `session.effortInfo.levels`; runners inject the clamped level into their SDK call.

**Tech Stack:** TypeScript, OpenTUI/React (TUI), Hono + Bun WebSocket (server), `@anthropic-ai/sdk`, `@openai/codex-sdk`, `@ai-sdk/openai`. Tests: `bun test` (tui + shared), `node --test` (server). ASCII only in source/tests.

**Design doc:** `docs/plans/2026-05-28-unified-effort-design.md`

**Key facts (verified against installed type defs):**
- Claude Agent SDK injection: `options.effort` (`"low"|"medium"|"high"|"xhigh"|"max"`).
- Codex SDK injection: `ThreadOptions.modelReasoningEffort` (`"minimal"|"low"|"medium"|"high"|"xhigh"`, no `max`).
- Vercel `@ai-sdk/openai` injection: `providerOptions.openai.reasoningEffort` (`"none"|"minimal"|"low"|"medium"|"high"|"xhigh"`).
- Anthropic Models API: `models.retrieve(id).capabilities.effort` is `{ low, medium, high, max: CapabilitySupport; xhigh: CapabilitySupport | null; supported: boolean }` (each `CapabilitySupport` has `.supported: boolean`).

---

## Task 1: Shared types in `shared/events.ts`

**Files:**
- Modify: `shared/events.ts`

No test (type-only). Verified by `typecheck` in Task 9's gate and incrementally below.

**Step 1: Add the effort types after `ModelOverrides` (around line 94)**

```ts
// Canonical, ordered superset of reasoning-effort levels across all runners.
// A given runner+model supports a subset; the supported subset for the active
// runner+model is resolved server-side into Session.effortInfo.
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Per-runner effort override. Unset means the runner's SDK default is used.
export type EffortOverrides = {
  claude?: EffortLevel;
  codex?: EffortLevel;
  vercel?: EffortLevel;
};

// Server-resolved effort capability for a session's ACTIVE runner+model. The
// TUI slider renders `levels` directly. `source` is "api" for Anthropic models
// (discovered via the Models API) or "catalog" for OpenAI/Codex models. Empty
// `levels` means the active model has no effort control (e.g. Haiku, gpt-4o).
export type EffortInfo = {
  levels: EffortLevel[];
  source: "api" | "catalog";
};
```

**Step 2: Add fields to the `Session` type (in the `Session` object, after `models: ModelOverrides;`)**

```ts
  efforts: EffortOverrides;
  // Resolved for the active runner+model; recomputed by the server on runner/
  // model change. Null until first resolution. Empty levels = no effort control.
  effortInfo?: EffortInfo | null;
```

**Step 3: Add the `set_effort` client message (in the `ClientMsg` union, after the `set_model` member)**

```ts
  | {
      type: "set_effort";
      sessionId: string;
      runner: RunnerKind;
      // null clears the override and returns to the SDK default
      effort: EffortLevel | null;
    }
```

**Step 4: Commit**

```bash
git add shared/events.ts
git commit -m "feat(effort): add EffortLevel/EffortOverrides/EffortInfo types and set_effort msg"
```

---

## Task 2: `shared/effort.ts` — catalog + pure helpers (TDD)

**Files:**
- Create: `shared/effort.ts`
- Test: `shared/effort.test.ts`

**Step 1: Write the failing test**

Create `shared/effort.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  EFFORT_ORDER,
  isEffortLevel,
  openAiEffortLevels,
  effortLevelsFromAnthropicCapability,
  clampEffort,
} from "./effort.ts";

describe("isEffortLevel", () => {
  test("accepts canonical levels, rejects junk", () => {
    expect(isEffortLevel("xhigh")).toBe(true);
    expect(isEffortLevel("medium")).toBe(true);
    expect(isEffortLevel("turbo")).toBe(false);
    expect(isEffortLevel("")).toBe(false);
  });
});

describe("openAiEffortLevels", () => {
  test("known models return ordered levels", () => {
    expect(openAiEffortLevels("gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
    expect(openAiEffortLevels("gpt-5-codex")).toEqual([
      "minimal", "low", "medium", "high", "xhigh",
    ]);
  });
  test("no-effort models return empty", () => {
    expect(openAiEffortLevels("gpt-4o")).toEqual([]);
    expect(openAiEffortLevels("gpt-4o-mini")).toEqual([]);
  });
  test("strips the [1m] suffix before lookup", () => {
    expect(openAiEffortLevels("gpt-5[1m]")).toEqual(["minimal", "low", "medium", "high"]);
  });
  test("unknown model returns empty (no throw)", () => {
    expect(openAiEffortLevels("o9-ultra")).toEqual([]);
  });
});

describe("effortLevelsFromAnthropicCapability", () => {
  test("maps supported booleans into ordered levels including xhigh", () => {
    const cap = {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
    };
    expect(effortLevelsFromAnthropicCapability(cap)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });
  test("omits unsupported levels and null xhigh", () => {
    const cap = {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: null,
      max: { supported: true },
    };
    expect(effortLevelsFromAnthropicCapability(cap)).toEqual([
      "low", "medium", "high", "max",
    ]);
  });
  test("top-level unsupported yields empty", () => {
    const cap = {
      supported: false,
      low: { supported: false },
      medium: { supported: false },
      high: { supported: false },
      xhigh: null,
      max: { supported: false },
    };
    expect(effortLevelsFromAnthropicCapability(cap)).toEqual([]);
  });
  test("null capability yields empty", () => {
    expect(effortLevelsFromAnthropicCapability(null)).toEqual([]);
  });
});

describe("clampEffort", () => {
  const levels: ReadonlyArray<"low" | "medium" | "high" | "xhigh"> = [
    "low", "medium", "high", "xhigh",
  ];
  test("returns the requested level when supported", () => {
    expect(clampEffort(levels, "high")).toBe("high");
  });
  test("clamps down to nearest supported when requested exceeds set", () => {
    // requested "max" is above every supported level -> highest supported
    expect(clampEffort(levels, "max")).toBe("xhigh");
  });
  test("clamps down when requested sits between/below supported", () => {
    expect(clampEffort(["medium", "high"], "low")).toBe("medium");
  });
  test("returns null when no levels are supported", () => {
    expect(clampEffort([], "high")).toBe(null);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test shared/effort.test.ts`
Expected: FAIL — `Cannot find module './effort.ts'`.

**Step 3: Write minimal implementation**

Create `shared/effort.ts`:

```ts
import type { EffortLevel } from "./events.ts";

// Canonical low->high ordering. All level lists in the app are sorted by this.
export const EFFORT_ORDER: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_RANK: Record<EffortLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export function isEffortLevel(v: string): v is EffortLevel {
  return v in EFFORT_RANK;
}

// Authored catalog for OpenAI/Codex models. No runtime capability API exists
// for OpenAI, so this is the single source of truth for their level sets. The
// level vocabulary is typed as EffortLevel[] so a typo (or a provider adding a
// new level we haven't modelled) is a compile error. Keyed by base model id;
// callers strip any `[1m]` suffix via openAiEffortLevels().
const OPENAI_EFFORT: Record<string, readonly EffortLevel[]> = {
  "gpt-5": ["minimal", "low", "medium", "high"],
  "gpt-5-mini": ["minimal", "low", "medium", "high"],
  "gpt-5-codex": ["minimal", "low", "medium", "high", "xhigh"],
  // gpt-4o family has no reasoning effort -> omit (lookup returns []).
};

function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "").trim();
}

export function openAiEffortLevels(modelId: string): EffortLevel[] {
  const base = stripContextSuffix(modelId);
  const levels = OPENAI_EFFORT[base];
  return levels ? [...levels] : [];
}

// Shape of the Anthropic Models API `capabilities.effort` object. Kept loose
// (per-level objects may be null) so we don't couple to the SDK's exact types
// at the shared layer; the server passes the SDK value straight in.
type AnthropicEffortCapability = {
  supported?: boolean;
  low?: { supported?: boolean } | null;
  medium?: { supported?: boolean } | null;
  high?: { supported?: boolean } | null;
  xhigh?: { supported?: boolean } | null;
  max?: { supported?: boolean } | null;
} | null | undefined;

export function effortLevelsFromAnthropicCapability(
  cap: AnthropicEffortCapability,
): EffortLevel[] {
  if (!cap || cap.supported === false) return [];
  const out: EffortLevel[] = [];
  // Anthropic has no "minimal"; iterate the levels it exposes in canonical order.
  const anthropicLevels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
  for (const level of anthropicLevels) {
    const slot = cap[level as "low" | "medium" | "high" | "xhigh" | "max"];
    if (slot && slot.supported) out.push(level);
  }
  return out;
}

// Nearest supported level <= requested. If the requested level is below every
// supported level, returns the lowest supported. Returns null when no levels
// are supported (caller should omit the effort param entirely).
export function clampEffort(
  levels: readonly EffortLevel[],
  requested: EffortLevel,
): EffortLevel | null {
  if (levels.length === 0) return null;
  const sorted = [...levels].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
  const want = EFFORT_RANK[requested];
  let best: EffortLevel | null = null;
  for (const level of sorted) {
    if (EFFORT_RANK[level] <= want) best = level;
  }
  return best ?? sorted[0];
}
```

**Step 4: Run test to verify it passes**

Run: `bun test shared/effort.test.ts`
Expected: PASS (all cases).

**Step 5: Commit**

```bash
git add shared/effort.ts shared/effort.test.ts
git commit -m "feat(effort): add shared effort catalog and pure helpers"
```

---

## Task 3: `/effort` slash grammar (TDD)

**Files:**
- Modify: `tui/src/util/slash.ts`
- Test: `tui/src/util/slash.test.ts` (new)

**Step 1: Write the failing test**

Create `tui/src/util/slash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseSlash } from "./slash";

describe("/effort parsing", () => {
  test("bare /effort opens the picker", () => {
    expect(parseSlash("/effort")).toEqual({ type: "effort", action: { kind: "picker" } });
  });
  test("show/status/list print current state", () => {
    expect(parseSlash("/effort show")).toEqual({ type: "effort", action: { kind: "show" } });
    expect(parseSlash("/effort status")).toEqual({ type: "effort", action: { kind: "show" } });
  });
  test("a bare level sets the active runner", () => {
    expect(parseSlash("/effort xhigh")).toEqual({
      type: "effort",
      action: { kind: "set", effort: "xhigh" },
    });
  });
  test("runner + level sets a specific runner", () => {
    expect(parseSlash("/effort codex high")).toEqual({
      type: "effort",
      action: { kind: "setRunner", runner: "codex", effort: "high" },
    });
  });
  test("runner alone resets that runner", () => {
    expect(parseSlash("/effort vercel")).toEqual({
      type: "effort",
      action: { kind: "resetRunner", runner: "vercel" },
    });
  });
  test("reset clears the active runner", () => {
    expect(parseSlash("/effort reset")).toEqual({ type: "effort", action: { kind: "reset" } });
  });
  test("an unknown token falls back to show (not a silent set)", () => {
    expect(parseSlash("/effort turbo")).toEqual({ type: "effort", action: { kind: "show" } });
  });
});
```

**Step 2: Run test to verify it fails**

Run (from repo root): `bun test tui/src/util/slash.test.ts`
Expected: FAIL — `parseSlash("/effort")` returns `{ type: "unknown", ... }`.

**Step 3: Implement**

In `tui/src/util/slash.ts`:

(a) Add the import at the top:

```ts
import { isEffortLevel } from "./../../../shared/effort.ts";
import type { EffortLevel } from "../../../shared/events.ts";
```

> Note: match the existing relative-import style in this file (it uses `../../../shared/events.ts`). Use `../../../shared/effort.ts`.

(b) Add the action type after `ModelAction` (around line 21):

```ts
// /effort grammar mirrors /model:
//   (no args)                  — open the interactive slider for the active runner
//   show | status | list       — print current efforts for all runners
//   <level>                     — set the active runner's effort
//   <runner> <level>            — set a specific runner's effort
//   reset | clear               — clear the active runner's override
//   <runner> [reset|clear]      — clear a specific runner's override
export type EffortAction =
  | { kind: "picker" }
  | { kind: "show" }
  | { kind: "set"; effort: EffortLevel }
  | { kind: "setRunner"; runner: RunnerKind; effort: EffortLevel }
  | { kind: "reset" }
  | { kind: "resetRunner"; runner: RunnerKind };
```

(c) Add to the `SlashCommand` union (after the `model` member, line ~79):

```ts
  | { type: "effort"; action: EffortAction }
```

(d) Add the `case` in `parseSlash` (after `case "model":`, line ~127):

```ts
    case "effort":
      return { type: "effort", action: parseEffortAction(rest) };
```

(e) Add the parser (next to `parseModelAction`):

```ts
function parseEffortAction(rest: string): EffortAction {
  if (!rest) return { kind: "picker" };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const first = tokens[0].toLowerCase();
  if (first === "show" || first === "status" || first === "list") {
    return { kind: "show" };
  }
  if (first === "reset" || first === "clear") {
    return { kind: "reset" };
  }
  if (first === "claude" || first === "codex" || first === "vercel") {
    const tail = (tokens[1] ?? "").toLowerCase();
    if (!tail || tail === "reset" || tail === "clear") {
      return { kind: "resetRunner", runner: first };
    }
    if (isEffortLevel(tail)) {
      return { kind: "setRunner", runner: first, effort: tail };
    }
    return { kind: "show" };
  }
  if (isEffortLevel(first)) {
    return { kind: "set", effort: first };
  }
  // Unknown token -> show current state rather than silently setting garbage.
  return { kind: "show" };
}
```

(f) Add the help entry to `SLASH_COMMANDS` (after the `/model` entry):

```ts
  { name: "/effort [show | <level> | <runner> <level> | reset]", help: "open effort slider for active runner; levels depend on the active model" },
```

**Step 4: Run test to verify it passes**

Run: `bun test tui/src/util/slash.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add tui/src/util/slash.ts tui/src/util/slash.test.ts
git commit -m "feat(effort): /effort slash grammar + parser tests"
```

---

## Task 4: Client `setEffort` action

**Files:**
- Modify: `tui/src/state/sessions.ts`

**Step 1: Add `EffortLevel` to the type import (top of file, the existing shared import block)**

```ts
  EffortLevel,
```

**Step 2: Add the `setEffort` method (right after `setModel`, ~line 317)**

```ts
    setEffort(runner: RunnerKind, effort: EffortLevel | null): void {
      if (!activeId) return;
      send(client, { type: "set_effort", sessionId: activeId, runner, effort });
    },
```

**Step 3: Verify typecheck**

Run: `cd tui && bun run typecheck`
Expected: PASS (no usages yet; the method compiles against the new `set_effort` ClientMsg).

**Step 4: Commit**

```bash
git add tui/src/state/sessions.ts
git commit -m "feat(effort): client setEffort sends set_effort over ws"
```

---

## Task 5: `effortLines` notice helper

**Files:**
- Modify: `tui/src/util/notice.ts`

**Step 1: Add `effortLines` mirroring `modelLines` (place after `modelLines`, ~line 228)**

```ts
// Lines for the /effort show notice. Lists each runner's override (or
// "(default)") plus the active runner's resolved level set so the user can see
// what the slider would offer.
export function effortLines(session: Session | null, headline?: string): string[] {
  if (!session) return ["no active session"];
  const lines: string[] = [];
  if (headline) lines.push(headline, "");
  const order: RunnerKind[] = ["claude", "codex", "vercel"];
  for (const runner of order) {
    const marker = runner === session.activeRunner ? "›" : " ";
    const value = session.efforts?.[runner] ?? "(default)";
    lines.push(`${marker} ${runner.padEnd(7, " ")} ${value}`);
  }
  const info = session.effortInfo;
  if (info) {
    lines.push("");
    lines.push(
      info.levels.length > 0
        ? `active model levels: ${info.levels.join(" ")}`
        : "active model has no effort control",
    );
  }
  return lines;
}
```

**Step 2: Add `effortLines` to the import in `app.tsx`** (the `./util/notice` import block, ~line 22)

```ts
  effortLines,
```

**Step 3: Verify typecheck**

Run: `cd tui && bun run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add tui/src/util/notice.ts tui/src/app.tsx
git commit -m "feat(effort): effortLines notice helper"
```

---

## Task 6: `EffortSlider` component

**Files:**
- Create: `tui/src/components/EffortSlider.tsx`

No unit test (TUI components have no test harness here; verified manually in Task 10).

**Step 1: Create the component**

```tsx
import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { EffortLevel, RunnerKind } from "../../../shared/events.ts";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

type Props = {
  runner: RunnerKind;
  modelLabel: string;
  // Server-resolved supported levels for the active runner+model (ordered).
  levels: EffortLevel[];
  // Current override, or null when unset (SDK default in effect).
  current: EffortLevel | null;
  onSelect: (effort: EffortLevel) => void;
  onReset: () => void;
  onCancel: () => void;
};

export function EffortSlider({
  runner,
  modelLabel,
  levels,
  current,
  onSelect,
  onReset,
  onCancel,
}: Props) {
  const accent = runner === "claude" ? theme.toolBash : theme.toolWeb;

  // Initial cursor: the current override if it is in the set, else the median
  // stop. We deliberately do NOT assume an SDK default level (not API-knowable).
  const initialIndex = (() => {
    if (current) {
      const i = levels.indexOf(current);
      if (i >= 0) return i;
    }
    return levels.length > 0 ? Math.floor((levels.length - 1) / 2) : 0;
  })();
  const [index, setIndex] = useState(initialIndex);

  useKeyboard((key) => {
    const name = key.name;
    if (name === "escape") return onCancel();
    if (levels.length === 0) return; // disabled state: only esc works
    if (name === "left" || name === "h") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (name === "right" || name === "l") {
      setIndex((i) => Math.min(levels.length - 1, i + 1));
      return;
    }
    if (name === "r") return onReset();
    if (ENTER_KEYS.has(name)) {
      const lvl = levels[index];
      if (lvl) onSelect(lvl);
      return;
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={accent} attributes={TextAttributes.BOLD}>{"effort"}</text>
        <text fg={theme.textMuted}>{`  ${runner} · ${modelLabel}`}</text>
      </box>

      {levels.length === 0 ? (
        <>
          <text fg={theme.textMuted}>{`effort not supported for ${modelLabel}`}</text>
          <text fg={theme.textFaint}>{"esc close"}</text>
        </>
      ) : (
        <>
          <box flexDirection="row" justifyContent="space-between" marginTop={0}>
            <text fg={theme.textFaint}>{"Speed"}</text>
            <text fg={theme.textFaint}>{"Intelligence"}</text>
          </box>
          <box flexDirection="row">
            {levels.map((lvl, i) => {
              const selected = i === index;
              const isCurrent = lvl === current;
              const fg = selected ? accent : isCurrent ? theme.toolEdit : theme.textMuted;
              return (
                <text
                  key={lvl}
                  fg={fg}
                  attributes={selected ? TextAttributes.BOLD : 0}
                >
                  {`${lvl}${i < levels.length - 1 ? "   " : ""}`}
                </text>
              );
            })}
          </box>
          <text fg={theme.textFaint}>
            {"←/→ adjust   enter select   r reset to default   esc cancel"}
          </text>
        </>
      )}
    </box>
  );
}
```

> If `theme.bgPanel` / `theme.toolBash` / `theme.toolWeb` / `theme.toolEdit` are
> not all present, mirror exactly what `ModelPicker.tsx` imports from `../theme`
> — it uses the same set. Do not invent new theme keys.

**Step 2: Verify typecheck**

Run: `cd tui && bun run typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add tui/src/components/EffortSlider.tsx
git commit -m "feat(effort): EffortSlider component"
```

---

## Task 7: Wire `/effort` into `app.tsx`

**Files:**
- Modify: `tui/src/app.tsx`

**Step 1: Import the component (after the `ModelPicker` import, ~line 9)**

```ts
import { EffortSlider } from "./components/EffortSlider";
```

**Step 2: Add slider overlay state (after the `modelPicker` useState, ~line 81)**

```ts
  const [effortSlider, setEffortSlider] = useState<{ runner: RunnerKind } | null>(null);
```

**Step 3: Add the `effort` case to the `handleSubmit` switch (after the entire `case "model": { ... }` block, before `case "plan":`)**

```ts
        case "effort": {
          if (!sid || !api.active) return;
          const action = slash.action;
          switch (action.kind) {
            case "picker":
              setEffortSlider({ runner: api.active.activeRunner });
              return;
            case "show":
              addNotice(sid, "/effort", effortLines(api.active));
              return;
            case "set": {
              const runner = api.active.activeRunner;
              api.setEffort(runner, action.effort);
              addNotice(
                sid,
                "/effort",
                effortLines(
                  { ...api.active, efforts: { ...api.active.efforts, [runner]: action.effort } },
                  `${runner} → ${action.effort}`,
                ),
              );
              return;
            }
            case "setRunner": {
              api.setEffort(action.runner, action.effort);
              addNotice(
                sid,
                "/effort",
                effortLines(
                  { ...api.active, efforts: { ...api.active.efforts, [action.runner]: action.effort } },
                  `${action.runner} → ${action.effort}`,
                ),
              );
              return;
            }
            case "reset": {
              const runner = api.active.activeRunner;
              api.setEffort(runner, null);
              const next = { ...api.active.efforts };
              delete next[runner];
              addNotice(sid, "/effort", effortLines({ ...api.active, efforts: next }, `${runner} → (default)`));
              return;
            }
            case "resetRunner": {
              api.setEffort(action.runner, null);
              const next = { ...api.active.efforts };
              delete next[action.runner];
              addNotice(sid, "/effort", effortLines({ ...api.active, efforts: next }, `${action.runner} → (default)`));
              return;
            }
          }
          return;
        }
```

**Step 4: Mount the slider overlay (after the `{modelPicker && ...}` JSX block, ~line 1230)**

```tsx
      {effortSlider && api.active && (
        <EffortSlider
          runner={effortSlider.runner}
          modelLabel={promptMeta?.modelLabel ?? effortSlider.runner}
          levels={api.active.effortInfo?.levels ?? []}
          current={api.active.efforts?.[effortSlider.runner] ?? null}
          onSelect={(effort) => {
            if (!api.active) return;
            api.setEffort(effortSlider.runner, effort);
            if (api.activeId) {
              addNotice(
                api.activeId,
                "/effort",
                effortLines(
                  { ...api.active, efforts: { ...api.active.efforts, [effortSlider.runner]: effort } },
                  `${effortSlider.runner} → ${effort}`,
                ),
              );
            }
            setEffortSlider(null);
          }}
          onReset={() => {
            if (!api.active) return;
            api.setEffort(effortSlider.runner, null);
            if (api.activeId) {
              const next = { ...api.active.efforts };
              delete next[effortSlider.runner];
              addNotice(
                api.activeId,
                "/effort",
                effortLines({ ...api.active, efforts: next }, `${effortSlider.runner} → (default)`),
              );
            }
            setEffortSlider(null);
          }}
          onCancel={() => setEffortSlider(null)}
        />
      )}
```

**Step 5: Add `effortSlider` to the Prompt `locked` predicate (~line 1253)**

```ts
        locked={
          api.pendingPermissions.length > 0 ||
          modelPicker !== null ||
          effortSlider !== null ||
          paletteMode !== null ||
          (api.activeId !== null && !!api.consensusReady[api.activeId])
        }
```

**Step 6: Verify typecheck**

Run: `cd tui && bun run typecheck`
Expected: PASS.

**Step 7: Commit**

```bash
git add tui/src/app.tsx
git commit -m "feat(effort): wire /effort command and slider overlay into app"
```

---

## Task 8: Server capability resolution + session storage

**Files:**
- Create: `server/src/effort-capability.ts`
- Modify: `server/src/sessions.ts`

**Step 0: Precondition — ensure `@anthropic-ai/sdk` is a direct server dep**

Run: `npm --workspace server ls @anthropic-ai/sdk`
If it only resolves transitively (via `@anthropic-ai/claude-agent-sdk`), add it
as a direct dependency so the import can't break under a future lockfile change:
`npm --workspace server install @anthropic-ai/sdk`. Commit the
`package.json`/lockfile change with Task 8's commit.

**Step 1: Create the capability resolver**

`server/src/effort-capability.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { EffortInfo, RunnerKind } from "../../shared/events.js";
import {
  effortLevelsFromAnthropicCapability,
  openAiEffortLevels,
} from "../../shared/effort.js";

// One authored model-id fallback per runner: the id we query when the user has
// NOT pinned a model. This is a model id, not an effort level — levels are
// still discovered (Anthropic) or catalog-derived (OpenAI). Keep in sync with
// the runner defaults in index.ts / the runners.
const DEFAULT_MODEL_ID: Record<RunnerKind, string> = {
  claude: "claude-opus-4-7",
  codex: "gpt-5-codex",
  vercel: "gpt-4o",
};

function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "").trim();
}

function providerFor(runner: RunnerKind, modelId: string): "anthropic" | "openai" {
  if (runner === "claude") return "anthropic";
  if (runner === "codex") return "openai";
  return modelId.startsWith("claude-") ? "anthropic" : "openai"; // vercel
}

// Cache Anthropic level lookups by base model id — there are only a handful of
// Claude models, and capabilities don't change within a process lifetime.
const anthropicCache = new Map<string, EffortInfo["levels"]>();
let client: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function resolveEffortInfo(
  runner: RunnerKind,
  modelOverride: string | undefined,
): Promise<EffortInfo> {
  const modelId = (modelOverride && modelOverride.trim()) || DEFAULT_MODEL_ID[runner];
  const provider = providerFor(runner, modelId);

  if (provider === "openai") {
    return { levels: openAiEffortLevels(modelId), source: "catalog" };
  }

  // Anthropic: discover live via the Models API, cached per base id.
  const base = stripContextSuffix(modelId);
  const cached = anthropicCache.get(base);
  if (cached) return { levels: [...cached], source: "api" };
  try {
    const info = await anthropicClient().models.retrieve(base);
    const levels = effortLevelsFromAnthropicCapability(info.capabilities?.effort ?? null);
    anthropicCache.set(base, levels);
    return { levels: [...levels], source: "api" };
  } catch (err) {
    // Network/unknown-model/no-key: don't crash a session. Empty levels means
    // the slider shows the disabled state; the runner omits the effort param.
    console.error("[effort] anthropic capability lookup failed:", err);
    return { levels: [], source: "api" };
  }
}
```

> If `new Anthropic()` requires an explicit key in this codebase, mirror how the
> Claude runner constructs/relies on the SDK (it uses `@anthropic-ai/claude-agent-sdk`,
> which reads `ANTHROPIC_API_KEY` from env). `@anthropic-ai/sdk` also reads
> `ANTHROPIC_API_KEY` from env by default — no explicit key needed.

**Step 2: Add `efforts`/`effortInfo` to the session in `server/src/sessions.ts`**

(a) Import the new types (the existing shared import block, ~line 6):

```ts
  EffortInfo,
  EffortLevel,
  EffortOverrides,
```

(b) In `create()` (the `Stored` literal, after `models: {},`):

```ts
      efforts: {},
      effortInfo: null,
```

(c) In `load()` migration loop (after `if (!s.runtime) s.runtime = {};`, ~line 376) — backfill for sessions persisted before this field existed:

```ts
      if (!s.efforts) s.efforts = {};
```

(d) Add `setEffort` and `setEffortInfo` (after `setModel`, ~line 189):

```ts
  setEffort(id: string, runner: RunnerKind, effort: EffortLevel | null): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    const next: EffortOverrides = { ...s.efforts };
    if (effort) next[runner] = effort;
    else delete next[runner];
    s.efforts = next;
    s.updatedAt = new Date().toISOString();
    this.broadcast({ type: "session_updated", session: toWire(s) });
    this.markDirty();
    return s;
  }

  setEffortInfo(id: string, info: EffortInfo | null): Stored | null {
    const s = this.get(id);
    if (!s) return null;
    s.effortInfo = info;
    // Don't bump updatedAt — capability resolution is a side effect, not user
    // activity that should re-order the sidebar.
    this.broadcast({ type: "session_updated", session: toWire(s) });
    this.markDirty();
    return s;
  }
```

**Step 3: Verify server typecheck**

Run: `npm --workspace server run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add server/src/effort-capability.ts server/src/sessions.ts
git commit -m "feat(effort): server effort storage + capability resolver"
```

---

## Task 9: Server dispatch — resolve effortInfo + pass effort to runners

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/runners/claude.ts`
- Modify: `server/src/runners/codex.ts`
- Modify: `server/src/runners/vercel.ts`

**Step 1: Runner `effort` plumbing**

(a) `claude.ts` — add `effort?: EffortLevel;` to `ClaudeRunArgs` (after `model?: string;`, ~line 74), import the type, destructure `effort`, and inject after `if (model) options.model = model;` (~line 141):

```ts
  if (effort) options.effort = effort;
```

Import (with the existing `ClaudePermissionMode` import, ~line 67):

```ts
import type { ClaudePermissionMode, EffortLevel } from "../../../shared/events.js";
```

(b) `codex.ts` — add `effort?: EffortLevel;` to `CodexRunArgs` (after `model?: string;`), import `EffortLevel`, destructure it, and inject after `if (model) threadOptions.model = model;` (~line 121):

```ts
  if (effort) threadOptions.modelReasoningEffort = effort;
```

> `modelReasoningEffort` has no `max`. The clamp in index.ts (Step 2) already
> restricts to the resolved level set, so `max` never reaches here for Codex.

(c) `vercel.ts` — add `effort?: EffortLevel;` to `VercelRunArgs` (after `model?: string;`), import `EffortLevel`, destructure it. At the `streamText({ ... })` call (~line 309) add provider options ONLY for OpenAI models:

```ts
    // @ai-sdk/openai's reasoningEffort union has no "max" — narrow it out so
    // the literal typechecks. Runtime never sees "max" here anyway: the OpenAI
    // catalog tops out at "xhigh" and clampEffort filters to the resolved set.
    const vercelEffort = effort && effort !== "max" ? effort : undefined;
    const result = streamText({
      model: languageModel,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(stepLimit),
      abortSignal: signal,
      ...(vercelEffort && !modelId.startsWith("claude-")
        ? { providerOptions: { openai: { reasoningEffort: vercelEffort } } }
        : {}),
    });
```

> `modelId` is already in scope at this point (resolved earlier in the runner).
> Anthropic-routed models ignore `effort` here (their effort is N/A on Vercel;
> the resolver returns empty levels so the slider won't offer one anyway).
> The `effort !== "max"` narrowing is REQUIRED — without it TS rejects the
> assignment because `EffortLevel` includes `"max"` but the SDK union does not.
> Claude options (`Record<string, unknown>`) and Codex options (`any`) don't
> need this narrowing.

**Step 2: index.ts — resolve effortInfo on change + pass clamped effort to runners**

(a) Imports (with the runner imports, ~line 28):

```ts
import { resolveEffortInfo } from "./effort-capability.js";
import { clampEffort } from "../../shared/effort.js";
```

(b) Add a helper near the top of the module (after `updateSessionSkills`, ~line 169):

```ts
// Resolve the active runner+model effort capability and attach it to the
// session so the TUI slider can render it. Fire-and-forget: the Anthropic path
// is async but cached, and a failure just yields empty levels.
function refreshEffortInfo(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  const modelOverride = s.models[s.activeRunner];
  void resolveEffortInfo(s.activeRunner, modelOverride)
    .then((info) => {
      // Re-fetch — the session may have changed runner/model while awaiting.
      const cur = sessions.get(sessionId);
      if (cur && cur.activeRunner === s.activeRunner) {
        sessions.setEffortInfo(sessionId, info);
      }
    })
    .catch(() => {});
}
```

(c) Call it after the session is created and after runner/model changes:

- In `case "create_session":` after `const created = sessions.create({...});`:
  ```ts
  refreshEffortInfo(created.id);
  ```
- In `case "set_runner":` replace the body with:
  ```ts
    case "set_runner":
      sessions.setRunner(msg.sessionId, msg.runner);
      refreshEffortInfo(msg.sessionId);
      return;
  ```
- In `case "set_model":` replace the body with:
  ```ts
    case "set_model":
      sessions.setModel(msg.sessionId, msg.runner, msg.model);
      refreshEffortInfo(msg.sessionId);
      return;
  ```

(d) Add the `set_effort` handler (after the `set_model` case):

```ts
    case "set_effort":
      sessions.setEffort(msg.sessionId, msg.runner, msg.effort);
      return;
```

(d.1) Persisted sessions boot with `effortInfo: null`, so a `/effort` on a
restored session would show the disabled state until the user touches the
model. Resolve every persisted session once at startup. In `startServer`,
after the listener binds (right after `boundPort = actualPort;`), add:

```ts
  // Backfill effort capability for sessions restored from disk so the slider
  // works on first open without waiting for a model/runner change. Cached per
  // model id, so this is a handful of Models API calls at most.
  for (const s of sessions.list()) refreshEffortInfo(s.id);
```

> `refreshEffortInfo` is module-scoped (defined in step (b)), so it's in scope
> inside `startServer`.

(e) Pass the clamped effort into each runner in `runTurn`. Just before the
`if (session.activeRunner === "claude")` branch (~line 754), compute it once:

```ts
  // Active-runner effort, clamped to what the resolved model actually supports.
  // effortInfo is for the active runner+model (kept current by refreshEffortInfo).
  const effortLevels = session.effortInfo?.levels ?? [];
  const activeEffort = session.efforts[session.activeRunner] ?? null;
  const clampedEffort =
    activeEffort && effortLevels.length > 0
      ? clampEffort(effortLevels, activeEffort)
      : null;
```

Then add `effort: clampedEffort ?? undefined,` to each runner call:
- `runClaude({ ... model: session.models.claude, effort: clampedEffort ?? undefined, ... })`
- `runCodex({ ... model: session.models.codex, effort: clampedEffort ?? undefined, ... })`
- `runVercel({ ... model: session.models.vercel, effort: clampedEffort ?? undefined, ... })`

**Step 3: Verify typecheck (both workspaces)**

Run: `npm --workspace server run typecheck && (cd tui && bun run typecheck)`
Expected: PASS.

**Step 4: Run the full test suite**

Run: `bun test shared/effort.test.ts tui/src/util/slash.test.ts && npm --workspace server test`
Expected: PASS (new tests green; existing server tests unaffected).

**Step 5: Commit**

```bash
git add server/src/index.ts server/src/runners/claude.ts server/src/runners/codex.ts server/src/runners/vercel.ts
git commit -m "feat(effort): resolve effortInfo on change and inject clamped effort per runner"
```

---

## Task 10: Manual verification

**Files:** none (verification only).

The user runs the TUI themselves (do NOT auto-start servers). Provide this checklist:

1. `/effort` on a Claude+Opus-4.7 session → slider shows `low medium high xhigh max`; `←/→` + Enter sets it; `/effort show` reflects the choice.
2. `/model claude-sonnet-4-6` then `/effort` → slider shows `low medium high max` (no `xhigh`) — confirms live API discovery, not a static table.
3. `/model claude-haiku-4-5-20251001` then `/effort` → disabled line "effort not supported".
4. `/codex` + `/model gpt-5-codex` → `/effort` shows `minimal low medium high xhigh`; `gpt-5-mini` drops `xhigh`.
5. `/vercel` + `gpt-4o` → disabled; `gpt-5` → `minimal low medium high`; a `claude-*` vercel model → disabled.
6. Set effort, send a real turn, confirm no errors (the SDK accepts the injected level). Switch model so the stored level is unsupported (xhigh→Sonnet) and confirm the turn still runs (server clamp).
7. `/clear` preserves the effort override.

Report results; fix any failures before declaring done.

---

## Notes for the executor

- DRY: all level data flows through `shared/effort.ts` + `effort-capability.ts`. Do not add per-model conditionals anywhere else.
- YAGNI: no persistence beyond what mirrors `/model`; no Header pill for effort in v1; no component test for the slider.
- The only authored constants are the OpenAI level catalog (unavoidable — no API) and one fallback model id per runner (used solely to know what to ask the Models API when no override is set). Effort *levels* for Claude are never hardcoded.
- Per repo convention ([Skip code review] in subagent-driven-development): no per-task code-quality reviewer; the spec review here is sufficient.
- ASCII only in all source and tests.
