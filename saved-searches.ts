import {
  parseTablePreferences,
  type TablePreferences,
} from "./table-layout.js";

export interface SavedSearch {
  id: string;
  name: string;
  kind: "issue" | "pr";
  query: string;
  collapsed: boolean;
  table?: TablePreferences;
}

export const SEARCHES_KEY = "bb-plugin-github-fred:searches";

// Return null for invalid storage so the caller can migrate the old single search.
export function parseSavedSearches(raw: string | null): SavedSearch[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const ids = new Set<string>();
    const searches: SavedSearch[] = [];
    for (const entry of value) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        ids.has(entry.id) ||
        typeof entry.name !== "string" ||
        (entry.kind !== "issue" && entry.kind !== "pr") ||
        typeof entry.query !== "string" ||
        typeof entry.collapsed !== "boolean"
      )
        return null;
      ids.add(entry.id);
      const table = parseTablePreferences(entry.table);
      searches.push({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        query: entry.query,
        collapsed: entry.collapsed,
        ...(table !== undefined ? { table } : {}),
      });
    }
    return searches;
  } catch {
    return null;
  }
}

export function moveSearch(
  searches: SavedSearch[],
  id: string,
  offset: -1 | 1,
): SavedSearch[] {
  const index = searches.findIndex((search) => search.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= searches.length) return searches;
  const next = [...searches];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
