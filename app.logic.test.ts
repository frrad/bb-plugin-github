import { describe, expect, it } from "vitest";
import {
  buildSuggestions,
  matchesQuery,
  parseQuery,
  parseSubPath,
  routeToSubPath,
  type Item,
  type Route,
} from "./app-logic.js";

const issue: Item = {
  repo: "acme/widgets",
  number: 7,
  kind: "issue",
  title: "Fix cache invalidation",
  state: "OPEN",
  author: "alice",
  labels: ["bug", "good first issue"],
  assignees: ["octocat"],
  url: "https://github.com/acme/widgets/issues/7",
  body: "",
  updatedAt: "2026-08-19T12:00:00Z",
};

describe("github panel routes", () => {
  it("round-trips list, create, issue, and pull routes", () => {
    const routes: Route[] = [
      { view: "issues" },
      { view: "pulls" },
      { view: "new" },
      { view: "issue", repo: "acme/widgets", number: 7 },
      { view: "pull", repo: "get-bb/bb", number: 42 },
    ];

    for (const route of routes) {
      expect(parseSubPath(routeToSubPath(route))).toEqual(route);
    }
  });

  it("falls back to the owning list for malformed detail paths", () => {
    expect(parseSubPath("pulls/acme/widgets/not-a-number")).toEqual({
      view: "pulls",
    });
    expect(parseSubPath("issues/acme/widgets/not-a-number")).toEqual({
      view: "issues",
    });
    expect(parseSubPath("issues/acme/widgets/7/extra")).toEqual({
      view: "issues",
    });
    expect(parseSubPath("")).toEqual({ view: "issues" });
  });
});

