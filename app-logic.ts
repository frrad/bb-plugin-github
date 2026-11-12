import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { githubRpcContract } from "./server.js";

export type Item = PluginRpcResult<
  (typeof githubRpcContract)["listItems"]
>["items"][number];

export function itemDisplayState(
  item: Pick<Item, "kind" | "state" | "isDraft">,
): string {
  return item.kind === "pr" && item.state === "OPEN" && item.isDraft
    ? "DRAFT"
    : item.state;
}

export type Route =
  | { view: "issues" }
  | { view: "pulls" }
  | { view: "new" }
  | { view: "issue"; repo: string; number: number }
  | { view: "pull"; repo: string; number: number };

export function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "pulls" && parts.length === 4) {
    const number = Number(parts[3]);
    if (Number.isFinite(number)) {
      return { view: "pull", repo: `${parts[1]}/${parts[2]}`, number };
    }
  }
  if (parts[0] === "pulls") return { view: "pulls" };
  if (parts[0] === "new") return { view: "new" };
  if (parts[0] === "issues" && parts.length === 4) {
    const number = Number(parts[3]);
    if (Number.isFinite(number)) {
      return { view: "issue", repo: `${parts[1]}/${parts[2]}`, number };
    }
  }
  return { view: "issues" };
}

export function routeToSubPath(route: Route): string {
  switch (route.view) {
    case "issues":
      return "issues";
    case "pulls":
      return "pulls";
    case "new":
      return "new";
    case "issue":
      return `issues/${route.repo}/${route.number}`;
    case "pull":
      return `pulls/${route.repo}/${route.number}`;
  }
}

interface QueryFilters {
  states: string[];
  assignees: string[];
  authors: string[];
  reviewedBy: string[];
  commenters: string[];
  labels: string[];
  repos: string[];
  noAssignee: boolean;
  noLabel: boolean;
  text: string[];
}

interface ParsedQuery extends QueryFilters {
  excluded: QueryFilters[];
}

