// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

describe("GitHub tab persistence", () => {
  const key = "bb-plugin-github-fred:tab";
  const mount = (subPath: string) => renderSlot(
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

  it.each(["pulls", "issues"])("restores %s after leaving and reopening the page", async (tab) => {
    window.localStorage.setItem(key, tab === "pulls" ? "issues" : "pulls");
    const first = mount(tab);
    await act(async () => {});
    first.lifecycle.unmount();

    const reopened = mount("");
    await act(async () => {});
    expect(reopened.getByRole("tab", {
      name: tab === "pulls" ? "Pull requests" : "Issues",
    }).getAttribute("aria-selected")).toBe("true");
    expect(reopened.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github-fred",
      options: { subPath: tab, replace: true },
    });
    reopened.lifecycle.unmount();
  });

  it("keeps explicit links ahead of the saved tab", async () => {
    window.localStorage.setItem(key, "pulls");
    const slot = mount("issues");
    await act(async () => {});
    expect(slot.getByRole("tab", { name: "Issues" }).getAttribute("aria-selected")).toBe("true");
    expect(window.localStorage.getItem(key)).toBe("issues");
    slot.lifecycle.unmount();
  });

  it.each(["invalid", "unavailable"])("defaults to Issues when storage is %s", async (storage) => {
    if (storage === "invalid") window.localStorage.setItem(key, "garbage");
    else {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    }
    const slot = mount("");
    await act(async () => {});
    expect(slot.getByRole("tab", { name: "Issues" }).getAttribute("aria-selected")).toBe("true");
    slot.lifecycle.unmount();
  });
});

describe("GitHub app navigation", () => {
  it("shows external GitHub and copy-link actions beside PR review", async () => {
    const url = "https://github.com/get-bb/bb/pull/42";
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pulls" }, {
      rpc: {
        listItems: () => ({ items: [{
          repo: "get-bb/bb", number: 42, kind: "pr", title: "A pull request",
          state: "OPEN", author: "octocat", labels: [], assignees: [], url,
          body: "", updatedAt: "2026-08-20T00:00:00.000Z",
        }] }),
        listLinks: () => ({ links: {} }),
        status: () => ({
          ghOk: true, ghState: "ready", ghError: null,
          repos: [{ repo: "get-bb/bb", projectId: null }], lastSyncedAt: null,
        }),
        viewer: () => ({ login: "octocat" }),
      },
    });
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
    expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: url }]);
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
