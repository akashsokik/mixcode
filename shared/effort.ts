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
