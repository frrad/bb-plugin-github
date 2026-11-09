import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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
async function start() {
  const host = createFakePluginHost({ pluginId: "github-fred" });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}
const id = { kind: "pr", repo: "acme/widgets", number: 42 };
describe("note RPC persistence", () => {
  it("persists notes across reload and rejects stale updates from another device", async () => {
    const host = await start();
    let harness = host.harness;
    expect(
      await harness.behavior.callRpc("saveNote", {
        ...id,
        body: "One",
        revision: 0,
      }),
    ).toEqual({ saved: true, note: { body: "One", revision: 1 } });
    const replacement = await harness.lifecycle.reload(plugin);
    hosts.splice(hosts.indexOf(host), 1, replacement);
    harness = replacement.harness;
    expect(await harness.behavior.callRpc("listNotes")).toEqual({
      notes: [{ ...id, body: "One", revision: 1 }],
    });
    expect(
      await harness.behavior.callRpc("saveNote", {
        ...id,
        body: "Stale device",
        revision: 0,
      }),
    ).toEqual({ saved: false, note: { body: "One", revision: 1 } });
    expect(
      await harness.behavior.callRpc("saveNote", {
        ...id,
        body: "Two",
        revision: 1,
      }),
    ).toEqual({ saved: true, note: { body: "Two", revision: 2 } });
  });
  it("never overwrites existing or cleared server notes during browser import", async () => {
    const { harness } = await start();
    await harness.behavior.callRpc("saveNote", {
      ...id,
      body: "Server note",
      revision: 0,
    });
    expect(
      await harness.behavior.callRpc("saveNote", {
        ...id,
        body: "Browser note",
        revision: 0,
        importOnly: true,
      }),
    ).toMatchObject({ saved: false, note: { body: "Server note" } });
    await harness.behavior.callRpc("saveNote", {
      ...id,
      body: "",
      revision: 1,
    });
    expect(
      await harness.behavior.callRpc("saveNote", {
        ...id,
        body: "Old browser note",
        revision: 0,
        importOnly: true,
      }),
    ).toEqual({ saved: false, note: { body: "", revision: 2 } });
  });
  it("keeps notes isolated by complete item identity", async () => {
    const { harness } = await start();
    for (const entry of [
      id,
      { ...id, kind: "issue" },
      { ...id, repo: "other/widgets" },
      { ...id, number: 7 },
    ]) {
      expect(
        await harness.behavior.callRpc("saveNote", {
          ...entry,
          body: "Note",
          revision: 0,
        }),
      ).toMatchObject({ saved: true });
    }
    const listed = (await harness.behavior.callRpc("listNotes")) as {
      notes: unknown[];
    };
    expect(listed.notes).toHaveLength(4);
  });
});
