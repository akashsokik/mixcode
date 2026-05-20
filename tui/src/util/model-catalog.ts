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

export function modelsFor(runner: RunnerKind): ModelEntry[] {
  return runner === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
}