function tokenizeQuery(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

function unquote(value: string): string {
  return value.replace(/"/g, "");
}

const STATE_VALUES: Record<string, string> = {
  open: "OPEN",
  closed: "CLOSED",
  merged: "MERGED",
};

function emptyFilters(): QueryFilters {
  return {
    states: [],
    assignees: [],
    authors: [],
    reviewedBy: [],
    commenters: [],
    labels: [],
    repos: [],
    noAssignee: false,
    noLabel: false,
    text: [],
  };
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { ...emptyFilters(), excluded: [] };
  for (const rawToken of tokenizeQuery(query)) {
    const negative = rawToken.startsWith("-");
    const token = negative ? rawToken.slice(1) : rawToken;
    if (!token) continue;
    const target = negative ? emptyFilters() : parsed;
    const idx = token.indexOf(":");
    const key = idx > 0 ? token.slice(0, idx).toLowerCase() : "";
    const value = idx > 0 ? unquote(token.slice(idx + 1)) : "";
    if (idx > 0 && value.length === 0) continue;
    if (key === "is" || key === "state") {
      target.states.push(
        STATE_VALUES[value.toLowerCase()] ?? value.toUpperCase(),
      );
    } else if (key === "assignee") {
      target.assignees.push(value.toLowerCase());
    } else if (key === "author") {
      target.authors.push(value.toLowerCase());
    } else if (key === "commenter") {
      target.commenters.push(value.toLowerCase());
    } else if (key === "reviewed-by") {
      target.reviewedBy.push(value.toLowerCase());
    } else if (key === "label") {
      target.labels.push(value.toLowerCase());
    } else if (key === "repo") {
      target.repos.push(value.toLowerCase());
    } else if (key === "no") {
      if (value.toLowerCase() === "assignee") target.noAssignee = true;
      if (value.toLowerCase() === "label") target.noLabel = true;
    } else {
      target.text.push(unquote(token).toLowerCase());
    }
    // Ignore unfinished or unrecognized no: filters while the user is typing.
    if (
      negative &&
      Object.values(target).some((value) =>
        Array.isArray(value) ? value.length > 0 : value,
      )
    ) {
      parsed.excluded.push(target);
    }
  }
  return parsed;
}

export function matchesQuery(
  item: Item,
  query: ParsedQuery,
  viewer: string | null,
): boolean {
  return (
    matchesFilters(item, query, viewer) &&
    !query.excluded.some((filter) => matchesFilters(item, filter, viewer))
  );
}

function matchesFilters(
  item: Item,
  query: QueryFilters,
  viewer: string | null,
): boolean {
  if (query.states.length > 0 && !query.states.includes(item.state)) {
    return false;
  }
  if (query.assignees.length > 0) {
    const wanted = query.assignees.map((login) =>
      login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
    );
    if (!item.assignees.some((login) => wanted.includes(login.toLowerCase()))) {
      return false;
    }
  }
  if (query.authors.length > 0) {
    const author = item.author.toLowerCase();
    const wanted = query.authors.map((login) =>
      login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
    );
    if (!wanted.includes(author)) return false;
  }
  if (query.reviewedBy.length > 0) {
    const wanted = query.reviewedBy.map((login) =>
      login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
    );
    if (
      item.kind !== "pr" ||
      !(item.reviewedBy ?? []).some((login) =>
        wanted.includes(login.toLowerCase()),
      )
    ) {
      return false;
    }
  }
  if (query.commenters.length > 0) {
    const wanted = query.commenters.map((login) =>
      login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
    );
    if (
      !(item.commenters ?? []).some((login) =>
        wanted.includes(login.toLowerCase()),
      )
    )
      return false;
  }
  if (query.labels.length > 0) {
    const labels = item.labels.map((label) => label.toLowerCase());
    if (!query.labels.some((label) => labels.includes(label))) return false;
  }
  if (
    query.repos.length > 0 &&
    !query.repos.includes(item.repo.toLowerCase())
  ) {
    return false;
  }
  if (query.noAssignee && item.assignees.length > 0) return false;
  if (query.noLabel && item.labels.length > 0) return false;
  if (query.text.length > 0) {
    const haystack = `${item.title} #${item.number} ${item.repo}`.toLowerCase();
    if (!query.text.every((term) => haystack.includes(term))) return false;
  }
  return true;
}

export type SuggestionIcon =
  | { kind: "state"; itemKind: "issue" | "pr"; state: string }
  | { kind: "avatar"; login: string };

export interface Suggestion {
  insert: string;
  label: string;
  hint?: string;
  icon?: SuggestionIcon;
}

const QUALIFIER_KEYS: Array<{ key: string; hint: string }> = [
  { key: "is:", hint: "state — open, closed, merged" },
  { key: "assignee:", hint: "assigned user, or @me" },
  { key: "author:", hint: "opened by" },
  { key: "commenter:", hint: "commented by user, or @me" },
  { key: "reviewed-by:", hint: "reviewed by user, or @me" },
  { key: "label:", hint: "has label" },
  { key: "repo:", hint: "in repository" },
  { key: "no:", hint: "missing — assignee, label" },
];

function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function buildSuggestions(
  token: string,
  vocab: { users: string[]; labels: string[]; repos: string[] },
  kind: "issue" | "pr",
  viewer: string | null,
): Suggestion[] {
  if (token.startsWith("-")) {
    return buildSuggestions(token.slice(1), vocab, kind, viewer).map(
      (suggestion) => ({
        ...suggestion,
        insert: `-${suggestion.insert}`,
        label: `-${suggestion.label}`,
      }),
    );
  }
  const idx = token.indexOf(":");
  if (idx <= 0) {
    const prefix = token.toLowerCase();
    return QUALIFIER_KEYS.filter(
      (entry) =>
        (kind === "pr" || entry.key !== "reviewed-by:") &&
        entry.key.startsWith(prefix),
    ).map((entry) => ({
      insert: entry.key,
      label: entry.key,
      hint: entry.hint,
    }));
  }
  const key = token.slice(0, idx).toLowerCase();
  const partial = unquote(token.slice(idx + 1)).toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(partial);
  if (key === "is" || key === "state") {
    const states =
      kind === "pr" ? ["open", "closed", "merged"] : ["open", "closed"];
    return states.filter(matches).map((state) => ({
      insert: `${key}:${state} `,
      label: state,
      icon: {
        kind: "state",
        itemKind: kind,
        state: STATE_VALUES[state] ?? "OPEN",
      },
    }));
  }
  if (
    key === "assignee" ||
    key === "author" ||
    key === "commenter" ||
    (key === "reviewed-by" && kind === "pr")
  ) {
    const users = ["@me", ...vocab.users];
    return users.filter(matches).map((login) => {
      const avatarLogin = login === "@me" ? viewer : login;
      const icon: SuggestionIcon | undefined =
        avatarLogin === null
          ? undefined
          : { kind: "avatar", login: avatarLogin };
      return {
        insert: `${key}:${login} `,
        label: login === "@me" && viewer !== null ? `@me (${viewer})` : login,
        ...(icon === undefined ? {} : { icon }),
      };
    });
  }
  if (key === "label") {
    return vocab.labels.filter(matches).map((label) => ({
      insert: `${key}:${quoteValue(label)} `,
      label,
    }));
  }
  if (key === "repo") {
    return vocab.repos.filter(matches).map((repo) => ({
      insert: `${key}:${repo} `,
      label: repo,
    }));
  }
  if (key === "no") {
    return ["assignee", "label"].filter(matches).map((field) => ({
      insert: `${key}:${field} `,
      label: `no:${field}`,
    }));
  }
  return [];
}
