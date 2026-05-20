import fuzzysort from "fuzzysort";

export function fuzzyFilter(items: string[], query: string, limit = 8): string[] {
  if (!query) return items.slice(0, limit);
  const results = fuzzysort.go(query, items, { limit });
  return results.map((r) => r.target);
}
