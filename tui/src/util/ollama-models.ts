import type { ModelEntry } from "./model-catalog";

// The TUI embeds (or connects to) the backend and records its base URL in
// ADVERSERIAL_SERVER_URL; fall back to the same default the WS client uses.
function serverBase(): string {
  return process.env.ADVERSERIAL_SERVER_URL ?? "http://127.0.0.1:4567";
}

// Fetch the live list of pulled Ollama models from the server, which owns the
// daemon connection. Returns picker entries (id === label, since /api/tags
// carries no display name) plus an error string when the daemon is unreachable
// or empty — never throws, so the picker can render a clean message.
export async function fetchOllamaModels(): Promise<{
  entries: ModelEntry[];
  error: string | null;
}> {
  try {
    const res = await fetch(`${serverBase()}/ollama/models`);
    if (!res.ok) {
      return { entries: [], error: `server returned ${res.status}` };
    }
    const data = (await res.json()) as { models?: string[]; error?: string };
    if (data.error) {
      return { entries: [], error: data.error };
    }
    const entries = (data.models ?? []).map((name) => ({ id: name, label: name }));
    return { entries, error: null };
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
}
