import { itemDisplayState, type Item } from "./app-logic.js";

export const TABLE_COLUMNS = [
  "id",
  "title",
  "repo",
  "assignee",
  "status",
  "updated",
  "actions",
] as const;
export type TableColumn = (typeof TABLE_COLUMNS)[number];
export type SortColumn = Exclude<TableColumn, "actions">;
export interface TablePreferences {
  sort?: { column: SortColumn; direction: "asc" | "desc" };
  widths?: Partial<Record<TableColumn, number>>;
}
export const COLUMN_LABELS: Record<TableColumn, string> = {
  id: "ID",
  title: "Title",
  repo: "Repo",
  assignee: "Assignee",
  status: "Status",
  updated: "Updated",
  actions: "Actions",
};
export function defaultWidths(
  kind: "issue" | "pr",
): Record<TableColumn, number> {
  return {
    id: 48,
    title: 240,
    repo: 128,
    assignee: 80,
    status: 96,
    updated: 72,
    actions: kind === "pr" ? 112 : 96,
  };
}
export function clampWidth(
  column: TableColumn,
  width: number,
  kind: "issue" | "pr",
) {
  const minimum =
    column === "actions"
      ? defaultWidths(kind).actions
      : column === "title"
        ? 120
        : column === "id"
          ? 44
          : 64;
  return Math.round(Math.min(1200, Math.max(minimum, width)));
}
export function parseTablePreferences(
  value: unknown,
): TablePreferences | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const result: TablePreferences = {};
  if (raw.sort !== null && typeof raw.sort === "object") {
    const sort = raw.sort as Record<string, unknown>;
    if (
      TABLE_COLUMNS.some(
        (column) => column !== "actions" && column === sort.column,
      ) &&
      (sort.direction === "asc" || sort.direction === "desc")
    ) {
      result.sort = {
        column: sort.column as SortColumn,
        direction: sort.direction,
      };
    }
  }
  if (raw.widths !== null && typeof raw.widths === "object") {
    const widths = raw.widths as Record<string, unknown>;
    for (const column of TABLE_COLUMNS) {
      const width = widths[column];
      if (
        typeof width === "number" &&
        Number.isFinite(width) &&
        width >= 44 &&
        width <= 1200
      ) {
        result.widths ??= {};
        result.widths[column] = width;
      }
    }
  }
  return result;
}
export function sortItems(
  items: Item[],
  sort: TablePreferences["sort"],
): Item[] {
  if (!sort) return items;
  const value = (item: Item): string | number => {
    switch (sort.column) {
      case "id":
        return item.number;
      case "updated":
        return Date.parse(item.updatedAt) || 0;
      case "repo":
        return item.repo.split("/").pop() ?? item.repo;
      case "assignee":
        return item.assignees.join(", ");
      case "status":
        return itemDisplayState(item);
      case "title":
        return item.title;
    }
  };
  return [...items].sort((left, right) => {
    const a = value(left),
      b = value(right);
    const comparison =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, {
            numeric: true,
            sensitivity: "base",
          });
    return sort.direction === "asc" ? comparison : -comparison;
  });
}
