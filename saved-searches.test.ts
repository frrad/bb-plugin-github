import { describe, expect, it } from "vitest";
import {
  moveSearch,
  parseSavedSearches,
  type SavedSearch,
} from "./saved-searches";

const search: SavedSearch = {
  id: "one",
  name: "My open PRs",
  kind: "pr",
  query: "is:open author:@me",
  collapsed: false,
};

describe("saved search storage", () => {
  it("accepts saved searches and an intentionally empty dashboard", () => {
    expect(parseSavedSearches(JSON.stringify([search]))).toEqual([search]);
    expect(parseSavedSearches("[]")).toEqual([]);
  });

  it.each([
    null,
    "not json",
    "null",
    "{}",
    "[null]",
    JSON.stringify([{ ...search, kind: "unknown" }]),
    JSON.stringify([{ ...search, collapsed: "false" }]),
    JSON.stringify([{ ...search, id: "" }]),
    JSON.stringify([{ ...search, query: null }]),
    JSON.stringify([search, search]),
  ])("rejects malformed or duplicate saved entries: %s", (raw) => {
    expect(parseSavedSearches(raw)).toBeNull();
  });

  it("moves searches without changing their settings or moving past the ends", () => {
    const second: SavedSearch = { ...search, id: "two", collapsed: true };
    const searches = [search, second];
    expect(moveSearch(searches, "two", -1)).toEqual([second, search]);
    expect(moveSearch(searches, "one", 1)).toEqual([second, search]);
    expect(moveSearch(searches, "one", -1)).toBe(searches);
    expect(moveSearch(searches, "two", 1)).toBe(searches);
    expect(moveSearch(searches, "missing", 1)).toBe(searches);
    expect(searches).toEqual([search, second]);
  });
});
