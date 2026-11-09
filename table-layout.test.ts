import { describe, expect, it } from "vitest";
import {
  clampWidth,
  parseTablePreferences,
  sortItems,
  type SortColumn,
} from "./table-layout";
import type { Item } from "./app-logic";
import { parseSavedSearches } from "./saved-searches";

const first: Item = {
  repo: "acme/zebra",
  number: 2,
  kind: "pr",
  title: "Alpha",
  state: "CLOSED",
  author: "alice",
  assignees: ["alice"],
  labels: [],
  body: "",
  url: "https://github.com/acme/zebra/pull/2",
  updatedAt: "2026-01-01T00:00:00Z",
};
const second: Item = {
  ...first,
  repo: "acme/apple",
  number: 10,
  title: "Beta",
  state: "OPEN",
  assignees: ["bob"],
  updatedAt: "2026-02-01T00:00:00Z",
};

describe("table preferences", () => {
  it.each<SortColumn>(["id", "title", "repo", "assignee", "status", "updated"])(
    "sorts %s in both directions without modifying cached data",
    (column) => {
      const items = [second, first];
      const ascending = column === "repo" ? [second, first] : [first, second];
      expect(sortItems(items, { column, direction: "asc" })).toEqual(ascending);
      expect(sortItems(items, { column, direction: "desc" })).toEqual(
        [...ascending].reverse(),
      );
      expect(items).toEqual([second, first]);
      expect(sortItems(items, undefined)).toBe(items);
    },
  );
  it("keeps equal sort keys stable", () => {
    const tied = { ...second, title: first.title };
    expect(
      sortItems([tied, first], { column: "title", direction: "asc" }),
    ).toEqual([tied, first]);
  });
  it("bounds resizing while keeping action controls wide enough", () => {
    expect(clampWidth("repo", -100, "pr")).toBe(64);
    expect(clampWidth("title", 5000, "pr")).toBe(1200);
    expect(clampWidth("actions", 20, "pr")).toBe(192);
    expect(clampWidth("actions", 20, "issue")).toBe(96);
  });
  it("restores valid settings and ignores invalid optional preferences without losing a search", () => {
    const search = {
      id: "one",
      name: "A search",
      kind: "pr",
      query: "is:open",
      collapsed: false,
    };
    const table = {
      sort: { column: "updated", direction: "desc" },
      widths: { title: 320, repo: 160 },
    };
    expect(parseSavedSearches(JSON.stringify([{ ...search, table }]))).toEqual([
      { ...search, table },
    ]);
    expect(parseSavedSearches(JSON.stringify([search]))).toEqual([search]);
    expect(
      parseTablePreferences({
        sort: { column: "actions", direction: "asc" },
        widths: { title: "300", repo: -5, status: 9000, updated: 72 },
      }),
    ).toEqual({ widths: { updated: 72 } });
    expect(
      parseSavedSearches(JSON.stringify([{ ...search, table: "bad" }])),
    ).toEqual([search]);
  });
});
