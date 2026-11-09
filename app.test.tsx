// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, within } from "@testing-library/dom";
import { itemNoteKey, itemNotes, type ServerNote } from "./item-notes";
import { panelCache } from "./panel-cache";
import { SEARCHES_KEY } from "./saved-searches.js";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

beforeEach(() => {
  window.localStorage.clear();
  itemNotes.clear();
  for (const cache of Object.values(panelCache)) cache.clear();
});

describe("item notes", () => {
  it("expands without navigating, shares notes across searches, and restores them on return", async () => {
    const item = {
      number: 42,
      title: "A pull request",
      repo: "acme/widgets",
      kind: "pr",
      state: "OPEN",
      author: "octocat",
      labels: [],
      assignees: [],
      url: "https://github.com/acme/widgets/pull/42",
      body: "",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    window.localStorage.setItem(
      SEARCHES_KEY,
      JSON.stringify([
        {
          id: "one",
          name: "First search",
          kind: "pr",
          query: "",
          collapsed: false,
        },
        {
          id: "two",
          name: "Second search",
          kind: "pr",
          query: "",
          collapsed: false,
        },
      ]),
    );
    const serverNotes = new Map<string, ServerNote>();
    const mount = () =>
      renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: {
            listNotes: () => ({ notes: [...serverNotes.values()] }),
            saveNote: (raw: unknown) => {
              const input = raw as ServerNote;
              const key = itemNoteKey(input.kind, input.repo, input.number);
              const current = serverNotes.get(key) ?? {
                ...input,
                body: "",
                revision: 0,
              };
              if (input.revision !== current.revision)
                return {
                  saved: false,
                  note: { body: current.body, revision: current.revision },
                };
              const saved = { ...input, revision: input.revision + 1 };
              serverNotes.set(key, saved);
              return {
                saved: true,
                note: { body: saved.body, revision: saved.revision },
              };
            },
            status: () => ({
              ghOk: true,
              ghState: "ready",
              ghError: null,
              repos: [{ repo: "acme/widgets", projectId: null }],
              lastSyncedAt: new Date().toISOString(),
            }),
            listItems: () => ({ items: [item] }),
            listLinks: () => ({ links: {} }),
            viewer: () => ({ login: "octocat" }),
          },
        },
      );
    const slot = mount();
    await slot.findAllByText("A pull request");
    const first = within(slot.getByRole("region", { name: "First search" }));
    const second = within(slot.getByRole("region", { name: "Second search" }));
    expect(
      first.queryByRole("textbox", { name: "Notes for acme/widgets#42" }),
    ).toBeNull();
    await act(async () => {
      first
        .getByRole("button", { name: "Show notes for acme/widgets#42" })
        .click();
      second
        .getByRole("button", { name: "Show notes for acme/widgets#42" })
        .click();
    });
    await act(async () =>
      fireEvent.change(
        first.getByRole("textbox", { name: "Notes for acme/widgets#42" }),
        { target: { value: "Check edge cases before reviewing." } },
      ),
    );
    expect(
      (
        second.getByRole("textbox", {
          name: "Notes for acme/widgets#42",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Check edge cases before reviewing.");
    await act(async () =>
      fireEvent.focusOut(
        first.getByRole("textbox", { name: "Notes for acme/widgets#42" }),
      ),
    );
    expect(serverNotes.get(itemNoteKey("pr", "acme/widgets", 42))?.body).toBe(
      "Check edge cases before reviewing.",
    );
    expect(
      window.localStorage.getItem(itemNoteKey("pr", "acme/widgets", 42)),
    ).toBeNull();
    expect(slot.navigateCalls).toEqual([]);
    await act(async () =>
      first
        .getByRole("button", { name: "Hide notes for acme/widgets#42" })
        .click(),
    );
    expect(
      first.queryByRole("textbox", { name: "Notes for acme/widgets#42" }),
    ).toBeNull();
    slot.lifecycle.unmount();
    itemNotes.clear();

    const reopened = mount();
    await act(async () => {});
    const restored = within(
      reopened.getByRole("region", { name: "First search" }),
    );
    await act(async () =>
      restored
        .getByRole("button", { name: "Show notes for acme/widgets#42" })
        .click(),
    );
    expect(
      (
        restored.getByRole("textbox", {
          name: "Notes for acme/widgets#42",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Check edge cases before reviewing.");
    await act(async () =>
      fireEvent.change(
        restored.getByRole("textbox", { name: "Notes for acme/widgets#42" }),
        { target: { value: "" } },
      ),
    );
    await act(async () =>
      fireEvent.focusOut(
        restored.getByRole("textbox", { name: "Notes for acme/widgets#42" }),
      ),
    );
    expect(serverNotes.get(itemNoteKey("pr", "acme/widgets", 42))?.body).toBe(
      "",
    );
    reopened.lifecycle.unmount();
  });
});

describe("GitHub table controls", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sorts rows, drags widths, and restores each search's preferences", async () => {
    const entries = [
      { number: 20, title: "Charlie" },
      { number: 3, title: "Alpha" },
      { number: 10, title: "Beta" },
    ].map((entry) => ({
      ...entry,
      repo: "acme/widgets",
      kind: "pr",
      state: "OPEN",
      author: "octocat",
      labels: [],
      assignees: [],
      url: `https://github.com/acme/widgets/pull/${entry.number}`,
      body: "",
      updatedAt: "2026-08-20T00:00:00.000Z",
    }));
    const mount = () =>
      renderSlot(
        app.navPanels[0]!,
        { subPath: "pulls" },
        {
          rpc: {
            status: () => ({
              ghOk: true,
              ghState: "ready",
              ghError: null,
              repos: [{ repo: "acme/widgets", projectId: null }],
              lastSyncedAt: new Date().toISOString(),
            }),
            listItems: () => ({ items: entries }),
            listLinks: () => ({ links: {} }),
            viewer: () => ({ login: "octocat" }),
          },
        },
      );
    const slot = mount();
    await slot.findByText("Charlie");
    const section = slot.getByRole("region", { name: "My search" });
    const titles = () =>
      within(section)
        .getAllByRole("row")
        .slice(1)
        .map((row) => {
          return entries.find((entry) => row.textContent?.includes(entry.title))
            ?.title;
        });
    expect(titles()).toEqual(["Charlie", "Alpha", "Beta"]);
    await act(async () =>
      within(section).getByRole("button", { name: "Title" }).click(),
    );
    expect(titles()).toEqual(["Alpha", "Beta", "Charlie"]);
    expect(
      within(section)
        .getByRole("columnheader", { name: /Title/ })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    await act(async () =>
      within(section).getByRole("button", { name: /Title/ }).click(),
    );
    expect(titles()).toEqual(["Charlie", "Beta", "Alpha"]);
    await act(async () =>
      within(section).getByRole("button", { name: /Title/ }).click(),
    );
    expect(titles()).toEqual(["Charlie", "Alpha", "Beta"]);
    await act(async () =>
      within(section).getByRole("button", { name: "ID" }).click(),
    );
    expect(titles()).toEqual(["Alpha", "Beta", "Charlie"]);

    vi.stubGlobal("PointerEvent", MouseEvent);
    const handle = within(section).getByRole("separator", {
      name: "Resize Repo column",
    });
    await act(async () =>
      fireEvent.pointerDown(handle, { button: 0, clientX: 100 }),
    );
    await act(async () => fireEvent.pointerMove(handle, { clientX: 180 }));
    expect(handle.getAttribute("aria-valuenow")).toBe("208");
    await act(async () => fireEvent.pointerUp(handle));
    const stored = JSON.parse(window.localStorage.getItem(SEARCHES_KEY)!);
    expect(stored[0].table.widths.repo).toBe(208);
    expect(stored[0].table.sort).toEqual({ column: "id", direction: "asc" });
    await act(async () =>
      slot.getByRole("button", { name: "Add search" }).click(),
    );
    const second = slot.getByRole("region", { name: "Search 2" });
    expect(
      within(second)
        .getByRole("separator", { name: "Resize Repo column" })
        .getAttribute("aria-valuenow"),
    ).toBe("128");
    slot.lifecycle.unmount();

    const reopened = mount();
    await act(async () => {});
    const restored = reopened.getByRole("region", { name: "My search" });
    const restoredHandle = within(restored).getByRole("separator", {
      name: "Resize Repo column",
    });
    expect(restoredHandle.getAttribute("aria-valuenow")).toBe("208");
    expect(
      within(restored)
        .getByRole("columnheader", { name: /ID/ })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    await act(async () =>
      fireEvent.keyDown(restoredHandle, { key: "ArrowLeft" }),
    );
    expect(restoredHandle.getAttribute("aria-valuenow")).toBe("192");
    await act(async () => fireEvent.doubleClick(restoredHandle));
    expect(restoredHandle.getAttribute("aria-valuenow")).toBe("128");
    reopened.lifecycle.unmount();
  });
});

describe("GitHub cached navigation", () => {
  afterEach(() => vi.restoreAllMocks());
  const item = {
    repo: "acme/widgets",
    number: 42,
    kind: "pr" as const,
    title: "Cached pull request",
    state: "OPEN",
    author: "octocat",
    labels: [],
    assignees: [],
    url: "https://github.com/acme/widgets/pull/42",
    body: "",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const status = {
    ghOk: true,
    ghState: "ready" as const,
    ghError: null,
    repos: [{ repo: "acme/widgets", projectId: null }],
    lastSyncedAt: null,
  };

  it("renders cached rows immediately on return while revalidating and automatically syncing", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const first = renderSlot(
      app.navPanels[0]!,
      { subPath: "pulls" },
      {
        rpc: {
          status: () => status,
          listItems: () => ({ items: [item] }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
          refresh: () => ({ repos: 1, items: 1 }),
        },
      },
    );
    await first.findByText("Cached pull request");
    await act(async () => {});
    first.lifecycle.unmount();
    clock.mockReturnValue(now + 10 * 60_000);

    let finishRead!: (value: { items: (typeof item)[] }) => void;
    let finishSync!: (value: { repos: number; items: number }) => void;
    const read = new Promise<{ items: (typeof item)[] }>((resolve) => {
      finishRead = resolve;
    });
    const sync = new Promise<{ repos: number; items: number }>((resolve) => {
      finishSync = resolve;
    });
    const refresh = vi.fn(() => sync);
    const reopened = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => status,
          listItems: () => read,
          listLinks: () => ({ links: {} }),
          refresh,
        },
      },
    );
    expect(reopened.getByText("Cached pull request")).toBeTruthy();
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRead({ items: [{ ...item, title: "Updated pull request" }] });
      finishSync({ repos: 1, items: 1 });
    });
    expect(reopened.getByText("Updated pull request")).toBeTruthy();
    expect(reopened.queryByText("Cached pull request")).toBeNull();
    reopened.lifecycle.unmount();
  });

  it("skips automatic GitHub sync for fresh data, syncs at ten minutes, and retries failures", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const refresh = vi.fn(() => ({ repos: 1, items: 1 }));
    const mount = () =>
      renderSlot(
        app.navPanels[0]!,
        { subPath: "pulls" },
        {
          rpc: {
            status: () => ({
              ...status,
              lastSyncedAt: new Date(now).toISOString(),
            }),
            listItems: () => ({ items: [item] }),
            listLinks: () => ({ links: {} }),
            viewer: () => ({ login: "octocat" }),
            refresh,
          },
        },
      );
    const fresh = mount();
    await act(async () => {});
    expect(refresh).not.toHaveBeenCalled();
    fresh.lifecycle.unmount();

    clock.mockReturnValue(now + 9 * 60_000);
    const stillFresh = mount();
    await act(async () => {});
    expect(refresh).not.toHaveBeenCalled();
    stillFresh.lifecycle.unmount();

    clock.mockReturnValue(now + 10 * 60_000);
    refresh.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    const failed = mount();
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
    failed.lifecycle.unmount();

    const retry = mount();
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(2);
    retry.lifecycle.unmount();

    const afterSuccess = mount();
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(2);
    afterSuccess.lifecycle.unmount();
  });

  it("keeps cached rows visible when the revalidation fails", async () => {
    await panelCache.pulls.refresh(async () => [item]);
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pulls" },
      {
        rpc: {
          status: () => status,
          listItems: () => {
            throw new Error("offline");
          },
          refresh: () => {
            throw new Error("offline");
          },
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );
    await act(async () => {});
    expect(slot.getByText("Cached pull request")).toBeTruthy();
    expect(slot.getByText(/Showing cached results/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("uses the existing header button to sync and reports progress until it completes", async () => {
    let finish!: (value: { repos: number; items: number }) => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ repos: number; items: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const slot = renderSlot(
      { component: app.navPanels[0]!.headerContent! },
      { subPath: "" },
      {
        rpc: {
          status: () => status,
          listItems: () => ({ items: [item] }),
          listLinks: () => ({ links: {} }),
          refresh,
        },
      },
    );
    await act(async () =>
      slot.getByRole("button", { name: "Refresh GitHub data" }).click(),
    );
    await slot.emitRealtime("sync-progress", {
      running: true,
      completed: 2,
      total: 8,
      failed: 1,
    });
    expect(
      slot.getByRole("button", {
        name: "Syncing GitHub data: 2 of 8 repos · 1 failed",
      }),
    ).toBeTruthy();
    await slot.emitRealtime("sync-progress", {
      running: false,
      completed: 8,
      total: 8,
      failed: 1,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      (
        slot.getByRole("button", {
          name: "Syncing GitHub data",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => finish({ repos: 1, items: 1 }));
    expect(
      (
        slot.getByRole("button", {
          name: "Refresh GitHub data",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    slot.lifecycle.unmount();
  });
});

describe("GitHub tab persistence", () => {
  const key = "bb-plugin-github-fred:tab";
  const mount = (subPath: string) =>
    renderSlot(
      app.navPanels[0]!,
      { subPath },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{ repo: "get-bb/bb", projectId: null }],
            lastSyncedAt: null,
          }),
          listItems: () => ({ items: [] }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );

  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it.each(["pulls", "issues"])(
    "restores %s after leaving and reopening the page",
    async (tab) => {
      window.localStorage.setItem(key, tab === "pulls" ? "issues" : "pulls");
      const first = mount(tab);
      await act(async () => {});
      first.lifecycle.unmount();

      const reopened = mount("");
      await act(async () => {});
      expect(
        (
          reopened.getByRole("combobox", {
            name: "Search type",
          }) as HTMLSelectElement
        ).value,
      ).toBe(tab === "pulls" ? "pr" : "issue");
      const saved = JSON.parse(window.localStorage.getItem(SEARCHES_KEY)!);
      expect(saved[0].kind).toBe(tab === "pulls" ? "pr" : "issue");
      reopened.lifecycle.unmount();
    },
  );

  it("keeps explicit links ahead of the saved tab", async () => {
    window.localStorage.setItem(key, "pulls");
    const slot = mount("issues");
    await act(async () => {});
    expect(
      (slot.getByRole("combobox", { name: "Search type" }) as HTMLSelectElement)
        .value,
    ).toBe("issue");
    expect(JSON.parse(window.localStorage.getItem(SEARCHES_KEY)!)[0].kind).toBe(
      "issue",
    );
    slot.lifecycle.unmount();
  });

  it("keeps named searches independent and persists editing, ordering, collapse, and removal", async () => {
    window.localStorage.setItem(
      "bb-plugin-github-fred:query",
      "is:open author:@me",
    );
    window.localStorage.setItem(key, "pulls");
    const slot = mount("");
    await act(async () => {});
    const first = slot.getByRole("region", { name: "My search" });
    expect(
      within(first)
        .getByRole("textbox", { name: "Search filter" })
        .getAttribute("value"),
    ).toBe("is:open author:@me");
    await act(async () => {
      fireEvent.change(
        within(first).getByRole("textbox", { name: "Search name" }),
        { target: { value: "My open PRs" } },
      );
      slot.getByRole("button", { name: "Add search" }).click();
    });
    const second = slot.getByRole("region", { name: "Search 2" });
    await act(async () => {
      fireEvent.change(
        within(second).getByRole("textbox", { name: "Search name" }),
        { target: { value: "Open issues" } },
      );
      fireEvent.change(
        within(second).getByRole("textbox", { name: "Search filter" }),
        { target: { value: "is:open label:bug" } },
      );
      fireEvent.change(
        within(second).getByRole("combobox", { name: "Search type" }),
        { target: { value: "issue" } },
      );
    });
    expect(
      (
        within(first).getByRole("combobox", {
          name: "Search type",
        }) as HTMLSelectElement
      ).value,
    ).toBe("pr");
    expect(
      within(first)
        .getByRole("textbox", { name: "Search filter" })
        .getAttribute("value"),
    ).toBe("is:open author:@me");
    await act(async () =>
      within(second).getByRole("button", { name: "Move search up" }).click(),
    );
    expect(
      slot
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Open issues", "My open PRs"]);
    await act(async () =>
      slot.getByRole("button", { name: "Collapse Open issues" }).click(),
    );
    expect(
      within(second).getByRole("textbox", { name: "Search filter" }),
    ).toBeTruthy();
    expect(
      within(second).queryByRole("button", { name: "New issue" }),
    ).toBeNull();
    slot.lifecycle.unmount();

    const reopened = mount("");
    await act(async () => {});
    expect(
      reopened
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["Open issues", "My open PRs"]);
    expect(
      reopened
        .getByRole("button", { name: "Expand Open issues" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await act(async () =>
      reopened.getByRole("button", { name: "Expand Open issues" }).click(),
    );
    const restored = reopened.getByRole("region", { name: "Open issues" });
    expect(
      (
        within(restored).getByRole("combobox", {
          name: "Search type",
        }) as HTMLSelectElement
      ).value,
    ).toBe("issue");
    expect(
      within(restored)
        .getByRole("textbox", { name: "Search filter" })
        .getAttribute("value"),
    ).toBe("is:open label:bug");
    await act(async () =>
      within(restored)
        .getByRole("button", { name: "Move search down" })
        .click(),
    );
    expect(
      reopened
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual(["My open PRs", "Open issues"]);
    await act(async () => {
      for (const button of reopened.getAllByRole("button", {
        name: "Remove search",
      }))
        button.click();
    });
    expect(reopened.queryAllByRole("region")).toHaveLength(0);
    reopened.lifecycle.unmount();

    const empty = mount("");
    await act(async () => {});
    expect(empty.queryAllByRole("region")).toHaveLength(0);
    await act(async () =>
      empty.getByRole("button", { name: "Add search" }).click(),
    );
    expect(empty.getAllByRole("region")).toHaveLength(1);
    empty.lifecycle.unmount();
  });

  it.each(["invalid", "unavailable"])(
    "defaults to Issues when storage is %s",
    async (storage) => {
      if (storage === "invalid") window.localStorage.setItem(key, "garbage");
      else {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
          throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("blocked");
        });
      }
      const slot = mount("");
      await act(async () => {});
      expect(
        (
          slot.getByRole("combobox", {
            name: "Search type",
          }) as HTMLSelectElement
        ).value,
      ).toBe("issue");
      slot.lifecycle.unmount();
    },
  );
});

describe("GitHub app navigation", () => {
  it("shows external GitHub and copy-link actions beside PR review", async () => {
    const url = "https://github.com/get-bb/bb/pull/42";
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pulls" },
      {
        rpc: {
          listItems: () => ({
            items: [
              {
                repo: "get-bb/bb",
                number: 42,
                kind: "pr",
                title: "A pull request",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url,
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{ repo: "get-bb/bb", projectId: null }],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );
    expect(await slot.findByText("Repo")).toBeTruthy();
    expect(
      slot
        .getAllByText("bb")
        .some((cell) => cell.getAttribute("title") === "get-bb/bb"),
    ).toBe(true);
    const github = await slot.findByRole("link", { name: "GitHub" });
    expect(github.getAttribute("href")).toBe(url);
    expect(github.getAttribute("target")).toBe("_blank");
    expect(github.getAttribute("rel")).toBe("noopener noreferrer");
    const actions = slot.getByRole("button", { name: "Review" }).parentElement!;
    expect(actions.textContent).not.toContain("⋮");
    expect(actions.children[1]).toBe(github);
    const copy = slot.getByRole("button", { name: "Copy GitHub link" });
    expect(actions.children[2]).toBe(copy);
    await act(async () => copy.click());
    expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: url },
    ]);
    expect(slot.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("opens issue details in the URL-backed page instead of a fixed tab", async () => {
    const panel = app.navPanels[0]!;
    expect(panel.fixedTabs).toBeUndefined();

    const slot = renderSlot(
      panel,
      { subPath: "issues" },
      {
        rpc: {
          listItems: () => ({
            items: [
              {
                repo: "get-bb/bb",
                number: 42,
                kind: "issue",
                title: "Route-backed issue",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: "https://github.com/get-bb/bb/issues/42",
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{ repo: "get-bb/bb", projectId: null }],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );

    (await slot.findByText("Route-backed issue")).click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github-fred",
      options: { subPath: "issues/get-bb/bb/42" },
    });
    slot.lifecycle.unmount();
  });

  it("keeps removed pull-request files out of live workspace navigation", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-1", environment: null, params: null },
      {
        rpc: {
          pullForThread: () => ({
            pull: {
              repo: "get-bb/bb",
              number: 42,
              environmentId: "env-1",
            },
          }),
          getPull: () => ({
            pull: {
              repo: "get-bb/bb",
              number: 42,
              title: "Navigation fix",
              state: "OPEN",
              author: "octocat",
              body: "",
              url: "https://github.com/get-bb/bb/pull/42",
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:00:00.000Z",
              baseRefName: "main",
              headRefName: "fix-navigation",
              additions: 1,
              deletions: 1,
              changedFiles: 2,
              labels: [],
              assignees: [],
              reviewDecision: "",
              mergeStateStatus: "CLEAN",
              reviewRequests: [],
              checks: [],
              comments: [],
              reviews: [],
              reviewThreads: [],
              files: [
                {
                  path: "removed.ts",
                  status: "removed",
                  additions: 0,
                  deletions: 1,
                  patch: "@@ -1 +0,0 @@\n-removed",
                },
                {
                  path: "modified.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 0,
                  patch: "@@ -0,0 +1 @@\n+added",
                },
              ],
            },
          }),
          listLinks: () => ({ links: {} }),
        },
      },
    );

    await act(async () => {});
    const removedFile = slot.getByText("removed.ts");
    const modifiedFile = slot.getByText("modified.ts");
    expect(removedFile.closest("a")).toBeNull();
    expect(modifiedFile.closest("a")?.getAttribute("href")).toBe(
      "./modified.ts",
    );

    const diffToggle = removedFile.parentElement?.querySelector("button");
    if (!(diffToggle instanceof HTMLButtonElement)) {
      throw new Error("removed file diff toggle was not rendered");
    }
    expect(diffToggle.getAttribute("aria-label")).toBe(
      "Expand removed.ts diff",
    );
    await act(async () => diffToggle.click());
    const diff = slot.getByTestId("bb-diff");
    expect(diff.getAttribute("data-path")).toBe("removed.ts");
    expect(diffToggle.getAttribute("aria-label")).toBe(
      "Collapse removed.ts diff",
    );
    slot.lifecycle.unmount();
  });
});
