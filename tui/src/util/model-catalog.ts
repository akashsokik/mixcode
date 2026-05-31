import type { RunnerKind } from "../../../shared/events.ts";

export type ModelEntry = {
  id: string;
  label: string;
  // Optional one-liner shown alongside the label in the picker.
  hint?: string;
};

// Curated common picks. Users can always /model <any-id> for off-list models
// — the picker just exists so they don't have to memorise IDs.
const CLAUDE_MODELS: ModelEntry[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "200K context" },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 (1M context)",
    hint: "long-context variant",
  },
  { id: "claude-opus-4-7", label: "Opus 4.7", hint: "200K context" },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 (1M context)",
    hint: "long-context variant",
  },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "balanced" },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    hint: "fast / cheap",
  },
];

const CODEX_MODELS: ModelEntry[] = [
  { id: "gpt-5-codex", label: "GPT-5 Codex", hint: "code-tuned" },
  { id: "gpt-5", label: "GPT-5", hint: "general" },
  { id: "gpt-5-mini", label: "GPT-5 Mini", hint: "fast / cheap" },
];

// Vercel AI SDK runner routes by model-id prefix:
//   - claude-* -> @ai-sdk/anthropic (needs ANTHROPIC_API_KEY)
//   - gpt-* / o*-* -> @ai-sdk/openai (needs OPENAI_API_KEY)
// Any id either provider's SDK accepts is usable via /model <id> — the picker
// just exposes a curated short list. The `[1m]` Claude variants are kept for
// parity with the Claude runner picker; the vercel runner silently strips the
// suffix since the Anthropic API has no equivalent context-window selector.
const VERCEL_MODELS: ModelEntry[] = [
  // Anthropic — Claude family
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "anthropic · 200K" },
  { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", hint: "anthropic · stripped to base on vercel" },
  { id: "claude-opus-4-7", label: "Opus 4.7", hint: "anthropic · 200K" },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M)", hint: "anthropic · stripped to base on vercel" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "anthropic · balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "anthropic · fast" },

  // OpenAI — GPT-5 family
  { id: "gpt-5", label: "GPT-5", hint: "openai · general" },
  { id: "gpt-5-mini", label: "GPT-5 Mini", hint: "openai · fast / cheap" },
  { id: "gpt-5-codex", label: "GPT-5 Codex", hint: "openai · code-tuned" },

  // OpenAI — GPT-4o family (default fallback)
  { id: "gpt-4o", label: "GPT-4o", hint: "openai · default · 128K" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", hint: "openai · fast / cheap" },
];

// The ollama runner's model list is NOT hardcoded — it's fetched live from the
// local daemon (see util/ollama-models.ts) since "what's installed" only the
// daemon knows. modelsFor returns [] for ollama so a stray call can't fall
// through to the vercel catalog.
export function modelsFor(runner: RunnerKind): ModelEntry[] {
  if (runner === "claude") return CLAUDE_MODELS;
  if (runner === "codex") return CODEX_MODELS;
  if (runner === "ollama") return [];
  return VERCEL_MODELS;
}
