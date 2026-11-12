import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { githubRpcContract } from "./server";

const fake = vi.hoisted(() => ({
  responses: new Map<string, string | Error>(),
  calls: [] as string[][],
}));
vi.mock("@get-bb/plugin-sdk/process", () => ({
  experimental_execHostFileCallback(
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) {
    if (file !== "gh") throw new Error(`Unexpected executable ${file}`);
    fake.calls.push(args);
    if (args[0] === "--version" || args[0] === "auth")
      return callback(null, "ok", "");
    expect(options).toEqual({ timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const name = args.find((arg) => arg.startsWith("name="))?.slice(5);
    const cursor = args.find((arg) => arg.startsWith("cursor="))?.slice(7);
    const response = fake.responses.get(
      cursor ? `${name}:${cursor}` : (name ?? ""),
    );
    if (response === undefined)
      return callback(new Error("unexpected command"), "", "");
    if (response instanceof Error)
      return callback(response, "", response.message);
    callback(null, response, "");
  },
}));

function node(number: number, state = "OPEN") {
  return {
    number,
    state,
    isDraft: false,
    title: `Title ${number}`,
    author: { login: "robot[bot]" },
    labels: { nodes: [{ name: "bug" }] },
    assignees: { nodes: [{ login: "alice" }] },
    reviews: {
      nodes: [] as { author: { login: string } | null }[],
      pageInfo: { hasNextPage: false, endCursor: null as string | null },
    },
    body: "Body\ntext",
    url: `https://github.com/acme/one/issues/${number}`,
    updatedAt: "2026-09-10T00:00:00Z",
  };
}
function repository() {
  return {
    hasIssuesEnabled: true,
    openIssues: { nodes: [node(1)] },
    closedIssues: { nodes: [node(2, "CLOSED")] },
    openPrs: { nodes: [node(3)] },
    closedPrs: { nodes: [node(4, "CLOSED"), node(5, "MERGED")] },
  };
}
function response(repo = repository()) {
  return JSON.stringify({ data: { repository: repo } });
}
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
beforeEach(() => {
  fake.responses.clear();
  fake.calls = [];
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
async function start(repos = "acme/one") {
  const host = createFakePluginHost({
    pluginId: "github-fred",
    settings: { extraRepos: repos },
    sdk: { projects: { list: async () => [] } },
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

it("maps all four lists into SQLite and preserves closed/merged filtering", async () => {
  fake.responses.set("one", response());
  const { harness, bb } = await start();
  expect(await harness.behavior.callRpc("refresh")).toEqual({
    repos: 1,
    items: 5,
  });
  expect(
    bb.storage.database().prepare("SELECT count(*) AS n FROM items").get(),
  ).toEqual({ n: 5 });
  const { items } = githubRpcContract.listItems.output.parse(
    await harness.behavior.callRpc("listItems", { state: "closed" }),
  );
  expect(items.map((item: { state: string }) => item.state).sort()).toEqual([
    "CLOSED",
    "CLOSED",
    "MERGED",
  ]);
  expect(
    await harness.behavior.callRpc("listItems", {
      kind: "issue",
      state: "open",
    }),
  ).toEqual({
    items: [
      {
        repo: "acme/one",
        kind: "issue",
        number: 1,
        state: "OPEN",
        title: "Title 1",
        author: "app/robot[bot]",
        labels: ["bug"],
        assignees: ["alice"],
        body: "Body\ntext",
        url: "https://github.com/acme/one/issues/1",
        updatedAt: "2026-09-10T00:00:00Z",
      },
    ],
  });
  expect(fake.calls.filter((args) => args[1] === "graphql")).toHaveLength(1);
});

it("persists all reviewer pages, deduplicates logins, and publishes reviewer-only changes", async () => {
  const repo = repository();
  repo.openPrs.nodes[0].reviews = {
    nodes: [{ author: { login: "alice" } }, { author: null }],
    pageInfo: { hasNextPage: true, endCursor: "reviews-page-2" },
  };
  fake.responses.set("one", response(repo));
  fake.responses.set(
    "one:reviews-page-2",
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                { author: { login: "alice" } },
                { author: { login: "bob" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  );
  const { harness, bb } = await start();
  await harness.behavior.callRpc("refresh");
  expect(
    await harness.behavior.callRpc("listItems", { kind: "pr", state: "open" }),
  ).toMatchObject({ items: [{ reviewedBy: ["alice", "bob"] }] });
  expect(
    bb.storage
      .database()
      .prepare("SELECT reviewed_by FROM items WHERE number = 3")
      .get(),
  ).toEqual({ reviewed_by: '["alice","bob"]' });
  const query = fake.calls
    .find((args) =>
      args.some((arg) => arg.startsWith("query=query RepositoryLists")),
    )!
    .join(" ");
  expect(query).toContain(
    "states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]",
  );
  expect(query).not.toContain("PENDING");
  const changes = () =>
    harness.realtimeSignals.filter((s) => s.channel === "data-changed").length;
  const before = changes();
  repo.openPrs.nodes[0].reviews = {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  fake.responses.set("one", response(repo));
  await harness.behavior.callRpc("refresh");
  expect(changes()).toBe(before + 1);
  expect(
    await harness.behavior.callRpc("listItems", { kind: "pr", state: "open" }),
  ).toMatchObject({ items: [{ reviewedBy: [] }] });
});

it("keeps cached reviewers when fetching an overflow page fails", async () => {
  fake.responses.set("one", response());
  const { harness } = await start();
  await harness.behavior.callRpc("refresh");
  const before = await harness.behavior.callRpc("listItems", {});
  const repo = repository();
  repo.openPrs.nodes[0].reviews.pageInfo = {
    hasNextPage: true,
    endCursor: "missing",
  };
  fake.responses.set("one", response(repo));
  await expect(harness.behavior.callRpc("refresh")).rejects.toThrow();
  expect(await harness.behavior.callRpc("listItems", {})).toEqual(before);
});

it("accepts deleted authors and empty connections, discards disabled issues, and clears stale rows on success", async () => {
  fake.responses.set("one", response());
  const { harness } = await start();
  await harness.behavior.callRpc("refresh");
  const repo = {
    ...repository(),
    hasIssuesEnabled: false,
    openPrs: {
      nodes: [
        {
          ...node(3),
          author: null,
          labels: { nodes: [] },
          assignees: { nodes: [] },
        },
      ],
    },
    closedPrs: { nodes: [] },
  };
  fake.responses.set("one", JSON.stringify({ data: { repository: repo } }));
  expect(await harness.behavior.callRpc("refresh")).toEqual({
    repos: 1,
    items: 1,
  });
  expect(await harness.behavior.callRpc("listItems", {})).toMatchObject({
    items: [{ number: 3, author: "app/", labels: [], assignees: [] }],
  });
  fake.responses.set(
    "one",
    response({
      hasIssuesEnabled: true,
      openIssues: { nodes: [] },
      closedIssues: { nodes: [] },
      openPrs: { nodes: [] },
      closedPrs: { nodes: [] },
    }),
  );
  expect(await harness.behavior.callRpc("refresh")).toEqual({
    repos: 1,
    items: 0,
  });
  expect(await harness.behavior.callRpc("listItems", {})).toEqual({
    items: [],
  });
});

it.each([
  ["process failure", new Error("timeout")],
  ["invalid JSON", "broken"],
  ["null repository", JSON.stringify({ data: { repository: null } })],
  [
    "missing alias",
    JSON.stringify({
      data: { repository: { ...repository(), closedPrs: undefined } },
    }),
  ],
  [
    "partial GraphQL error",
    JSON.stringify({
      data: { repository: repository() },
      errors: [
        { message: "resource limit", path: ["repository", "openIssues"] },
      ],
    }),
  ],
  [
    "null connection",
    JSON.stringify({
      data: { repository: { ...repository(), openIssues: null } },
    }),
  ],
  [
    "malformed node",
    response({
      ...repository(),
      openIssues: { nodes: [{ ...node(1), number: -1 }] },
    }),
  ],
])(
  "retains repository rows and cursor after %s, then allows another repository to succeed",
  async (_name, failed) => {
    fake.responses.set("one", response());
    const { harness, bb } = await start();
    await harness.behavior.callRpc("refresh");
    const before = await harness.behavior.callRpc("listItems", {});
    const cursor = await bb.storage.kv.get("sync-cursor");
    fake.responses.set("one", failed);
    await expect(harness.behavior.callRpc("refresh")).rejects.toThrow();
    expect(await harness.behavior.callRpc("listItems", {})).toEqual(before);
    expect(await bb.storage.kv.get("sync-cursor")).toEqual(cursor);
    await harness.behavior.setSettings({ extraRepos: "acme/one,acme/two" });
    fake.responses.set("two", response());
    expect(await harness.behavior.callRpc("refresh")).toEqual({
      repos: 2,
      items: 5,
    });
    expect(
      await harness.behavior.callRpc("listItems", { repo: "acme/one" }),
    ).toEqual(before);
    expect(
      bb.storage.database().prepare("SELECT count(*) AS n FROM items").get(),
    ).toEqual({ n: 10 });
  },
);

it("caches draft flags and publishes changes when only draft status changes", async () => {
  const repo = repository();
  repo.openPrs.nodes[0].isDraft = true;
  fake.responses.set("one", response(repo));
  const { harness, bb } = await start();
  await harness.behavior.callRpc("refresh");
  const getOpenPrs = () =>
    harness.behavior.callRpc("listItems", { kind: "pr", state: "open" });
  expect(await getOpenPrs()).toMatchObject({
    items: [{ state: "OPEN", isDraft: true }],
  });
  expect(
    bb.storage
      .database()
      .prepare("SELECT is_draft FROM items WHERE kind = 'pr' AND number = 3")
      .get(),
  ).toEqual({ is_draft: 1 });
  const changes = () =>
    harness.realtimeSignals.filter(
      (signal) => signal.channel === "data-changed",
    ).length;
  const before = changes();
  repo.openPrs.nodes[0].isDraft = false;
  fake.responses.set("one", response(repo));
  await harness.behavior.callRpc("refresh");
  expect(changes()).toBe(before + 1);
  const result = githubRpcContract.listItems.output.parse(await getOpenPrs());
  expect(result.items[0].isDraft ?? false).toBe(false);
});

it("syncs all conversation comment pages for issues and PRs and retains rows on overflow failure", async () => {
  const comments = (
    logins: (string | null)[],
    cursor: string | null = null,
  ) => ({
    nodes: logins.map((login) => ({
      author: login === null ? null : { login },
    })),
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  });
  const repo = repository();
  Object.assign(repo.openIssues.nodes[0], {
    comments: comments(["alice", null], "issue-next"),
  });
  Object.assign(repo.openPrs.nodes[0], {
    comments: comments(["bob"], "pr-next"),
  });
  fake.responses.set("one", response(repo));
  for (const [cursor, logins] of [
    ["issue-next", ["alice", "carol"]],
    ["pr-next", ["dave"]],
  ] as const) {
    fake.responses.set(
      `one:${cursor}`,
      JSON.stringify({
        data: {
          repository: {
            item: { comments: comments([...logins]) },
          },
        },
      }),
    );
  }
  const { harness } = await start();
  await harness.behavior.callRpc("refresh");
  const before = await harness.behavior.callRpc("listItems", {});
  expect(before).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        kind: "issue",
        number: 1,
        commenters: ["alice", "carol"],
      }),
      expect.objectContaining({
        kind: "pr",
        number: 3,
        commenters: ["bob", "dave"],
      }),
    ]),
  });
  const queries = fake.calls
    .flat()
    .filter((arg) => arg.startsWith("query=query ItemComments"));
  expect(queries.some((query) => query.includes("item: issue("))).toBe(true);
  expect(queries.some((query) => query.includes("item: pullRequest("))).toBe(
    true,
  );
  fake.responses.set("one:pr-next", new Error("unavailable"));
  await expect(harness.behavior.callRpc("refresh")).rejects.toThrow();
  expect(await harness.behavior.callRpc("listItems", {})).toEqual(before);
  const changesBeforeClear = harness.realtimeSignals.filter(
    (signal) => signal.channel === "data-changed",
  ).length;
  Object.assign(repo.openIssues.nodes[0], { comments: comments([]) });
  Object.assign(repo.openPrs.nodes[0], { comments: comments([]) });
  fake.responses.set("one", response(repo));
  await harness.behavior.callRpc("refresh");
  expect(
    harness.realtimeSignals.filter(
      (signal) => signal.channel === "data-changed",
    ),
  ).toHaveLength(changesBeforeClear + 1);
  expect(await harness.behavior.callRpc("listItems", {})).not.toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ commenters: ["bob", "dave"] }),
    ]),
  });
});
