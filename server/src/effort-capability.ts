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