describe("github panel query engine", () => {
  it("combines reviewer and state filters with an excluded viewer author", () => {
    const query = parseQuery("reviewed-by:@me is:open -author:@me");
    const pr: Item = { ...issue, kind: "pr", reviewedBy: ["Octocat"] };
    expect(matchesQuery(pr, query, "octocat")).toBe(true);
    expect(matchesQuery({ ...pr, author: "OCTOCAT" }, query, "octocat")).toBe(
      false,
    );
    expect(matchesQuery({ ...pr, state: "CLOSED" }, query, "octocat")).toBe(
      false,
    );
    expect(matchesQuery({ ...pr, reviewedBy: [] }, query, "octocat")).toBe(
      false,
    );
    expect(matchesQuery(pr, query, null)).toBe(false);
  });

  it.each([
    ["-author:ALICE", false],
    ["-author:bob", true],
    ["-author:@me", true],
    ["-author:bob -author:alice", false],
    ["-assignee:@me", false],
    ["-assignee:bob -assignee:octocat", false],
    ["-is:open", false],
    ["-state:closed", true],
    ['-label:"good first issue"', false],
    ["-label:feature -label:bug", false],
    ["-repo:acme/widgets", false],
    ["-repo:other/repo", true],
    ["-no:assignee -no:label", true],
    ["-cache", false],
    ['-"cache invalidation"', false],
    ["cache -missing", true],
    ["cache -", true],
    ["-author:", true],
    ["-no:unknown", true],
  ])("applies exclusion %s", (text, expected) => {
    expect(matchesQuery(issue, parseQuery(text), "octocat")).toBe(expected);
  });

  it("negates missing fields and reviewers, including unknown viewers", () => {
    const pr: Item = { ...issue, kind: "pr", reviewedBy: ["octocat"] };
    expect(matchesQuery(pr, parseQuery("-reviewed-by:@me"), "octocat")).toBe(
      false,
    );
    expect(matchesQuery(pr, parseQuery("-reviewed-by:bob"), "octocat")).toBe(
      true,
    );
    expect(matchesQuery(pr, parseQuery("-reviewed-by:@me"), null)).toBe(true);
    expect(matchesQuery(issue, parseQuery("-author:@me"), null)).toBe(true);
    expect(
      matchesQuery(
        { ...issue, assignees: [] },
        parseQuery("-no:assignee"),
        null,
      ),
    ).toBe(false);
    expect(
      matchesQuery({ ...issue, labels: [] }, parseQuery("-no:label"), null),
    ).toBe(false);
  });

  it("preserves minus signs when completing negative qualifiers and values", () => {
    const vocab = {
      users: ["alice"],
      labels: ["good first issue"],
      repos: ["acme/widgets"],
    };
    expect(buildSuggestions("-aut", vocab, "pr", "octocat")[0]).toMatchObject({
      insert: "-author:",
      label: "-author:",
    });
    expect(
      buildSuggestions("-author:@", vocab, "pr", "octocat")[0],
    ).toMatchObject({
      insert: "-author:@me ",
      icon: { kind: "avatar", login: "octocat" },
    });
    expect(buildSuggestions("-label:good", vocab, "pr", null)[0]?.insert).toBe(
      '-label:"good first issue" ',
    );
    expect(buildSuggestions("-rev", vocab, "issue", null)).toEqual([]);
  });
  it("matches submitted reviewers case-insensitively, including @me and combined filters", () => {
    const pr: Item = { ...issue, kind: "pr", reviewedBy: ["Octocat", "bob"] };
    expect(
      matchesQuery(
        pr,
        parseQuery("reviewed-by:OCTOCAT is:open repo:acme/widgets cache"),
        null,
      ),
    ).toBe(true);
    expect(matchesQuery(pr, parseQuery("reviewed-by:@me"), "octocat")).toBe(
      true,
    );
    expect(matchesQuery(pr, parseQuery("reviewed-by:@me"), null)).toBe(false);
    expect(matchesQuery(pr, parseQuery("reviewed-by:alice"), "alice")).toBe(
      false,
    );
    expect(
      matchesQuery(pr, parseQuery("reviewed-by:alice reviewed-by:bob"), null),
    ).toBe(true);
    expect(
      matchesQuery(
        { ...pr, reviewedBy: undefined },
        parseQuery("reviewed-by:bob"),
        null,
      ),
    ).toBe(false);
    expect(
      matchesQuery(issue, parseQuery("reviewed-by:octocat"), "octocat"),
    ).toBe(false);
    expect(matchesQuery(pr, parseQuery("reviewed-by:"), null)).toBe(true);
  });

  it("suggests reviewer qualifiers and users only for pull requests", () => {
    const vocab = { users: ["octocat", "alice"], labels: [], repos: [] };
    expect(
      buildSuggestions("rev", vocab, "pr", "octocat").map((s) => s.insert),
    ).toEqual(["reviewed-by:"]);
    expect(buildSuggestions("rev", vocab, "issue", "octocat")).toEqual([]);
    expect(
      buildSuggestions("reviewed-by:@", vocab, "pr", "octocat")[0],
    ).toMatchObject({ insert: "reviewed-by:@me ", label: "@me (octocat)" });
    expect(
      buildSuggestions("reviewed-by:ali", vocab, "pr", null)[0],
    ).toMatchObject({
      insert: "reviewed-by:alice ",
      icon: { kind: "avatar", login: "alice" },
    });
  });
  it("parses quoted qualifiers and matches viewer-relative filters", () => {
    const parsed = parseQuery(
      'is:open assignee:@me author:alice label:"good first issue" repo:acme/widgets #7',
    );

    expect(parsed).toEqual({
      states: ["OPEN"],
      assignees: ["@me"],
      authors: ["alice"],
      reviewedBy: [],
      labels: ["good first issue"],
      repos: ["acme/widgets"],
      noAssignee: false,
      noLabel: false,
      text: ["#7"],
      excluded: [],
    });
    expect(matchesQuery(issue, parsed, "octocat")).toBe(true);
    expect(matchesQuery(issue, parsed, null)).toBe(false);
  });

  it("applies negative, state, and plain-text filters independently", () => {
    expect(matchesQuery(issue, parseQuery("is:closed"), "octocat")).toBe(false);
    expect(matchesQuery(issue, parseQuery("no:assignee"), "octocat")).toBe(
      false,
    );
    expect(matchesQuery(issue, parseQuery("no:label"), "octocat")).toBe(false);
    expect(
      matchesQuery(issue, parseQuery("cache acme/widgets"), "octocat"),
    ).toBe(true);
    expect(matchesQuery(issue, parseQuery("missing"), "octocat")).toBe(false);
    expect(matchesQuery(issue, parseQuery("state:"), "octocat")).toBe(true);
  });

  it("builds bounded qualifier values without losing labels containing spaces", () => {
    const vocab = {
      users: ["alice", "octocat"],
      labels: ["bug", "good first issue"],
      repos: ["acme/widgets"],
    };
    const compact = (token: string, kind: "issue" | "pr") =>
      buildSuggestions(token, vocab, kind, "octocat").map(
        ({ insert, label }) => ({ insert, label }),
      );

    expect(compact("is:", "pr")).toEqual([
      { insert: "is:open ", label: "open" },
      { insert: "is:closed ", label: "closed" },
      { insert: "is:merged ", label: "merged" },
    ]);
    expect(compact("label:good", "issue")).toEqual([
      {
        insert: 'label:"good first issue" ',
        label: "good first issue",
      },
    ]);
    expect(compact("assignee:@", "issue")).toEqual([
      { insert: "assignee:@me ", label: "@me (octocat)" },
    ]);
    expect(compact("no:l", "issue")).toEqual([
      { insert: "no:label ", label: "no:label" },
    ]);
    expect(compact("unknown:value", "issue")).toEqual([]);
    expect(buildSuggestions("is:o", vocab, "pr", "octocat")[0]?.icon).toEqual({
      kind: "state",
      itemKind: "pr",
      state: "OPEN",
    });
    expect(
      buildSuggestions("author:ali", vocab, "issue", "octocat")[0]?.icon,
    ).toEqual({ kind: "avatar", login: "alice" });
  });
});
