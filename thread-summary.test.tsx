// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/dom";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createThreadPullCache, threadPullCache } from "./thread-pull-cache.js";
import { panelCache } from "./panel-cache.js";
import { itemNotes } from "./item-notes.js";

const app = await loadPluginApp(() => import("./app"));
let columnLeft = 900;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let pane: HTMLElement;
const mounted: Array<{ lifecycle: { unmount(): void } }> = [];
beforeEach(() => {
  threadPullCache.clear();
  for (const cache of Object.values(panelCache)) cache.clear();
  itemNotes.clear();
  columnLeft = 900;
  disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  pane = document.createElement("div");
  pane.setAttribute("data-thread-window", "");
  pane.getBoundingClientRect = () =>
    ({ left: 320, top: 48, bottom: 900, width: 1600 }) as DOMRect;
  const column = document.createElement("div");
  column.setAttribute("data-message-column", "");
  column.getBoundingClientRect = () =>
    ({ left: columnLeft, width: 728 }) as DOMRect;
  pane.append(column);
  document.body.append(pane);
});
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  pane.remove();
  vi.unstubAllGlobals();
});
function mount(
  threadId = "thread-one",
  linked = true,
  overrides: Record<string, (input: unknown) => unknown> = {},
) {
  const slot = renderSlot(
    app.appOverlays[0]!,
    {},
    {
      context: { threadId, projectId: "project-one" },
      rpc: {
        pullForThread: () => ({
          pull: linked
            ? { repo: "acme/widgets", number: 42, environmentId: null }
            : null,
        }),
        listItems: () => ({
          items: [
            {
              repo: "acme/widgets",
              number: 42,
              title: "Improve scheduling",
              url: "https://github.com/acme/widgets/pull/42",
              kind: "pr",
              state: "OPEN",
              author: "octocat",
              labels: [],
              assignees: [],
              body: "",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        listNotes: () => ({
          notes: [
            {
              repo: "acme/widgets",
              kind: "pr",
              number: 42,
              revision: 1,
              body: "Check the latency numbers.",
            },
          ],
        }),
        listSlackLinks: () => ({
          links: [
            {
              repo: "acme/widgets",
              kind: "pr",
              number: 42,
              url: "https://example.slack.com/archives/C123/p1234567890123456",
            },
          ],
        }),
        ...overrides,
      },
    },
  );
  mounted.push(slot);
  return slot;
}
it("shows the linked PR, saved note and Slack link only while the measured gap fits", async () => {
  const slot = mount();
  const title = await slot.findByText("Improve scheduling");
  expect(title.closest("a")?.getAttribute("href")).toBe(
    "https://github.com/acme/widgets/pull/42",
  );
  await slot.findByText("Check the latency numbers.");
  const slack = await slot.findByLabelText(
    "Open Slack thread for acme/widgets#42",
  );
  expect(slack.getAttribute("href")).toContain("example.slack.com/archives/");
  const summary = slot.getByRole("complementary");
  expect(summary.style.width).toBe("288px");
  expect(
    Number.parseFloat(summary.style.left) +
      Number.parseFloat(summary.style.width),
  ).toBeLessThan(columnLeft);
  act(() => {
    columnLeft = 520;
    resize();
  });
  await waitFor(() => expect(slot.queryByRole("complementary")).toBeNull());
  act(() => {
    columnLeft = 900;
    resize();
  });
  await slot.findByText("Improve scheduling");
  slot.lifecycle.unmount();
  mounted.pop();
  expect(disconnect).toHaveBeenCalled();
});
it("shows nothing for an unlinked thread", async () => {
  const slot = mount("unlinked", false);
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "pullForThread"),
    ).toBe(true),
  );
  expect(slot.queryByRole("complementary")).toBeNull();
});
it("removes the previous thread's private note on navigation", async () => {
  const slot = mount();
  await slot.findByText("Check the latency numbers.");
  slot.lifecycle.unmount();
  mounted.pop();
  const next = mount("thread-two", false);
  await waitFor(() =>
    expect(
      next.inspection.rpcCalls.some((call) => call.method === "pullForThread"),
    ).toBe(true),
  );
  expect(next.queryByRole("complementary")).toBeNull();
});
it("declines ambiguous split panes", async () => {
  const second = pane.cloneNode(true) as HTMLElement;
  second.getBoundingClientRect = pane.getBoundingClientRect;
  document.body.append(second);
  const slot = mount();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(slot.queryByRole("complementary")).toBeNull();
  second.remove();
});

it("edits the shared private note and saves its revision on blur", async () => {
  const saveNote = vi.fn(() => ({
    saved: true,
    note: { body: "Updated private note", revision: 2 },
  }));
  const slot = mount("thread-one", true, { saveNote });
  const editor = await slot.findByRole("textbox", {
    name: "Notes for acme/widgets#42",
  });
  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).disabled).toBe(false),
  );
  fireEvent.change(editor, { target: { value: "Updated private note" } });
  fireEvent.blur(editor);
  await waitFor(() =>
    expect(saveNote).toHaveBeenCalledWith({
      kind: "pr",
      repo: "acme/widgets",
      number: 42,
      body: "Updated private note",
      revision: 1,
      importOnly: false,
    }),
  );
  await slot.findByText("Saved on BB server");
});
it("shows conflicts without discarding the draft", async () => {
  const slot = mount("thread-one", true, {
    saveNote: () => ({
      saved: false,
      note: { body: "Changed on another device", revision: 2 },
    }),
  });
  const editor = await slot.findByRole("textbox", {
    name: "Notes for acme/widgets#42",
  });
  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).disabled).toBe(false),
  );
  fireEvent.change(editor, { target: { value: "My draft" } });
  fireEvent.blur(editor);
  await slot.findByText("Changed on another device");
  expect((editor as HTMLTextAreaElement).value).toBe("My draft");
  expect(slot.getByRole("button", { name: "Use server version" })).toBeTruthy();
});
it("renders from the board's cached association without waiting for the background lookup or fetching GitHub details", async () => {
  await panelCache.links.refresh(async () => ({
    "pr:acme/widgets#42": [
      {
        kind: "pr",
        repo: "acme/widgets",
        number: 42,
        threadId: "thread-one",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  }));
  const slot = mount("thread-one", true, {
    pullForThread: () => new Promise(() => {}),
  });
  await slot.findByText("Improve scheduling");
  await slot.findByRole("textbox", { name: "Notes for acme/widgets#42" });
  expect(
    slot.inspection.rpcCalls.some((call) => call.method === "getPull"),
  ).toBe(false);
});

it("keeps a visited thread's summary visible while its next association lookup is pending", async () => {
  const first = mount();
  await first.findByText("Improve scheduling");
  first.lifecycle.unmount();
  mounted.pop();
  const next = mount("thread-one", true, {
    pullForThread: () => new Promise(() => {}),
  });
  await next.findByText("Improve scheduling");
});
it("starts resolving a PR before the transcript has mounted", async () => {
  pane.remove();
  const slot = mount();
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "pullForThread"),
    ).toBe(true),
  );
  expect(slot.queryByRole("complementary")).toBeNull();
  document.body.append(pane);
  await slot.findByText("Improve scheduling");
});
it("removes a cached association when background validation confirms it was unlinked", async () => {
  threadPullCache.set("thread-one", { repo: "acme/widgets", number: 42 });
  const slot = mount("thread-one", false);
  await waitFor(() => expect(threadPullCache.get("thread-one")).toBeNull());
  expect(slot.queryByRole("complementary")).toBeNull();
});
it("keeps the cached summary when background validation fails", async () => {
  threadPullCache.set("thread-one", { repo: "acme/widgets", number: 42 });
  const slot = mount("thread-one", true, {
    pullForThread: () => Promise.reject(new Error("offline")),
  });
  await slot.findByText("Improve scheduling");
});

it("restores a recent association after a frontend plugin reload", () => {
  createThreadPullCache().set("thread-one", {
    repo: "acme/widgets",
    number: 42,
  });
  expect(createThreadPullCache().get("thread-one")).toEqual({
    repo: "acme/widgets",
    number: 42,
  });
  expect(createThreadPullCache().get("thread-two")).toBeNull();
});
it("expires stored associations instead of keeping them indefinitely", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    createThreadPullCache().set("thread-one", {
      repo: "acme/widgets",
      number: 42,
    });
    clock.mockReturnValue(1_000_000 + 5 * 60_000);
    expect(createThreadPullCache().get("thread-one")).toBeNull();
  } finally {
    clock.mockRestore();
  }
});
