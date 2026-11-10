import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

vi.mock("@get-bb/plugin-sdk/process", () => ({
  experimental_execHostFileCallback(
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, stdout: string, stderr: string) => void,
  ) {
    callback(null, "ok", "");
  },
}));
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
function thread(id: string, environmentId: string | null) {
  return makeThreadResponse({
    id,
    environmentId,
    title: `Thread ${id}`,
    createdAt: 1000,
  });
}
async function start(
  threads: ReturnType<typeof thread>[],
  rows: Record<string, { outcome: string; pullRequest?: { url: string } }> = {},
) {
  const list = vi.fn(async (raw: unknown) => {
    const args = raw as { limit: number; offset: number };
    return threads.slice(args.offset, args.offset + args.limit);
  });
  const lookup = vi.fn(async (raw: unknown) => {
    const args = raw as {
      pluginId: string;
      method: string;
      input: { keys: string[] };
    };
    expect(args.pluginId).toBe("bb--github-pr-status");
    expect(args.method).toBe("pullRequests");
    return Object.fromEntries(
      args.input.keys.map((key) => [key, rows[key] ?? { outcome: "absent" }]),
    );
  });
  const host = createFakePluginHost({
    pluginId: "github-fred",
    sdk: { threads: { list }, plugins: { callRpc: lookup } },
  });
  hosts.push(host);
  await plugin(host.bb);
  return { ...host, list, lookup };
}
const available = (number: number) => ({
  outcome: "available",
  pullRequest: { url: `https://github.com/acme/widgets/pull/${number}` },
});
const stored = (threadId: string, kind = "pr", number = 42) => ({
  kind,
  repo: "acme/widgets",
  number,
  threadId,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("native PR thread link discovery", () => {
  it("discovers existing threads and batches shared environments without duplicating stored links", async () => {
    const { bb, harness, lookup } = await start(
      [
        thread("a", "shared"),
        thread("b", "shared"),
        thread("c", "other"),
        thread("no-environment", null),
        thread("review", null),
        thread("issue-worker", null),
        { ...thread("archived", "archived-env"), archivedAt: 1 },
        { ...thread("hidden", "hidden-env"), visibility: "hidden" },
        { ...thread("deleted", "deleted-env"), deletedAt: 1 },
      ],
      { shared: available(42), other: available(42) },
    );
    await bb.storage.kv.set("link:pr:acme/widgets#42", [
      stored("a"),
      stored("review"),
    ]);
    await bb.storage.kv.set("link:issue:acme/widgets#7", [
      stored("issue-worker", "issue", 7),
    ]);
    const result = (await harness.behavior.callRpc("listLinks")) as {
      links: Record<string, { threadId: string; title?: string }[]>;
    };
    expect(
      result.links["pr:acme/widgets#42"].map((link) => link.threadId),
    ).toEqual(["a", "b", "c", "review"]);
    expect(result.links["pr:acme/widgets#42"][0].title).toBe("Thread a");
    expect(result.links["issue:acme/widgets#7"]).toMatchObject([
      { threadId: "issue-worker" },
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toMatchObject({
      input: { keys: ["shared", "other"] },
    });
    await harness.behavior.callRpc("listLinks");
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("hides archived explicit PR and issue links and restores them after unarchiving", async () => {
    const worker = thread("worker", "env");
    const { bb, harness } = await start([worker], { env: available(42) });
    await bb.storage.kv.set("link:pr:acme/widgets#42", [stored("worker")]);
    await bb.storage.kv.set("link:issue:acme/widgets#7", [
      stored("worker", "issue", 7),
    ]);
    const before = await harness.behavior.callRpc("listLinks");
    worker.archivedAt = 1;
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: worker,
    });
    expect(await harness.behavior.callRpc("listLinks")).toEqual({ links: {} });
    worker.archivedAt = null;
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: worker,
    });
    expect(await harness.behavior.callRpc("listLinks")).toEqual(before);
  });
  it("follows changed native associations instead of keeping outdated explicit PR links", async () => {
    const rows = { env: available(42) };
    const existing = thread("worker", "env");
    const { bb, harness } = await start([existing], rows);
    await bb.storage.kv.set("link:pr:acme/widgets#42", [stored("worker")]);
    await harness.behavior.callRpc("listLinks");
    rows.env = available(77);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: existing,
      lastAssistantText: null,
    });
    const result = (await harness.behavior.callRpc("listLinks")) as {
      links: Record<string, unknown>;
    };
    expect(result.links["pr:acme/widgets#42"]).toBeUndefined();
    expect(result.links["pr:acme/widgets#77"]).toMatchObject([
      { threadId: "worker" },
    ]);
  });
  it("pages all threads and keeps each native PR lookup batch within 200 environments", async () => {
    const threads = Array.from({ length: 205 }, (_, index) =>
      thread(`t-${index}`, `e-${index}`),
    );
    const rows = Object.fromEntries(
      threads.map((_, index) => [`e-${index}`, available(index + 1)]),
    );
    const { harness, list, lookup } = await start(threads, rows);
    const result = (await harness.behavior.callRpc("listLinks")) as {
      links: Record<string, unknown>;
    };
    expect(Object.keys(result.links)).toHaveLength(205);
    expect(
      list.mock.calls.map(([args]) => (args as { offset: number }).offset),
    ).toEqual([0, 200]);
    expect(
      lookup.mock.calls.map(
        ([args]) => (args as { input: { keys: string[] } }).input.keys.length,
      ),
    ).toEqual([200, 5]);
  });
  it("keeps explicit links if native PR lookup is unavailable and ignores unrelated URLs", async () => {
    const { bb, harness, lookup } = await start(
      [thread("one", "env"), thread("review", null)],
      {
        env: {
          outcome: "available",
          pullRequest: {
            url: "https://other.example/github.com/acme/widgets/pull/42",
          },
        },
      },
    );
    await bb.storage.kv.set("link:pr:acme/widgets#42", [stored("review")]);
    const expected = { links: { "pr:acme/widgets#42": [stored("review")] } };
    expect(await harness.behavior.callRpc("listLinks")).toEqual(expected);
    lookup.mockRejectedValueOnce(new Error("plugin disabled"));
    await harness.behavior.emitThreadEvent("thread.created", {
      thread: thread("two", "env"),
    });
    expect(await harness.behavior.callRpc("listLinks")).toEqual(expected);
  });
});
